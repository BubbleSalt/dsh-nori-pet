/**
 * @dsh-external/dsh-nori-pet — Nori 桌宠宿主（hybrid：host + web UI 面板）
 *
 * 职责：
 *  1. 观察 dsh 会话事件流（session/event：assistant/chunk …），把助手输出按句切分；
 *  2. WebSocket（PREFIX + /ws）推送给桌宠面板（含 session 归属）；
 *  3. POST PREFIX/api/speak 代理到本地 GPT-SoVITS（默认 http://127.0.0.1:9880），返回 WAV；
 *  4. PREFIX/assets/* 静态服务 Nori Live2D 模型文件（Nori_web/）与 live2dcubismcore.js。
 */
import type { Context } from 'cordis'
import z from 'schemastery'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, dirname, normalize, extname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { homedir } from 'node:os'
import { loadPersona, type Persona } from './prompt.js'

// 宿主以 ESM 方式被 loader import（无 __dirname），用 import.meta.url 推导包目录
const HOST_DIR = fileURLToPath(new URL('.', import.meta.url))

export const name = '@dsh-external/dsh-nori-pet'
export const inject = ['webServer', 'llm', 'credentials', 'sessions']

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** Nori Live2D 模型目录（含 Nori.model3.json）；留空自动探测仓库内 Nori_web */
  assetsDir: z.string().default(''),
  /** live2dcubismcore.js 绝对路径；留空自动探测仓库内 cubism_sdk/Core */
  coreFile: z.string().default(''),
  /** 本地 GPT-SoVITS 服务地址（api_v2 的 /tts 端点） */
  ttsUrl: z.string().default('http://127.0.0.1:9880/tts'),
  /** 零样本参考音频（Nori 声线 wav，绝对路径；留空则用 GPT-SoVITS 服务端默认参考音色，声线资产不入仓库） */
  refAudio: z.string().default(''),
  /** 参考音频的转写文本（prompt text，与 refAudio 配套） */
  refPrompt: z.string().default('你好,初次见面,我的名字是Nori'),
  /** 单句推送的最大长度（超出强制截断） */
  maxSentence: z.number().default(140),
  /** TTS 推理参数（lowtemp：更稳更收敛，避免采样噪声导致电音感） */
  ttsTemperature: z.number().default(0.65),
  ttsTopK: z.number().default(5),
  ttsSpeedFactor: z.number().default(1.0),
  /** Nori 人设改写层：agent 输出先经 LLM 改写为 Nori 口吻再朗读 */
  reframe: z.boolean().default(true),
  /** 改写 LLM 的 provider（dsh-llm 注册名） */
  reframeProvider: z.string().default('deepseek-official'),
  /** 改写 LLM 的模型 */
  reframeModel: z.string().default('deepseek-chat'),
  /** 改写单次调用的超时（毫秒） */
  reframeTimeoutMs: z.number().default(15000),
  /** 改写输入的最大字符数（超出截断） */
  reframeMaxInput: z.number().default(1500),
  /**
   * Nori 专用 API key 的 credentials ref（如 DEEPSEEK_NORI_API_KEY）。
   * 设置后改写层直连 DeepSeek 官方 API（独立计量，不走主会话）；留空则走 dsh 内置 llm 服务。
   */
  reframeApiKeyRef: z.string().default('DEEPSEEK_NORI_API_KEY'),
  /** 专用 key 直连的 API 地址（OpenAI 兼容 /chat/completions） */
  reframeBaseUrl: z.string().default('https://api.deepseek.com/v1'),
  /** 改写层输入/输出追踪日志（定位"Nori 何时开始讲什么"排障用；写入 nori-pet-trace.log） */
  reframeTrace: z.boolean().default(true),
  /** api_v2 守护：定时探测 9880，掉了自动拉起（桌面朗读保底） */
  ttsWatch: z.boolean().default(true),
  /** 守护探测间隔（毫秒） */
  ttsWatchIntervalMs: z.number().default(30000),
  /**
   * GPT-SoVITS 安装根目录（api_v2.py 所在，守护拉起时作为 cwd）。
   * 留空自动探测仓库内 GPT-SoVITS；不在此处的机器用 -GsvBase 指定。
   */
  gsvBase: z.string().default(''),
  /** GPT-SoVITS venv 的 python 路径（守护拉起用）。留空默认 <gsvBase>/.venv/Scripts/python.exe */
  venvPy: z.string().default(''),
  /** 人设 system prompt 文件（绝对/相对仓库根；留空探测 persona/prompt.txt） */
  personaPrompt: z.string().default(''),
  /** 改写任务补充指令文件（绝对/相对仓库根；留空探测 persona/reframe.txt） */
  personaReframe: z.string().default(''),
  /** WS/API 额外放行的 Origin 主机名（缺省仅 localhost/127.0.0.1；浏览器跨站请求一律拒绝） */
  allowedOrigins: z.array(z.string()).default([]),
})
export interface Config {
  enabled: boolean
  assetsDir: string
  coreFile: string
  ttsUrl: string
  refAudio: string
  refPrompt: string
  maxSentence: number
  ttsTemperature: number
  ttsTopK: number
  ttsSpeedFactor: number
  reframe: boolean
  reframeProvider: string
  reframeModel: string
  reframeTimeoutMs: number
  reframeMaxInput: number
  reframeApiKeyRef: string
  reframeBaseUrl: string
  reframeTrace: boolean
  ttsWatch: boolean
  ttsWatchIntervalMs: number
  gsvBase: string
  venvPy: string
  personaPrompt: string
  personaReframe: string
  allowedOrigins: string[]
}

const PREFIX = '/@dsh-external/dsh-nori-pet'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** 断句符（中英标点 + 换行） */
const BOUNDARY = new Set(['。', '！', '？', '!', '?', '；', ';', '\n'])
/** 本地 Origin 主机白名单（WS / API 跨站防护；自定义访问来源用配置 allowedOrigins 扩展） */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

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

// ─── WebSocket 迷你实现（只读 JSON 帧 + 服务端推送） ───────────────────────────
function encodeFrame(payload: Buffer | string, opcode = 1): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  let head: Buffer
  if (data.length < 126) {
    head = Buffer.from([0x80 | opcode, data.length])
  } else if (data.length < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(data.length, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeUInt32BE(Math.floor(data.length / 0x100000000), 2)
    head.writeUInt32BE(data.length & 0xffffffff, 6)
  }
  return Buffer.concat([head, data])
}

interface ParsedFrame {
  opcode: number
  payload: Buffer
  consumed: number
}

function parseFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < 2) return null
  const b0 = buf[0]
  const b1 = buf[1]
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f
  let off = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    off = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    const hi = buf.readUInt32BE(2)
    const lo = buf.readUInt32BE(6)
    len = hi * 0x100000000 + lo
    off = 10
  }
  let maskKey: Buffer | null = null
  if (masked) {
    if (buf.length < off + 4) return null
    maskKey = buf.subarray(off, off + 4)
    off += 4
  }
  if (buf.length < off + len) return null
  let payload = buf.subarray(off, off + len)
  if (masked && maskKey) {
    payload = Buffer.from(payload)
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
  }
  return { opcode: fin ? opcode : opcode === 0 ? 0 : opcode, payload, consumed: off + len }
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
    try {
      const p = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'super-injector', 'nori-pet-error.log')
      appendFileSync(p, '[' + new Date().toISOString() + ']\n' + (e && (e as Error).stack ? (e as Error).stack : String(e)) + '\n')
    } catch { /* ignore */ }
    throw e
  }
}

function applyInner(ctx: AppContext, config: Config) {
  if (!config.enabled) return
  // 人设资产（persona/ 或配置覆盖）；缺失 → 改写层降级为原文朗读（启动即判定，进程内只读一次）
  const persona = loadPersona(dirname(HOST_DIR), { personaPrompt: config.personaPrompt, personaReframe: config.personaReframe })
  if (!persona) log('[dsh-nori-pet] persona 人设文件缺失（persona/prompt.txt 或 persona/reframe.txt），改写层关闭：直接朗读原始输出')
  const clients = new Set<PetClient>()
  const startTime = Date.now() // 订阅建立后回放历史事件的冷却窗口起点
  const chunkedSteps = new Set<string>() // 已走流式处理的 step（assistant/message 兜底防重复）
  // 会话水位：启动时记录各会话当前 seq，之后仅处理 seq >= 水位的实时事件（精确跳过历史回放）
  const watermark = new Map<string, number>()
  try {
    const sessionSvc: any = (ctx as any).sessions
    if (sessionSvc && typeof sessionSvc.list === 'function') {
      for (const s of sessionSvc.list()) {
        if (s && typeof s.id === 'string' && typeof s.seq === 'number') watermark.set(s.id, s.seq)
      }
    }
  } catch { /* ignore */ }
  let eventCount = 0
  let lastBroadcast = ''
  let statChunks = 0
  let statTextDelta = 0
  let statAssistant = 0
  let statTurnEnd = 0
  let statHello = 0
  let statAck = 0
  let lastAssistant = ''
  let lastSendFrame = ''
  const pending = new Map<string, string>() // `${sid}/${turn}/${step}` -> 未断句文本
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
      let h = 5381
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
      recentBroadcasts.push({ ts: Date.now(), type: String(o.type ?? ''), h: h.toString(36), turn: typeof o.turn === 'number' ? o.turn : undefined, len: s.length })
      if (recentBroadcasts.length > 20) recentBroadcasts.shift()
    }
    for (const c of clients) {
      // 会话维度过滤：已通过 hello 绑定 sessionId 的客户端只收该会话事件；未绑定（sessionId 空）收全部
      if (c.sessionId && typeof o.session === 'string' && o.session !== c.sessionId) continue
      try { c.send(msg) } catch { /* 单客户端失败忽略 */ }
    }
  }

  function flushKey(sid: string, key: string): void {
    // reframe 模式：整轮收集，pending 保留到 turn/end 统一合并改写（这里不能清）
    if (config.reframe) return
    const buf = pending.get(key)
    pending.delete(key)
    if (buf && buf.trim()) {
      const t = Number(key.split('/')[1]) || undefined
      statAssistant += 1
      lastAssistant = buf.trim().slice(0, 60)
      broadcast({ type: 'assistant', session: sid, text: buf.trim(), turn: t })
    }
  }

  // ── 改写合并批（防 LLM 调用风暴 / OOM）：句子攒批，~150 字或 1.2s 无新句才改写一次 ──
  let batchSid = ''
  let batchTurn = -1
  let batchText = ''
  let batchTimer: ReturnType<typeof setTimeout> | null = null
  const BATCH_MAX = 150
  const BATCH_IDLE_MS = 1200

  function flushBatch(): void {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null }
    const text = batchText.trim()
    const sid = batchSid
    const turn = batchTurn
    batchText = ''
    batchSid = ''
    batchTurn = -1
    if (text && sid) enqueueReframe(sid, turn, text)
  }

  function addToBatch(sid: string, turn: number, sentence: string): void {
    if (batchSid && (batchSid !== sid || batchTurn !== turn)) flushBatch() // turn 切换先收尾
    batchSid = sid
    batchTurn = turn
    batchText += sentence
    if (batchText.length >= BATCH_MAX) {
      flushBatch()
    } else {
      if (batchTimer) clearTimeout(batchTimer)
      batchTimer = setTimeout(flushBatch, BATCH_IDLE_MS)
    }
  }

  function pushChunk(sid: string, turn: number, step: number, delta: string): void {
    statChunks += 1
    statTextDelta += 1
    const key = `${sid}/${turn}/${step}`
    chunkedSteps.add(key) // 该 step 走过了流式（assistant/message 兜底应跳过）
    const cooling = Date.now() - startTime < 1000 // 冷启动回放窗口：只收集不广播
    if (config.reframe && !cooling) {
      // 流式按句 → 合并批改写（中途汇报也能实时读到，但不逐句调用 LLM）
      let rest = (pending.get(key) ?? '') + delta
      for (;;) {
        let idx = -1
        for (let i = 0; i < rest.length; i++) {
          if (BOUNDARY.has(rest[i])) { idx = i + 1; break }
        }
        if (idx < 0) break
        const sentence = rest.slice(0, idx).trim()
        if (sentence) addToBatch(sid, turn, sentence)
        rest = rest.slice(idx)
      }
      if (rest.length > config.maxSentence * 6) rest = rest.slice(-config.maxSentence * 6)
      if (rest) pending.set(key, rest)
      else pending.delete(key)
      return
    }
    let buf = (pending.get(key) ?? '') + delta
    if (config.reframe || cooling) {
      // 整轮收集模式（冷却期）：只累积不广播，防止单个 step 无限膨胀
      if (buf.length > config.maxSentence * 6) buf = buf.slice(-config.maxSentence * 6)
      if (buf) pending.set(key, buf)
      return
    }
    // 按边界切句（reframe 关闭时的实时流式广播）
    for (;;) {
      let idx = -1
      for (let i = 0; i < buf.length; i++) {
        if (BOUNDARY.has(buf[i])) { idx = i + 1; break }
      }
      if (idx < 0) break
      const sentence = buf.slice(0, idx).trim()
      buf = buf.slice(idx)
      if (sentence) { statAssistant += 1; lastAssistant = sentence.slice(0, 60); broadcast({ type: 'assistant', session: sid, text: sentence, turn }) }
    }
    // 超长兜底：防止单 step 无限累积
    if (buf.length > config.maxSentence * 3) {
      const head = buf.slice(0, config.maxSentence).trim()
      if (head) broadcast({ type: 'assistant', session: sid, text: head + '…', turn })
      buf = ''
    }
    if (buf) pending.set(key, buf)
  }

  // ─── Nori 人设改写层 ───────────────────────────────────────────
  /**
   * 把一段文本经 LLM 改写为 Nori 口吻；失败返回 null（调用方降级用原文）。
   * key 路径：reframeApiKeyRef 配置了专用 key → 直连 DeepSeek 官方 API（独立计量）；
   * 否则走 dsh 内置 llm 服务（与主会话共用计量）。
   */
  async function reframeText(text: string): Promise<string | null> {
    if (!persona) return text // 人设缺失：不改写，直接以原文朗读（保持链路通）
    const t0 = Date.now()
    const input = text.length > config.reframeMaxInput ? text.slice(0, config.reframeMaxInput) + '……' : text
    const system = persona.prompt + '\n\n' + persona.reframe
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), config.reframeTimeoutMs)
    try {
      // 路径 1：专用 key 直连官方 API
      let dedicatedKey = ''
      try {
        const creds: any = (ctx as any).credentials
        if (creds?.resolve && config.reframeApiKeyRef) {
          const hit = await creds.resolve(config.reframeApiKeyRef)
          if (hit && typeof hit.value === 'string' && hit.value.length > 10) dedicatedKey = hit.value
        }
      } catch { /* 解析失败则回退 */ }
      if (dedicatedKey) {
        const res = await fetch(config.reframeBaseUrl.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + dedicatedKey },
          body: JSON.stringify({
            model: config.reframeModel,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: input },
            ],
            temperature: 0.8,
            max_tokens: 512,
            stream: false,
          }),
          signal: ctrl.signal,
        })
        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          appendErr('reframe direct API HTTP ' + res.status + ': ' + errBody.slice(0, 200))
          return null
        }
        const data: any = await res.json().catch(() => null)
        const out = (data?.choices?.[0]?.message?.content as string) ?? ''
        const trimmed = out.trim()
        if (!trimmed) appendErr('reframe direct API EMPTY output; model=' + config.reframeModel)
        traceReframe(input, trimmed, Date.now() - t0)
        return trimmed || null
      }
      // 路径 2：dsh 内置 llm 服务
      const llm: any = (ctx as any).llm
      if (!llm || typeof llm.stream !== 'function') return null
      let out = ''
      for await (const chunk of llm.stream({
        provider: config.reframeProvider,
        model: config.reframeModel,
        messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
        system,
        temperature: 0.8,
        maxTokens: 512,
        signal: ctrl.signal,
      })) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      }
      const trimmed = out.trim()
      if (!trimmed) appendErr('reframe llm EMPTY output; provider=' + config.reframeProvider + ' model=' + config.reframeModel)
      traceReframe(input, trimmed, Date.now() - t0)
      return trimmed || null
    } catch (e) {
      log('[dsh-nori-pet] reframe failed: ' + String(e))
      appendErr('reframe failed: ' + String(e))
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  const logDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'super-injector')
  // 日志条数内存计数（文件裁剪阈值 100 → 保留 50）；trace 为 5 文件轮转 + 满 1000 删最早 200
  const errCount = { n: 0 }
  const traceCount = { n: 0 }

  // ── trace 日志轮转：nori-pet-trace.log（slot0）~ nori-pet-trace.4.log（slot4）──
  // 写入当前 slot 文件；满 TRACE_MAX 条 → 文件内裁剪保留 TRACE_KEEP（= 删最早 TRACE_MAX-TRACE_KEEP 条）
  // → 切换到下一 slot（mod TRACE_SLOTS）并清空该文件（覆盖最旧一轮）。slot 持久化在
  // nori-pet-trace.slot，重启后继续轮转，不会回写覆盖最近几轮。
  const TRACE_SLOTS = 5
  const TRACE_MAX = 1000
  const TRACE_KEEP = 800
  const traceSlot = { n: 0 }
  const slotMarker = join(logDir(), 'nori-pet-trace.slot')
  function tracePath(slot: number): string {
    return slot === 0 ? 'nori-pet-trace.log' : `nori-pet-trace.${slot}.log`
  }
  function readSlotMarker(): number {
    try {
      const v = parseInt(readFileSync(slotMarker, 'utf8').trim(), 10)
      return Number.isFinite(v) && v >= 0 && v < TRACE_SLOTS ? v : 0
    } catch { return 0 }
  }
  function writeSlotMarker(): void {
    try { writeFileSync(slotMarker, String(traceSlot.n), 'utf8') } catch { /* ignore */ }
  }
  // 启动时对齐：从 marker 恢复当前 slot，并把计数校准为该文件已有块数（避免超 1000 才裁剪）
  try {
    traceSlot.n = readSlotMarker()
    const cur = join(logDir(), tracePath(traceSlot.n))
    if (existsSync(cur)) {
      const raw = readFileSync(cur, 'utf8')
      traceCount.n = raw.split(/(?=^\[\d{4}-\d{2}-\d{2}T)/m).filter((b) => b.trim()).length
    }
  } catch { /* ignore */ }

  /** 日志自动裁剪：连续写入 MAX 条后保留最新 KEEP 条（按 ISO 时间戳行切记录块），防无限膨胀 */
  function pruneLogFile(p: string, countRef: { n: number }, max = 100, keep = 50): void {
    countRef.n += 1
    if (countRef.n < max) return
    try {
      const raw = readFileSync(p, 'utf8')
      const blocks = raw.split(/(?=^\[\d{4}-\d{2}-\d{2}T)/m).filter((b) => b.trim())
      if (blocks.length > keep) writeFileSync(p, blocks.slice(-keep).join(''), 'utf8')
      countRef.n = blocks.length > keep ? keep : blocks.length
    } catch { countRef.n = keep }
  }

  function appendErr(line: string): void {
    try {
      appendFileSync(join(logDir(), 'nori-pet-error.log'), '[' + new Date().toISOString() + '] ' + line + '\n')
    } catch { /* ignore */ }
    pruneLogFile(join(logDir(), 'nori-pet-error.log'), errCount)
  }

  /** 改写层输入/输出追踪（reframeTrace 开启时写入 nori-pet-trace*.log）：材料→改写结果，
   * 供定位"Nori 在哪轮、用什么材料开始讲某内容"（如背景设定介绍）。
   * 存储：5 文件轮转（slot0~4）；当前文件满 1000 条 → 删最早 200（保留 800）→ 轮换下一文件。 */
  function traceReframe(input: string, output: string, ms: number): void {
    try {
      if (!config.reframeTrace) return
      const p = join(logDir(), tracePath(traceSlot.n))
      appendFileSync(p, `[${new Date().toISOString()}] (${ms}ms)\nIN : ${input.slice(0, 500)}\nOUT: ${output.slice(0, 500)}\n────\n`)
      traceCount.n += 1
      if (traceCount.n >= TRACE_MAX) {
        // 文件内裁剪：保留最近 TRACE_KEEP（满 1000 → 删最早 200）
        const raw = readFileSync(p, 'utf8')
        const blocks = raw.split(/(?=^\[\d{4}-\d{2}-\d{2}T)/m).filter((b) => b.trim())
        const keep = blocks.slice(-TRACE_KEEP)
        if (keep.length < blocks.length) writeFileSync(p, keep.join(''), 'utf8')
        traceCount.n = keep.length
        // 轮转下一 slot（覆盖最旧一轮），清空目标文件
        traceSlot.n = (traceSlot.n + 1) % TRACE_SLOTS
        writeSlotMarker()
        try { writeFileSync(join(logDir(), tracePath(traceSlot.n)), '', 'utf8') } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  /** 收集某 turn 的全部残留文本（reframe 模式的整轮文本） */
  function collectTurnText(sid: string, turn: number): string {
    const prefix = `${sid}/${turn}/`
    let buf = ''
    for (const [k, v] of [...pending]) {
      if (k.startsWith(prefix)) { pending.delete(k); if (v) buf += v }
    }
    return buf
  }

  /**
   * 按段落拆分文本块（\n\n / \n / 长句边界），每块约 150~350 字。
   * 长回复拆成多块 → 逐块改写、改完一块立即广播 → 延迟更低、内容更完整。
   */
  function splitBlocks(text: string): string[] {
    const raw = text.trim()
    if (!raw) return []
    const MIN = 120
    const MAX = 360
    // 先按换行段拆
    const paras = raw.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
    const blocks: string[] = []
    let cur = ''
    for (const p of paras) {
      if (!cur) { cur = p; continue }
      if (cur.length + p.length + 1 <= MAX) { cur += '\n' + p; continue }
      blocks.push(cur)
      cur = p
    }
    if (cur) blocks.push(cur)
    // 单块仍超长 → 按句号硬切
    const out: string[] = []
    for (const b of blocks) {
      if (b.length <= MAX) { out.push(b); continue }
      const sentences = b.match(/[^。！？!?…;\n]+[。！？!?…;]?/g) || [b]
      let buf = ''
      for (const s of sentences) {
        if (buf.length + s.length <= MAX) { buf += s; continue }
        if (buf) { out.push(buf); buf = '' }
        let rest = s
        while (rest.length > MAX) { out.push(rest.slice(0, MAX)); rest = rest.slice(MAX) }
        buf = rest
      }
      if (buf) out.push(buf)
    }
    // 过小的块合并进前一块（避免碎片改写）
    const merged: string[] = []
    for (const b of out) {
      if (merged.length && merged[merged.length - 1].length < MIN && merged[merged.length - 1].length + b.length <= MAX) {
        merged[merged.length - 1] += '\n' + b
      } else {
        merged.push(b)
      }
    }
    return merged
  }

  /** 逐句改写并广播（流式路径；改写失败降级原文） */
  async function reframeAndBroadcast(sid: string, turn: number, text: string): Promise<void> {
    const reframed = await reframeText(text)
    const out = reframed || text
    statAssistant += 1
    lastAssistant = out.slice(0, 60)
    broadcast({ type: 'assistant', session: sid, text: out, turn })
  }

  // ── 改写串行队列：防止并发 LLM 调用风暴导致宿主 OOM（内存爆炸修复）──
  const reframeQueue: Array<{ sid: string; turn: number; text: string }> = []
  let reframeBusy = false
  const REFRAME_QUEUE_MAX = 30

  function enqueueReframe(sid: string, turn: number, text: string): void {
    if (reframeQueue.length >= REFRAME_QUEUE_MAX) reframeQueue.shift() // 防积压：丢最旧保最新
    reframeQueue.push({ sid, turn, text })
    void pumpReframe()
  }

  async function pumpReframe(): Promise<void> {
    if (reframeBusy) return
    reframeBusy = true
    try {
      while (reframeQueue.length) {
        const job = reframeQueue.shift()!
        await reframeAndBroadcast(job.sid, job.turn, job.text)
      }
    } finally {
      reframeBusy = false
    }
  }

  /** 逐块改写并广播：全部进串行队列（同 turn 块带 turn 供浏览器排队） */
  async function reframeBlocks(sid: string, turn: number, blocks: string[]): Promise<void> {
    const MAX_BLOCKS = 10
    const list = blocks.slice(0, MAX_BLOCKS)
    for (const block of list) {
      enqueueReframe(sid, turn, block)
    }
  }

  // ─── 会话事件观察（延迟订阅错过回放 + 水位 + 序号回退三重防回放） ──
  const maxSeq = new Map<string, number>()
  const delayedSub = setTimeout(() => {
    ;(ctx as any).on('session/event', (session: any, event: any) => {
      eventCount += 1
      const sid: string = session?.id ?? '?'
      // 回放过滤：事件 seq < 水位 = 宿主订阅前已存在的历史 → 精确跳过
      const evSeq = typeof event?.seq === 'number' ? event.seq : -1
      if (evSeq >= 0) {
        const w = watermark.get(sid)
        if (w !== undefined && evSeq < w) return
        const m = maxSeq.get(sid)
        if (m !== undefined && evSeq < m) return // 序号回退 = 新一轮回放 → 跳过
        maxSeq.set(sid, evSeq)
        watermark.set(sid, evSeq + 1) // 推进水位（新会话首个事件即实时）
      }
      const data = event?.data
    if (!data) return
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = data.chunk
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          pushChunk(sid, data.turn, data.step, chunk.text)
        }
        break
      }
      case 'assistant/message': {
        // 兜底：仅当该 step 从未流式（chunkedSteps 无记录）才收集完整文本，
        // 避免流式已广播后 message 又把整段重复收集（turn/end 二次改写朗读）
        const mkey = `${sid}/${data.turn}/${data.step}`
        if (!chunkedSteps.has(mkey)) {
          const full = extractText((data as any)?.message?.content)
          if (full && !pending.has(mkey)) pending.set(mkey, full)
        }
        flushKey(sid, mkey)
        break
      }
      case 'approval/asked': {
        // 权限申请提醒：原文播报（不走改写，保证准确）；冷却期回放不播
        if (Date.now() - startTime < 1000) break
        const tool = String((data as any)?.toolName ?? '')
        const reason = String((data as any)?.reason ?? '').trim()
        const text = '有权限申请' + (tool ? '：' + tool : '') + (reason ? '。原因：' + reason : '') + '。'
        broadcast({ type: 'approval', session: sid, text })
        break
      }
      case 'turn/end': {
        statTurnEnd += 1
        const cooling = Date.now() - startTime < 1000
        if (config.reframe) {
          // 收尾合并批，然后处理残留（冷却期只清残留）
          flushBatch()
          const full = collectTurnText(sid, data.turn).trim()
          if (!cooling && full) {
            const blocks = splitBlocks(full)
            void reframeBlocks(sid, data.turn, blocks)
          }
          broadcast({ type: 'turn-end', session: sid, turn: data.turn, reason: data.reason?.kind })
          // 清理该 turn 的流式标记，防无限增长
          const prefix = `${sid}/${data.turn}/`
          for (const k of [...chunkedSteps]) if (k.startsWith(prefix)) chunkedSteps.delete(k)
          break
        }
        // 清掉该 turn 的所有残留（reframe 关闭时的兜底；冷却期只清不广播）
        const prefix = `${sid}/${data.turn}/`
        for (const [k, v] of [...pending]) {
          if (k.startsWith(prefix)) { pending.delete(k); if (!cooling && v && v.trim()) { statAssistant += 1; lastAssistant = v.trim().slice(0, 60); broadcast({ type: 'assistant', session: sid, text: v.trim(), turn: data.turn }) } }
        }
        broadcast({ type: 'turn-end', session: sid, turn: data.turn, reason: data.reason?.kind })
        break
      }
      case 'user/message': {
        const t = extractText(data.content)
        if (t) broadcast({ type: 'user', session: sid, text: t.slice(0, 300) })
        break
      }
      case 'tool/result': {
        const name = data.message?.name ?? data.message?.callId ?? ''
        broadcast({ type: 'tool', session: sid, name: String(name) })
        break
      }
    }
    })
  }, 1500)
  // 延迟订阅的清理：宿主销毁时清掉定时器
  ;(ctx as any).effect(() => () => { try { clearTimeout(delayedSub) } catch { /* ignore */ } }, 'nori-pet-delayed-sub')

  // ─── TTS 代理：POST { text, emotion? } → WAV ───────────────────
  async function handleSpeak(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'forbidden' }))
      return
    }
    // body 大小上限 16KB（防本地页面/进程灌大请求；超限继续排空流但不累积）
    const MAX_BODY = 16 * 1024
    let body = ''
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size <= MAX_BODY) body += chunk
    }
    if (size > MAX_BODY) {
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'payload too large' }))
      return
    }
    let text = ''
    try {
      const parsed = JSON.parse(body || '{}')
      text = String(parsed.text ?? '').slice(0, 512)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid json' }))
      return
    }
    if (!text) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'empty text' }))
      return
    }
    const url = new URL(config.ttsUrl)
    url.searchParams.set('text', text)
    url.searchParams.set('text_lang', 'zh')
    url.searchParams.set('prompt_lang', 'zh')
    url.searchParams.set('media_type', 'wav')
    url.searchParams.set('temperature', String(config.ttsTemperature))
    url.searchParams.set('top_k', String(config.ttsTopK))
    url.searchParams.set('speed_factor', String(config.ttsSpeedFactor))
    if (config.refAudio) url.searchParams.set('ref_audio_path', resolveConfigPath(config.refAudio))
    if (config.refPrompt) url.searchParams.set('prompt_text', config.refPrompt)
    try {
      // 上游偶发推理 400（GPT-SoVITS Windows 热路径偶发 "tts failed"）：对 4xx/5xx 单次重试
      let lastStatus = 0
      let upBody = ''
      let buf: Buffer | null = null
      let ct = 'audio/wav'
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 30000)
        let tts: Response
        try {
          tts = await fetch(url, { signal: ctrl.signal })
        } finally { clearTimeout(timer) }
        lastStatus = tts.status
        if (tts.ok) {
          buf = Buffer.from(await tts.arrayBuffer())
          ct = tts.headers.get('content-type') || 'audio/wav'
          break
        }
        upBody = (await tts.text()).slice(0, 200)
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800))
      }
      if (!buf) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'tts http ' + lastStatus, ref: !!config.refAudio, upstream: upBody }))
        return
      }
      res.writeHead(200, { 'content-type': ct, 'content-length': buf.length, 'cache-control': 'no-store' })
      res.end(buf)
    } catch (e: any) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'tts offline: ' + String(e?.message ?? e).slice(0, 120) }))
    }
  }

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
    try { return resolve(dirname(HOST_DIR), v) } catch { return v }
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
    try { rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) } catch {
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
      file = join(resolveAssetsDir(), norm.slice('assets/'.length))
    } else {
      res.writeHead(404); res.end('not found'); return
    }
    try {
      const st = await stat(file)
      if (!st.isFile()) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'content-type': mime, 'content-length': st.size, 'cache-control': 'no-cache' })
      createReadStream(file).pipe(res)
    } catch {
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
      } catch { return false }
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
    const key = (req.headers['sec-websocket-key'] as string) || ''
    if (!key) { socket.destroy(); return }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    if (head.length) socket.unshift(head)

    const client: PetClient = { sessionId: null, send: () => undefined, close: () => undefined }
    let buffer = Buffer.alloc(0)
    let fragOpcode = 0
    let fragParts: Buffer[] = []

    client.send = (obj: unknown) => {
      // broadcast() 传入的已是 JSON 字符串，不能二次 stringify（否则浏览器 parse 出字符串而非对象）
      const msg = typeof obj === 'string' ? obj : JSON.stringify(obj)
      lastSendFrame = msg.slice(0, 120)
      try { socket.write(encodeFrame(msg)) } catch { /* ignore */ }
    }
    client.close = () => { try { socket.write(encodeFrame(Buffer.alloc(0), 8) as any); socket.end() } catch { socket.destroy() } }

    function onFrame(frame: ParsedFrame): void {
      if (frame.opcode === 0x9) { // ping → pong
        try { socket.write(encodeFrame(frame.payload, 0xa)) } catch { /* ignore */ }
        return
      }
      if (frame.opcode === 0x8) { clients.delete(client); socket.end(); return }
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        if (frame.opcode === 0x1) { fragOpcode = 0x1; fragParts = [] }
        fragParts.push(frame.payload)
        // 简化：单帧即完整消息（浏览器 WebSocket 发送小 JSON 不会分片）
        const text = Buffer.concat(fragParts).toString('utf8')
        try {
          const msg = JSON.parse(text)
          if (msg && msg.type === 'hello' && typeof msg.sessionId === 'string') { client.sessionId = msg.sessionId; statHello += 1 }
          if (msg && msg.type === 'ack') statAck += 1
        } catch { /* 非 JSON 忽略 */ }
        fragParts = []
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
    if (path === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, tts: config.ttsUrl, model: 'Nori', prefix: PREFIX, ws: clients.size, events: eventCount, chunks: statChunks, textDelta: statTextDelta, assistant: statAssistant, turnEnd: statTurnEnd, hello: statHello, ack: statAck, lastAssistant, last: lastBroadcast, sent: lastSendFrame, recentBroadcasts }))
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
  const WIDGET_PATH = join(HOST_DIR, 'widget.js')
  let widgetJs = ''
  try { widgetJs = readFileSync(WIDGET_PATH, 'utf8') } catch (e) { log('[dsh-nori-pet] widget.js missing: ' + WIDGET_PATH + ' ' + String(e)) }
  const WIDGET_TAG = '<script defer src="' + PREFIX + '/widget.js"></script>'

  // ─── api_v2 守护：定时探测 9880，掉了自动拉起（tts_infer.yaml 已指向新权重，重启即新声线） ──
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
    if (GSV_BASE && VENV_PY) log('[dsh-nori-pet] api_v2 watchdog ready: ' + GSV_BASE)
    else log('[dsh-nori-pet] api_v2 watchdog: GPT-SoVITS not found (set gsvBase/venvPy or place in repo); respawn disabled')
    // numba 缓存与 ffmpeg：仓库内（audio/、ffmpeg/）或环境变量，避免写死机器路径
    const numbaCache = process.env.NUMBA_CACHE_DIR || join(dirname(HOST_DIR), 'audio', 'numba_cache')
    const ffmpegBin = process.env.FFMPEG_BIN_DIR || (existsSync(join(dirname(HOST_DIR), 'ffmpeg', 'bin')) ? join(dirname(HOST_DIR), 'ffmpeg', 'bin') : '')
    ttsWatchTimer = setInterval(async () => {
      try {
        const probe = await fetch('http://127.0.0.1:9880/tts?text=%E6%B5%8B&media_type=wav', { signal: AbortSignal.timeout(3000) })
        if (probe.status < 500) return // 200/404/400 都算活着（500=缺 ref 参数也算活着）
      } catch { /* 探测失败 → 需要拉起 */ }
      if (!GSV_BASE || !VENV_PY) return
      try {
        const { spawn } = await import('node:child_process')
        const child = spawn(VENV_PY, ['api_v2.py', '-a', '127.0.0.1', '-p', '9880', '-c', 'GPT_SoVITS/configs/tts_infer.yaml'], {
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
        log('[dsh-nori-pet] api_v2 watchdog: spawning pid=' + (child.pid ?? '?') + ' (9880 was down)')
      } catch (e) {
        log('[dsh-nori-pet] api_v2 watchdog spawn failed: ' + String(e))
      }
    }, config.ttsWatchIntervalMs)
  }

  // ─── 注册（webServer 服务） ─────────────────────────────────────
  // prefix /api 同时覆盖 /api 与 /api/*（exact + prefix 同路径会碰撞）
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX + '/api', handler: (req, res) => void handleApi(req, res) }), 'nori-pet-api')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX + '/assets', handler: (req, res) => void handleAssets(req, res) }), 'nori-pet-assets')
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: PREFIX + '/ws', handler: handleUpgrade }), 'nori-pet-ws')
  ctx.effect(() => () => { for (const c of clients) { try { c.close() } catch { /* ignore */ } } clients.clear() }, 'nori-pet-ws-cleanup')
  ctx.effect(() => () => { if (ttsWatchTimer) { try { clearInterval(ttsWatchTimer) } catch { /* ignore */ } ttsWatchTimer = null } }, 'nori-pet-tts-watch')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/widget.js',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(widgetJs)
    },
  }), 'nori-pet-widget')
  ctx.effect(() => ctx.webServer.tapIndex((html: string) => {
    if (html.includes(PREFIX + '/widget.js')) return html
    if (html.includes('</body>')) return html.replace('</body>', WIDGET_TAG + '</body>')
    return html + WIDGET_TAG
  }), 'nori-pet-widget-tap')

  log('[dsh-nori-pet] host ready: tts=' + config.ttsUrl + ' assets=' + resolveAssetsDir() + ' core=' + resolveCoreFile())
}