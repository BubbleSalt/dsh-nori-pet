/**
 * @bubblesalt/dsh-nori-pet — Nori 桌宠宿主（hybrid：host + web UI 面板）
 *
 * 职责：
 *  1. 观察 dsh 实时输出（agent/assistant-stream 正文块 + session/event 的 turn 生命周期），
 *     把助手输出按句切分；一段连续输出超长时改为整轮概括（见 lockSummaryBand）；
 *  2. WebSocket（PREFIX + /ws）推送给桌宠面板（含 session 归属）；
 *  3. POST PREFIX/api/speak 代理到本地 GPT-SoVITS（默认 http://127.0.0.1:9880），返回 WAV；
 *  4. PREFIX/assets/* 静态服务 Nori Live2D 模型文件（Nori_web/）与 live2dcubismcore.js。
 */
import type { Context } from 'cordis'
import { createReadStream, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, dirname, normalize, extname, resolve, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { buildRuntimeTtsConfig } from './modelPreset.js'
import { Config, CONFIG_DESCRIPTIONS } from './config.js'
import { appendFatal, createLogs } from './logs.js'
import { errMsg, hashText } from './util.js'
import { createSpeakHandler } from './tts.js'
import { mergeModelMap, modelGaps } from './modelMap.js'
import { createConfigStore } from './configStore.js'
import { createReframe } from './reframe.js'
import { createPipeline } from './pipeline.js'
import { installEvents } from './events.js'
import { loadPersona, resolvePersonaPaths } from './prompt.js'
import { PREFIX } from './protocol.js'
import { acceptKey, encodeFrame, parseFrame } from './ws.js'
import type { ParsedFrame } from './ws.js'

// 宿主以 ESM 方式被 loader import（无 __dirname），用 import.meta.url 推导包目录
const HOST_DIR = fileURLToPath(new URL('.', import.meta.url))

export const name = '@bubblesalt/dsh-nori-pet'
export const inject = ['webServer', 'llm', 'credentials', 'sessions']

// 配置 schema 与类型住在 config.ts（唯一真相，类型由 schema 派生）：此处原样再导出，
// 保持插件入口的对外 API 不变（dsh loader 按 `Config` 导出名读 schema）。
export { Config } from './config.js'


/**
 * 概括模式追加规则（接在 persona 之后）。设计约束来自实测需求：
 *  - 长度自适应：短内容 1 句，长内容最多 4 句 / 150 字（一次说到位，不啰嗦）
 *  - 事实优先：文件名/路径/数字/命令/结论/待确认项必须保留；中间过程与重复叙述可以丢
 *  - 不复述开头：超长内容的前段可能已经逐句播过，概括若复述开头会让人听两遍
 *  - 严禁编造：不确定就说"细节在屏幕上"，绝不把猜测说成事实
 */

/** 本地 Origin 主机白名单（WS / API 跨站防护；自定义访问来源用配置 allowedOrigins 扩展） */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']) // IPv6 只可能是带方括号的 '[::1]'（URL.hostname 实测）

type AppContext = Context & {
  llm: any
  webServer: {
    register(opts: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
    registerUpgrade(opts: { path: string; handler: (req: IncomingMessage, socket: Socket, head: Buffer) => void }): () => void
    tapIndex(transform: (html: string) => string): () => void
  }
}

interface PetClient {
  sessionId: string | null
  send(obj: unknown): void
  close(): void
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p: any) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('')
  }
  return ''
}

export function apply(ctx: AppContext, config: Config) {
  try {
    applyInner(ctx, config)
  } catch (e) {
    appendFatal(e) // apply 失败时插件作用域可能还没建起来：自带目录创建与上限裁剪
    throw e
  }
}

function applyInner(ctx: AppContext, config: Config) {
  if (!config.enabled) return
  // 人设资产（persona/ 或配置覆盖）；缺失 → 改写层降级为原文朗读（启动即判定，进程内只读一次）
  const persona = loadPersona(dirname(HOST_DIR), { personaPrompt: config.personaPrompt, personaReframe: config.personaReframe, personaSummary: config.personaSummary })
  // 改写任务指令的路径（persona/reframe.txt）：每次改写请求热读一次，改风格无需重载插件
  const personaPaths = resolvePersonaPaths(dirname(HOST_DIR), { personaPrompt: config.personaPrompt, personaReframe: config.personaReframe, personaSummary: config.personaSummary })
  if (!persona) log('[dsh-nori-pet] persona 人设文件缺失（persona/prompt.txt 或 persona/reframe.txt），改写层关闭：直接朗读原始输出')
  const clients = new Set<PetClient>()
  // 宿主侧（传输层）状态：WS 握手计数 + 最近一条广播/发送帧（都只给 /api/status 取证用）
  let lastBroadcast = ''
  let lastSendFrame = ''
  let statHello = 0
  let statAck = 0
  /**
   * 取证环：最近 10 次送进合成的文本（前端每段气泡各发一次 /api/speak）。
   * 用途：判断"切分发生在哪一层"——若一次气泡的内容被拆成两条请求，就是**客户端**切的；
   * 若只有一条完整请求却看见两个气泡，则是**宿主广播**粒度造成的。排障时看 /api/status。
   */
  const recentSpeaks: Array<{ ts: number; len: number; head: string; budget?: number; units?: number; lines?: number; dropped?: number }> = []
  function noteSpeak(text: string, budget?: number, units?: number, lines?: number, dropped?: number): void {
    recentSpeaks.push({ ts: Date.now(), len: text.length, head: text.slice(0, 40), budget, units, lines, dropped })
    if (recentSpeaks.length > 10) recentSpeaks.shift()
  }
  function log(...args: unknown[]): void {
    const logger: any = (ctx as any).logger
    if (logger && typeof logger.info === 'function') logger.info(...args)
    else console.log(...args)
  }

  // 取证：带文本的最近广播 hash 环形缓冲（定位"一段对话读两次"用）
  const recentBroadcasts: Array<{ ts: number; type: string; h: string; turn?: number; len: number }> = []
  function broadcast(obj: unknown): void {
    const msg = JSON.stringify(obj)
    lastBroadcast = Date.now() + '|' + msg.slice(0, 120)
    const o = obj as any
    if (o && typeof o.text === 'string') {
      const s = o.text as string
      recentBroadcasts.push({ ts: Date.now(), type: String(o.type ?? ''), h: hashText(s), turn: typeof o.turn === 'number' ? o.turn : undefined, len: s.length })
      if (recentBroadcasts.length > 20) recentBroadcasts.shift()
    }
    for (const c of clients) {
      // 会话维度过滤：已通过 hello 绑定 sessionId 的客户端只收该会话事件；未绑定（sessionId 空）收全部
      if (c.sessionId && typeof o.session === 'string' && o.session !== c.sessionId) continue
      try { c.send(msg) } catch { /* 单客户端失败忽略 */ }
    }
  }


  // 日志（trace / summary / error + 字节上限 + 目录预算）在 src/logs.ts：这里只注入 logger
  const logs = createLogs({ log })
  logs.init()

  // ─── Nori 人设改写层（LLM 改写/概括 + 串行队列 + 投递去重；实现在 src/reframe.ts）───
  let pipelineRef: { summaryCharsOf: (turn: number) => number } | null = null
  const reframe = createReframe({
    config,
    logs,
    log,
    repoRoot: dirname(HOST_DIR),
    persona,
    personaPaths,
    credentials: (ctx as any).credentials,
    llm: (ctx as any).llm,
    broadcast,
    onAssistant: (out) => { stats.assistant += 1; stats.lastAssistant = out.slice(0, 60) },
    summaryCharsOf: (turn) => pipelineRef?.summaryCharsOf(turn) ?? 0,
  })

  // ─── 播报管线（状态机）与事件订阅：实现在 src/pipeline.ts / src/events.ts ───
  const pipeline = createPipeline({ config, logs, log, broadcast, reframe, extractText })
  const { stats } = pipeline
  pipelineRef = pipeline
  installEvents(ctx, { onAgentFrame: pipeline.handleAgentFrame, onSessionEvent: pipeline.handleSessionEvent, stats })




  // ─── 会话事件观察 ──

  // ─── TTS 代理：POST { text, budget, units, lines } → WAV（实现在 src/tts.ts） ──
  const handleSpeak = createSpeakHandler({
    config,
    repoRoot: dirname(HOST_DIR),
    isTrusted: isTrustedRequest,
    noteSpeak,
    appendErr: (line) => logs.appendErr(line),
    resolveConfigPath,
  })

  // ─── 静态资源：Nori Live2D 模型 + core ─────────────────────────
  const MIME: Record<string, string> = {
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.moc3': 'application/octet-stream',
    '.js': 'text/javascript',
    '.txt': 'text/plain',
  }

  // ─── 资产路径解析（配置外置化）：assetsDir/coreFile 留空时自动探测仓库内
  //      Nori_web / cubism_sdk（HOST_DIR = <repo>/lib/，上一级即仓库根 = 资产约定的位置）；
  //      均不存在返回空（404）。相对路径统一以仓库根（HOST_DIR 的上一级 = 包目录）为基准解析，
  //      发布后克隆仓库（含空白占位目录）并把资产放进对应目录即可工作。
  function resolveConfigPath(v: string): string {
    if (!v) return ''
    if (isAbsolute(v)) return v
    return resolve(dirname(HOST_DIR), v)
  }
  function resolveAssetsDir(): string {
    if (config.assetsDir) return resolveConfigPath(config.assetsDir)
    const probe = join(dirname(HOST_DIR), 'Nori_web')
    return existsSync(probe) ? probe : ''
  }
  function resolveCoreFile(): string {
    if (config.coreFile) return resolveConfigPath(config.coreFile)
    const probe = join(dirname(HOST_DIR), 'cubism_sdk', 'Core', 'live2dcubismcore.js')
    return existsSync(probe) ? probe : ''
  }

  async function handleAssets(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let rel: string
    try { rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) } catch { // 非法百分号转义 → 400（不是资产路径）
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad request' }))
      return
    }
    if (rel.startsWith('/')) rel = rel.slice(1)
    const norm = normalize(rel).replace(/\\/g, '/')
    if (norm.startsWith('../') || norm.startsWith('/') || norm === '..') {
      res.writeHead(403); res.end('forbidden'); return
    }
    let file: string
    let mime = MIME[extname(norm).toLowerCase()] ?? 'application/octet-stream'
    if (norm === 'assets/core/live2dcubismcore.js') {
      file = resolveCoreFile()
      mime = 'text/javascript'
    } else if (norm.startsWith('assets/')) {
      const dir = resolveAssetsDir()
      // 资产目录缺失必须直接 404：join('', sub) 会落成"相对 CWD"的路径，
      // 于是 /assets/package.json 之类会以宿主工作目录为根被找到并当资产返回（越界读取）。
      if (!dir) { res.writeHead(404); res.end('not found'); return }
      file = join(dir, norm.slice('assets/'.length))
    } else {
      res.writeHead(404); res.end('not found'); return
    }
    if (!file) { res.writeHead(404); res.end('not found'); return } // coreFile 未配置/未找到
    try {
      const st = await stat(file)
      if (!st.isFile()) { res.writeHead(404); res.end('not found'); return }
      // stat→open 之间文件被删/权限变化会让流异步 emit 'error'；无监听者 → uncaughtException 打死宿主
      const rs = createReadStream(file)
      rs.on('error', (e: any) => {
        logs.appendErr('[nori-pet] assets read error ' + file + ': ' + errMsg(e))
        if (!res.headersSent) { try { res.writeHead(404); res.end('not found') } catch { /* ignore */ } }
        else try { res.destroy() } catch { /* ignore */ }
      })
      res.writeHead(200, { 'content-type': mime, 'content-length': st.size, 'cache-control': 'no-cache' })
      rs.pipe(res)
    } catch { // 资产缺失/读失败 → 404：静态文件缺失不该变成 500
      res.writeHead(404); res.end('not found')
    }
  }

  // ─── 请求来源校验（跨站 WebSocket Hijacking / 跨站 GET/POST 触发防护） ────
  // 浏览器跨站请求必带 Origin / Sec-Fetch-Site；本地页面 Origin 为 http://localhost:PORT 或 http://127.0.0.1:PORT。
  // 无 Origin 的非浏览器本地客户端（curl/node/dsh 内部）放行——本地进程本就不受浏览器同源约束。
  function isTrustedRequest(req: IncomingMessage): boolean {
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site === 'cross-site') return false
    const origin = req.headers['origin']
    if (typeof origin === 'string' && origin) {
      if (origin === 'null') return false
      try {
        const host = new URL(origin).hostname
        if (LOCAL_HOSTS.has(host)) return true
        return config.allowedOrigins.includes(host)
      } catch { return false } // Origin 不是合法 URL → 视为不可信
    }
    return true
  }

  // ─── WebSocket upgrade ─────────────────────────────────────────
  function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (!isTrustedRequest(req)) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n') } catch { /* ignore */ }
      socket.destroy()
      return
    }
    // RFC6455 握手头校验：只认 Sec-WebSocket-Key 是不够的——任何普通 GET（被中间件/
    // 宿主转发进来的 HTTP 请求）只要带了该头就会被升格成 WS 连接，然后以"半开 socket"
    // 常驻 clients 列表。必须同时要求 Upgrade: websocket 且 Connection 含 upgrade。
    const upgradeHdr = String(req.headers.upgrade ?? '').toLowerCase()
    const connHdr = String(req.headers.connection ?? '').toLowerCase()
    if (upgradeHdr !== 'websocket' || !connHdr.includes('upgrade')) {
      try { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') } catch { /* ignore */ }
      socket.destroy()
      return
    }
    const key = (req.headers['sec-websocket-key'] as string) || ''
    if (!key) { socket.destroy(); return }
    const accept = acceptKey(key)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    if (head.length) socket.unshift(head)

    const client: PetClient = { sessionId: null, send: () => undefined, close: () => undefined }
    let buffer = Buffer.alloc(0)
    let fragParts: Buffer[] = []

    client.send = (obj: unknown) => {
      // broadcast() 传入的已是 JSON 字符串，不能二次 stringify（否则浏览器 parse 出字符串而非对象）
      const msg = typeof obj === 'string' ? obj : JSON.stringify(obj)
      lastSendFrame = msg.slice(0, 120)
      try { socket.write(encodeFrame(msg)) } catch { /* ignore */ }
    }
    client.close = () => { try { socket.write(encodeFrame(Buffer.alloc(0), 8) as any); socket.end() } catch { socket.destroy() } } // 关闭帧写失败就硬断开：这条连接本来就要丢

    function onFrame(frame: ParsedFrame): void {
      if (frame.opcode === 0x9) { // ping → pong
        try { socket.write(encodeFrame(frame.payload, 0xa)) } catch { /* ignore */ }
        return
      }
      if (frame.opcode === 0x8) { clients.delete(client); socket.end(); return }
      // 文本消息（0x1）/续帧（0x0）：按 fin 标志累积，直到整条消息收齐才解析。
      // 旧版不看 fin——每条帧都当场 JSON.parse 后清空，分片消息会被截断丢弃（浏览器发大消息就会）。
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        if (frame.opcode === 0x1) fragParts = [] // 新消息从干净的累积器开始
        fragParts.push(frame.payload)
        if (!frame.fin) return
        const text = Buffer.concat(fragParts).toString('utf8')
        fragParts = []
        try {
          const msg = JSON.parse(text)
          if (msg && msg.type === 'hello' && typeof msg.sessionId === 'string') { client.sessionId = msg.sessionId; statHello += 1 }
          if (msg && msg.type === 'ack') statAck += 1
        } catch { /* 非 JSON 忽略 */ }
      }
    }

    socket.on('data', (d: Buffer) => {
      buffer = Buffer.concat([buffer, d])
      for (;;) {
        const frame = parseFrame(buffer)
        if (!frame) break
        buffer = buffer.subarray(frame.consumed)
        try { onFrame(frame) } catch { /* ignore */ }
      }
    })
    socket.on('error', () => clients.delete(client))
    socket.on('close', () => clients.delete(client))
    clients.add(client)
    try {
      client.send({ type: 'hello', prefix: PREFIX, tts: config.ttsUrl, model: 'Nori', version: 1 })
    } catch { /* ignore */ }
  }

  // ─── API 路由 ──────────────────────────────────────────────────
  async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden' }))
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(PREFIX.length)
    // ─── 配置 UI 后端：读/写 nori.config.json（字段见 src/configStore.ts 的白名单） ───
    if (path === '/api/config') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        // 配置文件只含用户写过的键；把插件 Config（已带默认值）并进来，
        // 界面才能看到**全部**可配项，而不是只有手动写过的那几个。
        const snap = configStore.snapshot()
        snap.config = { ...(config as unknown as Record<string, unknown>), ...snap.config }
        // 任何 apiKey 形态的字段都脱敏（只留是否已配置）
        for (const [k, v] of Object.entries(snap.config)) {
          if (typeof v === 'object' && v !== null) {
            const o = { ...(v as Record<string, unknown>) }
            if ('apiKey' in o) o.apiKey = null
            snap.config[k] = o
          }
        }
        res.end(JSON.stringify(snap))
        return
      }
      if (req.method === 'POST') {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += (chunk as Buffer).length
          if (size > 256 * 1024) { res.writeHead(413); res.end('payload too large'); return }
          chunks.push(chunk as Buffer)
        }
        let patch: Record<string, unknown>
        try {
          patch = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('需要 JSON 对象')
        } catch (err) {
          // 请求体坏了：以 400 明确告知调用方，不落盘
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, errors: ['请求体不是合法 JSON：' + String(err)] }))
          return
        }
        // 校验：交给 zod Schema（与启动时同一套规则），失败不落盘
        const result = configStore.apply(patch, validateConfigShape)
        // 绝不记录请求体：里面可能含 apiKey。只记结果与键名级别的错误说明
        log('[dsh-nori-pet] config POST ' + (result.ok ? 'ok' : 'rejected: ' + (result.errors ?? []).join('; ')))
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }
      res.writeHead(405); res.end('method not allowed'); return
    }

    // ─── 配置 schema：界面据此生成表单（唯一真相是 config.ts，不手写字段清单） ───
    if (path === '/api/config/schema' && req.method === 'GET') {
      type Node = { type?: string; meta?: { default?: unknown }; dict?: Record<string, Node> }
      const walk = (node: Node, prefix: string, out: Array<{ path: string; type: string; default: unknown }>): void => {
        if (node?.type === 'object' && node.dict) {
          for (const [k, child] of Object.entries(node.dict)) walk(child, prefix ? prefix + '.' + k : k, out)
          return
        }
        out.push({ path: prefix, type: String(node?.type ?? 'any'), default: node?.meta?.default })
      }
      const fields: Array<{ path: string; type: string; default: unknown }> = []
      walk(Config as unknown as Node, '', fields)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      // 每项附说明：优先用 CONFIG_DESCRIPTIONS（config.ts 内维护），否则取 schema 的 meta.description
      const withDesc = fields.map((f) => ({
        ...f,
        description: CONFIG_DESCRIPTIONS[f.path] ?? (f as { description?: string }).description ?? '',
      }))
      res.end(JSON.stringify({ fields: withDesc }))
      return
    }

    // ─── 模型探测：列出表达式/动作组，并给出契约草稿（UI 的「自动识别」按钮） ───
    if (path === '/api/model/probe' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      let body: { file?: unknown }
      // 请求体为空或非 JSON 时按空对象处理：后面统一走"缺少 file"的 400 分支
      // 解析失败属于预期路径（空体/坏 JSON），落到下面"缺少 file"的 400 分支
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { file?: unknown } } catch { /* 见上行：交给缺少 file 的分支 */ body = {} }
      const file = typeof body.file === 'string' ? body.file.trim() : ''
      if (!file) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '缺少 file' })); return }
      // 路径安全：只允许仓库内相对路径（绝对路径放行但要存在），拒绝 .. 逃逸
      const abs = isAbsolute(file) ? file : resolve(dirname(HOST_DIR), file)
      const root = resolve(dirname(HOST_DIR))
      if (!isAbsolute(file) && !resolve(abs).startsWith(root + sep) && resolve(abs) !== root) {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '路径越界' })); return
      }
      try {
        const spec = JSON.parse(readFileSync(abs, 'utf8')) as {
          FileReferences?: { Expressions?: Array<{ Name?: string; File?: string }>; Motions?: Record<string, unknown> }
          Groups?: Array<{ Name?: string; Ids?: string[] }>
        }
        const expressions = (spec.FileReferences?.Expressions ?? [])
          .map((e) => String(e?.Name ?? ''))
          .filter(Boolean)
        const motionGroups: Record<string, number> = {}
        for (const [g, list] of Object.entries(spec.FileReferences?.Motions ?? {})) {
          motionGroups[g] = Array.isArray(list) ? list.length : 0
        }
        const lipSync = (spec.Groups ?? []).find((g) => String(g?.Name ?? '').toLowerCase() === 'lipsync')
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          ok: true,
          file,
          expressions,
          motionGroups,
          lipSyncId: lipSync?.Ids?.[0] ?? null,
        }))
      } catch (err) {
        // 模型文件读不了（不存在/JSON 坏）：以 400 回给界面显示，不是静默忽略
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: '读不了这个模型文件：' + String(err) }))
      }
      return
    }

    // 模型契约：前端据此决定模型路径/口型参数/情绪映射（换模型不用重编译 widget）
    if (path === '/api/model-map' && req.method === 'GET') {
      // 模型契约属于**运行时配置**（nori.config.json 的 model 段，热读），不是 dsh 插件 Config：
      // 用户改配置不需要重装/改 patch；nori.config.json 优先于插件 Config 里的同名段。
      let fileModel: unknown = {}
      try { fileModel = JSON.parse(readFileSync(join(dirname(HOST_DIR), 'nori.config.json'), 'utf8')).model ?? {} } catch { /* 无配置文件 → 用插件 Config */ }
      const map = mergeModelMap({ ...(config.model as object), ...(fileModel as object) })
      // 字段名与 nori.config.json 的 model 段完全一致（file 而非 modelPath）——
      // 同一个东西两个名字，正是这次「接口返回 Haru、页面还是 Nori」的根因。
      const body = JSON.stringify({
        file: map.modelPath,
        mouthParam: map.mouthParam,
        idleGroup: map.idleGroup,
        emotions: map.emotions,
        gaps: modelGaps(map),
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
      return
    }
    if (path === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, tts: config.ttsUrl, model: 'Nori', prefix: PREFIX, ws: clients.size, events: stats.events, chunks: stats.chunks, textDelta: stats.textDelta, dupFeed: stats.dupFeed, assistant: stats.assistant, turnEnd: stats.turnEnd, hello: statHello, ack: statAck, lastAssistant: stats.lastAssistant, last: lastBroadcast, sent: lastSendFrame, recentBroadcasts, recentSpeaks }))
      return
    }
    if (path === '/api/ws-test' && req.method === 'GET') {
      const text = url.searchParams.get('text') || '你好，我是 Nori。这是测试。'
      broadcast({ type: 'assistant', session: 'test', text })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, sent: text, ws: clients.size }))
      return
    }
    if (path === '/api/emote' && req.method === 'GET') {
      // 情绪联动手动测试：?e=happy|excited|angry|sad|doubt|troubled|shy|surprised|dizzy|serious|speechless|think|default&text=可选播报
      const e = String(url.searchParams.get('e') || 'default')
      const text = String(url.searchParams.get('text') || '')
      broadcast({ type: 'emote', e, text })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, e, text, ws: clients.size }))
      return
    }
    if (path === '/api/speak' && req.method === 'POST') {
      await handleSpeak(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  // ─── widget 注入（whale 插件同款机制：普通 <script>，不走 client-modules） ──
  /**
 * 写配置前的最小校验：只查"类型错/明显越界"，不做业务规则。
 * 为什么不用 Config.parse：本仓库的 zod 由 cordis 包装，类型上只有 Schema 没有 parse/safeParse，
 * 拿不到真正的校验器；而 UI 侧改的是同一批键，类型挡一下足够，越界值交给运行时（有默认值与兜底）。
 */
function validateConfigShape(merged: Record<string, unknown>): string[] {
  const errs: string[] = []
  const num = (k: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const v = merged[k]
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${k}: 需要数字`)
    else if (v < min || v > max) errs.push(`${k}: 需要在 ${min}~${max} 之间`)
  }
  const str = (k: string) => {
    const v = merged[k]
    if (v === undefined) return
    if (typeof v !== 'string') errs.push(`${k}: 需要字符串`)
  }
  num('maxSentence', 1, 500)
  num('volume', 0, 1)
  num('rate', 0.25, 4)
  num('scale', 0.3, 3)
  num('ttsTemperature', 0, 2)
  num('ttsTopK', 1, 100)
  str('ttsUrl'); str('refAudio'); str('refPrompt'); str('assetsDir'); str('modelDir')
  const model = merged.model
  if (model !== undefined && (typeof model !== 'object' || model === null || Array.isArray(model))) {
    errs.push('model: 需要对象')
  }
  return errs
}

const configStore = createConfigStore(join(dirname(HOST_DIR), 'nori.config.json'), (m) => log('[dsh-nori-pet] ' + m))
const WIDGET_PATH = join(HOST_DIR, 'widget.js')
  let widgetJs = ''
  /* 见下方 readWidget()：按需读取，避免整个进程复用旧 bundle */
  // 版本戳 = widget.js 的 mtime：每次重建后 URL 变化，浏览器不会拿旧缓存里的 bundle
  // （否则改了前端还得靠"硬刷 Ctrl+F5"，实测踩过好几次：改了代码、页面还在跑上一版）
  let widgetStamp = '0'
// 不能在这里就填当前 mtime：readWidget 会以为"没变过"而永不读盘（实测 → 返回空 bundle 200）
  function readWidget(): string {
  try {
    const stamp = String(Math.round(statSync(WIDGET_PATH).mtimeMs))
    if (stamp !== widgetStamp) {
      widgetJs = readFileSync(WIDGET_PATH, 'utf8')
      widgetStamp = stamp
    }
  } catch (e) {
    if (!widgetJs) log('[dsh-nori-pet] widget.js missing: ' + WIDGET_PATH + ' ' + String(e))
  }
  return widgetJs
}
// 之前 widgetJs 是 apply() 时读一次、进程复用，版本戳也只在启动时算 —— rebuild 之后
// 路由一直发旧 bundle（实测磁盘 2047172、服务端 2034497，页面怎么刷都是上一版）。
// 现在按 mtime 失效：重建后刷页面即新代码，不必重载插件。
const widgetTag = (): string => {
  readWidget()
  return '<script defer src="' + PREFIX + '/widget.js?v=' + widgetStamp + '"></script>'
}

  // ─── api_v2 守护：定时探测 9880，掉了自动拉起（tts_infer.yaml 已指向新权重，重启即新声线） ──
  // 判活原则：只要能拿到 HTTP 响应（含 4xx/5xx）就说明服务活着——api_v2 缺 ref_audio_path 时
  // 稳定返回 500，旧逻辑用 `status < 500` 判活会把"活着的服务"判成掉线，于是每个周期都重新
  // 生成 runtime 配置并拉起一个秒退的重型进程（实测 mtime 每 10~46s 被重写）。
  // 另加两道闩：in-flight（探测自身不重入）+ spawn 宽限（冷启动要几十秒，给足时间再判死）。
  const SPAWN_GRACE_MS = 120000
  let ttsProbeInFlight = false
  let nextSpawnAllowedAt = 0
  const spawnWaitUntil = new Map<{ pid?: number }, number>()
  let ttsWatchTimer: ReturnType<typeof setInterval> | null = null
  if (config.ttsWatch) {
    // GPT-SoVITS 位置：显式配置 gsvBase（相对仓库根或绝对）→ 否则探测仓库内 GPT-SoVITS
    let GSV_BASE = resolveConfigPath(config.gsvBase)
    if (!GSV_BASE) {
      const cand = join(dirname(HOST_DIR), 'GPT-SoVITS')
      if (existsSync(join(cand, 'api_v2.py'))) GSV_BASE = cand
    }
    let VENV_PY = resolveConfigPath(config.venvPy)
    if (!VENV_PY && GSV_BASE) {
      const v = join(GSV_BASE, '.venv', 'Scripts', 'python.exe')
      if (existsSync(v)) VENV_PY = v
    }
    if (GSV_BASE && !existsSync(join(GSV_BASE, 'api_v2.py'))) {
      log('[dsh-nori-pet] api_v2 watchdog: gsvBase 下没有 api_v2.py，禁用拉起：' + GSV_BASE)
      GSV_BASE = ''
    }
    if (VENV_PY && !existsSync(VENV_PY)) {
      log('[dsh-nori-pet] api_v2 watchdog: venvPy 不存在，禁用拉起：' + VENV_PY)
      VENV_PY = ''
    }
    if (GSV_BASE && VENV_PY) log('[dsh-nori-pet] api_v2 watchdog ready: ' + GSV_BASE)
    else log('[dsh-nori-pet] api_v2 watchdog: GPT-SoVITS not found (set gsvBase/venvPy or place in repo); respawn disabled')
    // 探测地址跟随 ttsUrl（旧版硬编码 9880，自定义端口会对着错误端口探测/拉起）
    let probeUrl = 'http://127.0.0.1:9880/tts?text=%E6%B5%8B&media_type=wav'
    // 拉起时用的 host/port 也跟随 ttsUrl。旧版只让**探测**跟随、拉起仍写死 `-p 9880`：
    // 自定义端口（比如 9881）会"探测 9881 失败 → 在 9880 拉起 → 再探测 9881 仍失败"，
    // 于是每 10~46s 拉一个秒退的重型进程，既起不来也不报错。
    let spawnHost = '127.0.0.1'
    let spawnPort = '9880'
    let spawnLocal = true // ttsUrl 指向远程机器时不该在本机拉起
    try {
      const pu = new URL(config.ttsUrl)
      pu.searchParams.set('text', '测')
      pu.searchParams.set('media_type', 'wav')
      probeUrl = pu.toString()
      // hostname 拿去比对前先还原成不带方括号的形式（URL 里 IPv6 是 '[::1]'）
      spawnLocal = LOCAL_HOSTS.has(pu.hostname) || pu.hostname === '[::1]'
      spawnHost = spawnLocal ? pu.hostname.replace(/^\[|\]$/g, '') : '127.0.0.1'
      spawnPort = pu.port || (pu.protocol === 'https:' ? '443' : '80')
    } catch { log('[dsh-nori-pet] ttsUrl 非法，watchdog 探测退回默认 9880：' + config.ttsUrl) }
    // numba 缓存与 ffmpeg：仓库内（audio/、ffmpeg/）或环境变量，避免写死机器路径
    const numbaCache = process.env.NUMBA_CACHE_DIR || join(dirname(HOST_DIR), 'audio', 'numba_cache')
    const ffmpegBin = process.env.FFMPEG_BIN_DIR || (existsSync(join(dirname(HOST_DIR), 'ffmpeg', 'bin')) ? join(dirname(HOST_DIR), 'ffmpeg', 'bin') : '')
    ttsWatchTimer = setInterval(async () => {
      if (ttsProbeInFlight) return // 上一轮探测未回（或正在拉起），本轮跳过，防重入叠加
      ttsProbeInFlight = true
      try {
        let alive = false
        try {
          const probe = await fetch(probeUrl, { signal: AbortSignal.timeout(10000) })
          alive = true // 拿到任何 HTTP 响应（含 4xx/5xx）= 服务在跑
          try { await probe.body?.cancel() } catch { /* 探测响应体不消费：主动取消，避免连接滞留 */ }
        } catch { /* 网络错误/超时 → 判定需要拉起 */ }
        if (alive) { nextSpawnAllowedAt = 0; return }
        if (!GSV_BASE || !VENV_PY) return
        // ttsUrl 指向远程机器：本地拉起没有意义（拉了也不会被探测到），只探测不拉起
        if (!spawnLocal) return
        // 刚拉起的进程仍在冷启动（模型加载要几十秒）→ 不要重复拉起
        const now = Date.now()
        for (const [child, until] of spawnWaitUntil) if (until <= now) spawnWaitUntil.delete(child)
        if (spawnWaitUntil.size > 0) return
        if (now < nextSpawnAllowedAt) return
        // 用户通过 nori.config.json sovits 段指定推理权重（t2sWeights/vitsWeights）→ 生成运行时
        // custom 配置，不覆盖原 tts_infer.yaml（custom 块永远保留）；未配置权重则用原配置
        let ttsCfgArg = 'GPT_SoVITS/configs/tts_infer.yaml'
        try {
          const nc = JSON.parse(readFileSync(join(dirname(HOST_DIR), 'nori.config.json'), 'utf8'))
          const sovits = (nc as any)?.sovits ?? {}
          const t2s = String(sovits.t2sWeights ?? '').trim()
          const vits = String(sovits.vitsWeights ?? '').trim()
          if (t2s || vits) {
            const srcYaml = join(GSV_BASE, 'GPT_SoVITS', 'configs', 'tts_infer.yaml')
            if (existsSync(srcYaml)) {
              const { out, result } = buildRuntimeTtsConfig(readFileSync(srcYaml, 'utf8'), {
                t2sWeights: t2s ? resolveConfigPath(t2s) : '',
                vitsWeights: vits ? resolveConfigPath(vits) : '',
              })
              if (result.ok && result.changed && out) {
                const rt = join(GSV_BASE, 'GPT_SoVITS', 'configs', 'tts_infer.runtime.yaml')
                writeFileSync(rt, out, 'utf8')
                ttsCfgArg = rt
                log('[dsh-nori-pet] tts model preset: ' + result.message + ' -> ' + rt)
              } else if (!result.ok) log('[dsh-nori-pet] tts model preset: ' + result.message)
            }
          }
        } catch (e) { log('[dsh-nori-pet] tts model preset 读取配置失败: ' + errMsg(e)) }
        try {
          const { spawn } = await import('node:child_process')
          const child = spawn(VENV_PY, ['api_v2.py', '-a', spawnHost, '-p', spawnPort, '-c', ttsCfgArg], {
            cwd: GSV_BASE,
            stdio: 'ignore',
            detached: false,
            env: {
              ...process.env,
              PYTHONUTF8: '1',
              PYTHONIOENCODING: 'utf-8',
              NUMBA_CACHE_DIR: numbaCache,
              PATH: (ffmpegBin ? ffmpegBin + ';' : '') + (process.env.PATH ?? ''),
            },
          })
          // spawn 对不存在/不可执行的路径不会同步抛错，而是异步 emit 'error'（ENOENT 等）；
          // 无监听者 → uncaughtException → fail-loud 打死宿主。故 error/exit 必须监听。
          spawnWaitUntil.set(child, Date.now() + SPAWN_GRACE_MS)
          child.on('error', (e: any) => {
            spawnWaitUntil.delete(child)
            log('[dsh-nori-pet] api_v2 spawn error: ' + errMsg(e) + '（路径或权限有问题：VENV_PY=' + VENV_PY + '）')
          })
          child.on('exit', (code) => {
            spawnWaitUntil.delete(child)
            if (code !== 0) log('[dsh-nori-pet] api_v2 exited code=' + code + '（若端口被占用或权重缺失会秒退，下次探测才会重试）')
          })
          log('[dsh-nori-pet] api_v2 watchdog: spawning pid=' + (child.pid ?? '?') + ' (' + spawnHost + ':' + spawnPort + ' was down)')
          nextSpawnAllowedAt = Date.now() + SPAWN_GRACE_MS
        } catch (e) {
          log('[dsh-nori-pet] api_v2 watchdog spawn failed: ' + String(e))
        }
        } finally {
        ttsProbeInFlight = false // 探测/拉起整段结束才允许下一轮
      }
    }, config.ttsWatchIntervalMs)
  }

  // ─── 注册（webServer 服务） ─────────────────────────────────────
  // prefix /api 同时覆盖 /api 与 /api/*（exact + prefix 同路径会碰撞）
  // 宿主是 fail-loud：handler 返回的 Promise 一旦 reject，unhandledRejection 会 process.exit(1)
  // 打死整台 dsh。故所有 async handler 必须在此兜底（配置写错、客户端中断都不许冒泡到进程级）。
  function safeHandler(fn: (req: IncomingMessage, res: ServerResponse) => Promise<void>, tag: string) {
    return (req: IncomingMessage, res: ServerResponse): void => {
      void fn(req, res).catch((e: any) => {
        const where = req.method + ' ' + req.url
        logs.appendErr('[nori-pet] ' + tag + ' handler error @ ' + where + ': ' + String(e?.stack ?? e).slice(0, 400))
        log('[dsh-nori-pet] ' + tag + ' handler error @ ' + where + ': ' + errMsg(e))
        try {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal error' }))
        } catch { /* 响应已关闭：忽略 */ }
      })
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX + '/api', handler: safeHandler(handleApi, 'api') }), 'nori-pet-api')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX + '/assets', handler: safeHandler(handleAssets, 'assets') }), 'nori-pet-assets')
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: PREFIX + '/ws', handler: handleUpgrade }), 'nori-pet-ws')
  ctx.effect(() => () => { for (const c of clients) { try { c.close() } catch { /* ignore */ } } clients.clear() }, 'nori-pet-ws-cleanup')
  ctx.effect(() => () => { if (ttsWatchTimer) { try { clearInterval(ttsWatchTimer) } catch { /* ignore */ } ttsWatchTimer = null } }, 'nori-pet-tts-watch')
  /**
   * 关键：清掉本代所有待触发的播报定时器。
   *
   * 不清的后果（实测踩过）：热重载后旧代 fiber 的 setTimeout 回调仍会触发，带着**它那一代的
   * batchText/pending** 再走一遍 flushBatch → 同一段文字被投递第二次 → 同一段内容被改写、
   * 播报两遍（trace 里两条 IN 完全相同、指纹相同）。即"重复播报"的真凶是跨代遗留定时器。
   */
  ctx.effect(() => () => { pipeline.clearBroadcastTimers() }, 'nori-pet-broadcast-timers')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/widget.js',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(readWidget())
    },
  }), 'nori-pet-widget')
  ctx.effect(() => ctx.webServer.tapIndex((html: string) => {
    if (html.includes(PREFIX + '/widget.js')) return html
    if (html.includes('</body>')) return html.replace('</body>', widgetTag() + '</body>')
    return html + widgetTag()
  }), 'nori-pet-widget-tap')

  log('[dsh-nori-pet] host ready: tts=' + config.ttsUrl + ' assets=' + resolveAssetsDir() + ' core=' + resolveCoreFile())
}
