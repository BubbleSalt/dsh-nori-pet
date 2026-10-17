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
import z from 'schemastery'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, dirname, normalize, extname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { cleanSpeech, softCut, spokenUnits } from './segmentation.js'
import { extractSpeakable } from './speakable.js'
import type { Socket } from 'node:net'
import { homedir } from 'node:os'
import { loadPersona } from './prompt.js'
import { buildRuntimeTtsConfig } from './modelPreset.js'

// 宿主以 ESM 方式被 loader import（无 __dirname），用 import.meta.url 推导包目录
const HOST_DIR = fileURLToPath(new URL('.', import.meta.url))

export const name = '@bubblesalt/dsh-nori-pet'
export const inject = ['webServer', 'llm', 'credentials', 'sessions']

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** Nori Live2D 模型目录（含 Nori.model3.json）；留空自动探测仓库内 Nori_web */
  assetsDir: z.string().default(''),
  /** live2dcubismcore.js 绝对路径；留空自动探测仓库内 cubism_sdk/Core */
  coreFile: z.string().default(''),
  /** 本地 GPT-SoVITS 服务地址（api_v2 的 /tts 端点） */
  ttsUrl: z.string().default('http://127.0.0.1:9880/tts'),
  /** 零样本参考音频（Nori 声线 wav，绝对或相对仓库根；留空自动回退插件自带 voice/nori.wav）。建议 3~10 秒（api_v2 强制要求）。 */
  refAudio: z.string().default(''),
  /** 参考音频的逐字转写文本（prompt text）。⚠ 必须与 refAudio 的音频内容完全一致：
   *  换 refAudio 时必须同步换 refPrompt，否则 AR 条件作用劣化 → 跳字/吞句（中英混排时更明显）、音色漂移。 */
  refPrompt: z.string().default('你好,初次见面,我的名字是Nori'),
  /** 单句推送的最大长度（超出强制截断） */
  maxSentence: z.number().min(1).default(140),
  /**
   * 超长内容的"详读预算"（字）。一段连续输出 ≤ 此字数 → 全文逐句详读（保持原有即时反馈）；
   * 超过 → 这一段一个字都不详读，整轮只播一次概括 —— 两者互斥，避免"前半详细、中间快进"的口径不一。
   * 输出速度约 300 token/s 时，400 字约 0.9 秒即可判定，所以长内容判定几乎不产生等待。
   */
  detailMaxChars: z.number().min(20).default(400),
  /** 超长内容概括总开关（关闭 = 完全保持逐句详读的旧行为） */
  summaryEnabled: z.boolean().default(true),
  /** 概括等待上限（毫秒）：超过则先播一句提示，避免长静默（LLM 慢/超时兜底） */
  summaryWaitMs: z.number().min(1000).default(8000),
  /**
   * TTS 推理参数。低温度更稳更收敛（避免采样噪声导致电音感），但温度过低 + top_k 过小
   * 会让 AR 模型在"嗯/唔"等鼻音叹词上进入采样循环：某个字无限拖长、随后吞掉句尾一小段。
   * 实测 0.65/5 约 1/6 卡顿；0.9/12 基本消除，且 speak 路径内置"拖长自动热参数重试"兜底。
   */
  ttsTemperature: z.number().default(0.9),
  ttsTopK: z.number().default(12),
  ttsSpeedFactor: z.number().default(1.0),
  /** Nori 人设改写层：agent 输出先经 LLM 改写为 Nori 口吻再朗读 */
  reframe: z.boolean().default(true),
  /** 改写 LLM 的 provider（dsh-llm 注册名） */
  reframeProvider: z.string().default('deepseek-official'),
  /** 改写 LLM 的模型 */
  reframeModel: z.string().default('deepseek-chat'),
  /** 改写单次调用的超时（毫秒）。实测真实负载（11.9K 人设 system + 材料）约 10s，
   * 网关波动时易撞线 → 放宽到 60s；失败仅降级原文，无副作用。可在 nori.config.json reframe.reframeTimeoutMs 运行时覆盖。 */
  reframeTimeoutMs: z.number().min(1000).default(60000),
  /** 改写输入的最大字符数（超出截断）。只作用于材料（user），不含 system 里的预设人设。
   *  调大后超长文本可一次喂更大块，改写请求次数更少、输出更精炼（配合 splitBlocks/BATCH_MAX）。 */
  reframeMaxInput: z.number().min(1).default(4000),
  /**
   * 改写单次调用的最大输出 token。推理型模型（DeepSeek-V4-Flash 等）思维链会先吃满
   * tokens 再出 content——512 常被 reasoning 占光导致 content 空、判 EMPTY 降级原文。
   * 非推理模型（deepseek-chat 等）512 足够，此处按需调大（如 2048）。
   */
  reframeMaxTokens: z.number().min(1).default(2048),
  /**
   * Nori 专用 API key 的 credentials ref（如 DEEPSEEK_NORI_API_KEY）。
   * 设置后改写层直连 DeepSeek 官方 API（独立计量，不走主会话）；留空则走 dsh 内置 llm 服务。
   */
  reframeApiKeyRef: z.string().default('DEEPSEEK_NORI_API_KEY'),
  /** 专用 key 直连的 API 地址（OpenAI 兼容 /chat/completions） */
  reframeBaseUrl: z.string().default('https://api.deepseek.com/v1'),
  /**
   * 改写层输入/输出追踪日志（排障用，**默认开启**）。
   *
   * 内容与落点：每轮对话的原文与改写结果各截 500 字，写进
   * `~/.dsh/logs/nori-pet/nori-pet-trace.log`。**自带长度上限**：超过 900 条就从最旧删到 400 条
   *（约 1.1MB → 500KB），整个日志目录超 8MB 时再删最旧的文件（见 enforceLogBudget）。
   * 所以长期开着也不会无限增长——需要翻"刚才那句为什么这么念"时，历史就在手边。
   * 不想要这些内容落盘就设 false（nori.config.json 的 `reframe.trace` 支持热改）。
   */
  reframeTrace: z.boolean().default(true),
  /** api_v2 守护：定时探测 9880，掉了自动拉起（桌面朗读保底） */
  ttsWatch: z.boolean().default(true),
  /** 守护探测间隔（毫秒）。下限 5s：填 0 会让 setInterval 退化成定时器风暴 + 反复 spawn */
  ttsWatchIntervalMs: z.number().min(5000).default(30000),
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
  detailMaxChars: number
  summaryEnabled: boolean
  summaryWaitMs: number
  ttsTemperature: number
  ttsTopK: number
  ttsSpeedFactor: number
  reframe: boolean
  reframeProvider: string
  reframeModel: string
  reframeTimeoutMs: number
  reframeMaxInput: number
  reframeMaxTokens: number
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

const PREFIX = '/@bubblesalt/dsh-nori-pet'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/**
 * 朗读文本硬截断：按句累加，超过 maxSentences 句或 maxChars 字就停。
 * 用于概括输出的兜底——提示词约束实测会被超，超长的"概括"会重新变成长朗读。
 * 情绪标签（【emo】）算作所在句的前缀，不会被单独切断。
 */
function capSpeech(text: string, maxSentences: number, maxChars: number): string {
  // 只按句末标点切：概括输出很短，且情绪标签【emo】自带全角括号不会被切断，无需 ICU 分词
  const units = String(text).split(/(?<=[。！？!?…；;\n])/).filter((s) => s.trim().length > 0)
  const out: string[] = []
  let len = 0
  for (const u of units) {
    if (out.length >= maxSentences) break
    if (len + u.length > maxChars && out.length > 0) break
    out.push(u.trim())
    len += u.trim().length
  }
  return out.join('')
}

/** 断句符（中英标点 + 换行） */
const BOUNDARY = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n'])

/**
 * 概括模式追加规则（接在 persona 之后）。设计约束来自实测需求：
 *  - 长度自适应：短内容 1 句，长内容最多 4 句 / 150 字（一次说到位，不啰嗦）
 *  - 事实优先：文件名/路径/数字/命令/结论/待确认项必须保留；中间过程与重复叙述可以丢
 *  - 不复述开头：超长内容的前段可能已经逐句播过，概括若复述开头会让人听两遍
 *  - 严禁编造：不确定就说"细节在屏幕上"，绝不把猜测说成事实
 */
const SUMMARY_RULES = [
  '【本次任务：概括】上面是 dsh 一轮输出的全文。请把它概括成我会朗读的一段话。',
  '规则：',
  '1. 长度上限（硬约束，实测容易超）：总共不超过 3 句、不超过 140 字。宁可少说，不可啰嗦——',
  '   超长的概括会重新变成"长朗读"。每句都必须短，不要写长复合句。',
  '2. 必须保留的事实：文件名/路径、数字（端口、行号、耗时、数量）、命令、结论（成功/失败/待办）、',
  '   阻塞原因、需要用户确认或授权的事。',
  '3. 可以丢的内容：中间过程、重复叙述、"我接下来要……"这类预告、无信息量的过渡句。',
  '4. 不要复述开头：开头几句可能已经逐句读过了，直接讲"结论 + 要你做的事"，不要重复。',
  '5. 严禁编造。不确定的部分就说"细节在屏幕上"。',
  '6. 只输出要朗读的话，不要加任何前缀、编号、标题、markdown 标记。',
].join('\n')

/** 朗读文本规整：
 *  1) 保证句尾有断句标点（便于 GPT-SoVITS cut5 分句）；
 *  2) 中英混排保护：英文词会让 AR 对齐失败，有约 75% 概率跳过它前面的中文片段
 *     （实测"会自己移除那条 ref"→ 跳过"会自己移除那条"）。在中文与英文词之间补逗号
 *     强制分片，让每个片段语言单一（实测把读出率提到 ~90%）。英文词须 ≥2 字符，
 *     避免误伤"C盘"这类单字母。反引号等无关字符清掉防干扰分句。
 *  注意：不要给叹词硬插逗号——实测会把句子切碎（某些 ref 下时长翻倍、听感断断续续）。 */
function normalizeSpeakText(raw: string): string {
  let t = String(raw).replace(/\r/g, '').trim()
  if (!t) return t
  t = t.replace(/[`′]/g, '')
  // 情绪标签是控制标记、不是正文：断句/截断后可能残留（ICU 会切在 `【` 与 `serious` 之间），
  // 必须在送去合成前剥干净，否则 GPT-SoVITS 会把"serious】"当文本念出来（用户实测听到过）
  t = cleanSpeech(t)
  t = t.replace(/([\u4e00-\u9fff])\s*([A-Za-z]{2,}[A-Za-z0-9'\-]*)/g, '$1，$2')
  if (!/[。！？!?；;…]$/.test(t)) t += '。'
  return t
}

/** 解析 WAV（RIFF/WAVE，PCM 8/16/32 位，单/双声道），返回每 100ms 帧的 RMS 能量数组（失败返回 []） */
function wavFrameRms(buf: Buffer): number[] {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return []
    let off = 12
    let channels = 1
    let sampleRate = 24000
    let bits = 16
    let dataOff = 0
    let dataLen = 0
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'fmt ') {
        channels = Math.max(1, buf.readUInt16LE(off + 10))
        sampleRate = buf.readUInt32LE(off + 12)
        bits = buf.readUInt16LE(off + 22)
      } else if (id === 'data') {
        dataOff = off + 8
        dataLen = size
        break
      }
      off += 8 + size + (size % 2)
    }
    if (!dataLen) return []
    const bytesPer = bits / 8
    const frameN = Math.max(1, Math.floor(sampleRate * 0.1))
    const stride = frameN * bytesPer * channels
    const nFrames = Math.floor(dataLen / stride)
    if (nFrames <= 0) return []
    const rms: number[] = new Array(nFrames)
    for (let f = 0; f < nFrames; f++) {
      const base = dataOff + f * stride
      let sum = 0
      for (let i = 0; i < frameN; i++) {
        const p = base + i * bytesPer * channels
        let v: number
        if (bits === 16) v = buf.readInt16LE(p) / 32768
        else if (bits === 8) v = (buf.readUInt8(p) - 128) / 128 // 注意 `&` 优先级低于 `-`：旧写法 readInt8(p) & 0xff - 128 实为 & 127，负半周被抹平
        else if (bits === 32) v = buf.readInt32LE(p) / 2147483648 // 32bit *整型* PCM（旧代码按 float 读 → 得到垃圾值）
        else v = 0
        sum += v * v
      }
      rms[f] = Math.sqrt(sum / frameN)
    }
    return rms
  } catch {
    return []
  }
}

/** 最长连续语音时长（秒）。GPT-SoVITS AR 采样循环（如"嗯/唔"鼻音拖长）会形成 >3.5s 不间断长音 */
function maxContiguousSpeech(buf: Buffer): number {
  const rms = wavFrameRms(buf)
  if (!rms.length) return 0
  let mx = 0
  let cur = 0
  for (const r of rms) {
    cur = r > 0.01 ? cur + 1 : 0
    if (cur > mx) mx = cur
  }
  return mx * 0.1
}
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
      const logBase = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'logs', 'nori-pet')
      try { mkdirSync(logBase, { recursive: true }) } catch { /* ignore */ }
      const p = join(logBase, 'nori-pet-error.log')
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

  // ── 改写合并批（低延迟流式改写）：句子成句即攒批，~150 字或 1.2s 无新句就改写广播，
  //    长 turn 中途即开始播，避免"整轮结束才统一改写"的高延迟 ──
  let batchSid = ''
  let batchTurn = -1
  let batchText = ''
  let batchTimer: ReturnType<typeof setTimeout> | null = null
  const BATCH_MAX = 500 // 流式攒批上限：调大后超长文本改写请求更少（实时性略降，换来话少/请求少）
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

  // 无句失声超时：流式输出停顿且迟迟不出标点（长 URL/代码/省略标点的段落）时，
  // 2s 后把已攒残留"截断并输出"，避免一直静默等待到 turn/end。持续有增量则每块重置计时。
  // ⚠ 碎片保护：agent 流式输出停顿（思考/工具间隙）常产生 <40 字的碎句（"包装""器："），
  //   不足门槛的残留不独立广播——滞留 pending，turn/end 整段拼接后再改写，避免给碎片"配音"。
  const REST_FLUSH_MS = 2000
  const REST_FLUSH_MIN = 40
  // eslint 无关：node/dom 双 types 下 setTimeout 返回类型不一致，统一放宽为 any
  const restFlushTimers = new Map<string, any>()
  function armRestFlush(sid: string, turn: number, key: string): void {
    const old = restFlushTimers.get(key)
    if (old) clearTimeout(old)
    restFlushTimers.set(key, setTimeout(() => {
      restFlushTimers.delete(key)
      const r = pending.get(key)
      if (!r) return
      const trimmed = r.trim()
      if (!trimmed || trimmed.length < REST_FLUSH_MIN) return // 碎片滞留 pending，等 turn/end collectTurnText 拼接
      pending.delete(key)
      // 不再做"超长就截断 + 省略号"：不定长残段只可能是超长原子串（长路径/URL/代码，词感知
      // 切分刻意不肯切），截断会正好切断它——而这正是要保护的东西。dsh 输出约 450 字/秒，
      // 攒到下一个标点只需零点几秒，等待代价远小于截断代价。
      if (config.reframe) addToBatch(sid, turn, trimmed) // 进改写批，正常链路广播
      else {
        statAssistant += 1
        lastAssistant = trimmed.slice(0, 60)
        broadcast({ type: 'assistant', session: sid, text: trimmed, turn })
      }
    }, REST_FLUSH_MS) as unknown as number)
  }
  function clearRestFlush(prefix: string): void {
    for (const [k, t] of [...restFlushTimers]) if (k.startsWith(prefix)) { clearTimeout(t); restFlushTimers.delete(k) }
  }
  function clearRestFlushOne(key: string): void {
    const t = restFlushTimers.get(key)
    if (t) { clearTimeout(t); restFlushTimers.delete(key) }
  }

  // ── 详读 / 概括 二选一（口径统一，不混用）──
  // 一段连续输出（= 一个 step）≤ detailMaxChars → 全文逐句详读；
  // 超过 → 该段一个字都不详读，整轮只播一次概括。
  // 为什么必须"整段"而非"逐句"判断：逐句判断会出现"前半念得详细、后半突然快进"的口径断层。
  // 输出速度约 300 token/s（≈450 字/秒），400 字约 0.9 秒即判定，长内容判定几乎无等待。
  type Band = 'detail' | 'sum'
  const stepBand = new Map<string, Band>() // key -> 该段轨道
  const stepChars = new Map<string, number>() // key -> 该段累计字数
  const turnBand = new Map<number, Band>() // turn -> 轨道（sum 优先）
  const turnSummaryText = new Map<number, string>() // turn -> 被抑制的原文（供概括）
  const summarizedTurns = new Set<number>() // 已发过概括的 turn（防重复播报）
  const turnChars = new Map<number, number>() // turn -> 累计输出字数（判断整轮是否够长）

  function noteTurnChar(turn: number, n: number): void {
    const v = (turnChars.get(turn) ?? 0) + n
    turnChars.set(turn, v)
    if (turnChars.size > 32) { const f = turnChars.keys().next().value; if (f !== undefined && f !== turn) turnChars.delete(f) }
  }

  /** 锁定某段为"概括轨"：停止一切细粒度播报，丢弃该 turn 尚未播出的琐碎内容。
   *  keepPending=true 时不丢 pending（turn/end 路径要用它收集本段尾巴）。 */
  function lockSummaryBand(sid: string, turn: number, key: string, reason: string, keepPending = false): void {
    if (turnBand.get(turn) === 'sum' && !keepPending) return
    turnBand.set(turn, 'sum')
    // 丢弃已排队的细粒度内容：概括会覆盖整段，避免"念一半 + 概括"重复
    if (!keepPending) {
      clearRestFlush(key)
      const dropped = dropQueuedReframe(turn)
      const prefix = `${sid}/${turn}/`
      let droppedPending = 0
      for (const [k, v] of [...pending]) {
        if (k.startsWith(prefix)) { droppedPending += v.length; pending.delete(k) }
      }
      log(`[dsh-nori-pet] summary band lock: ${reason} turn=${turn} 丢弃改写${dropped}条/待断句${droppedPending}字`)
    } else {
      log(`[dsh-nori-pet] summary band lock(end): ${reason} turn=${turn}`)
    }
  }

  /** 从改写队列中摘掉某 turn 尚未执行的任务，返回条数（概括接管后这些内容不再逐句播） */
  function dropQueuedReframe(turn: number): number {
    let n = 0
    for (let i = reframeQueue.length - 1; i >= 0; i--) {
      if (reframeQueue[i]!.turn === turn) { reframeQueue.splice(i, 1); n += 1 }
    }
    return n
  }

  function pushChunk(sid: string, turn: number, step: number, delta: string): void {
    statChunks += 1
    statTextDelta += 1
    const key = `${sid}/${turn}/${step}`
    chunkedSteps.add(key) // 该 step 走过了流式（assistant/message 兜底应跳过）

    // ── 轨道判定（在播种内容之前）──
    noteTurnChar(turn, delta.length)
    let band: Band = stepBand.get(key) ?? 'detail'
    if (band === 'detail') {
      const acc = (stepChars.get(key) ?? 0) + delta.length
      stepChars.set(key, acc)
      if (stepChars.size > 64) { const f = stepChars.keys().next().value; if (f !== undefined && f !== key) stepChars.delete(f) }
      if (config.summaryEnabled && acc > config.detailMaxChars) {
        stepBand.set(key, 'sum')
        if (stepBand.size > 64) { const f = stepBand.keys().next().value; if (f !== undefined && f !== key) stepBand.delete(f) }
        lockSummaryBand(sid, turn, key, `本段 ${acc} 字 > ${config.detailMaxChars}`)
        band = 'sum'
      }
    }

    if (band === 'sum') {
      // 概括轨：只累积原文，不做断句/改写/广播（概括会一次覆盖整段）
      turnSummaryText.set(turn, (turnSummaryText.get(turn) ?? '') + delta)
      if (turnSummaryText.size > 8) { const f = turnSummaryText.keys().next().value; if (f !== undefined && f !== turn) turnSummaryText.delete(f) }
      return
    }

    if (config.reframe) {
      // 流式断句→分批改写（低延迟）：句子成句即入批，攒 ~150 字或 1.2s 无新句就 flush。
      // 无断句标点的段落（如"先看当前 git 状态……错在哪"）不能一直滞留 pending——turn/end
      // 才 collect 会让它排到批次之后；故无边界且够长（≥maxSentence）时用同一份词感知切分
      // 软切入批，顺序恒等于原文，且绝不切开标识符。
      let rest = (pending.get(key) ?? '') + delta
      for (;;) {
        let idx = -1
        for (let i = 0; i < rest.length; i++) {
          if (BOUNDARY.has(rest[i])) {
            idx = i + 1
            while (idx < rest.length && BOUNDARY.has(rest[idx])) idx++ // 连续标点整组归当前句
            break
          }
        }
        if (idx > 0) {
          const sentence = rest.slice(0, idx).trim()
          rest = rest.slice(idx)
          if (sentence) {
            for (const u of spokenUnits(sentence, config.maxSentence)) addToBatch(sid, turn, u)
          }
          continue
        }
        // 无边界且已够长 → 先让断句模块切出"可朗读单元"（词感知、不切标识符）
        const units = rest.length >= config.maxSentence ? spokenUnits(rest, config.maxSentence) : []
        if (units.length > 1) {
          for (let n = 0; n < units.length - 1; n++) addToBatch(sid, turn, units[n]!)
          rest = units[units.length - 1]!
        }
        break
      }
      if (rest.length > config.maxSentence * 6) {
        // 兜底：极端不定长文本（数百字无标点的代码/路径）超过 6×maxSentence 时先把已攒部分
        // 入批（顺序不变、内容不丢），避免 pending 无界增长。正常情况到不了这里：上面
        // spokenUnits 早已切出多段。
        addToBatch(sid, turn, rest)
        rest = ''
      }
      if (rest) { pending.set(key, rest); armRestFlush(sid, turn, key) }
      else { pending.delete(key); clearRestFlushOne(key) }
      return
    }

    // ── reframe 关闭：实时按句广播原文（同一份 delta 只能走这里，绝不能再进改写批）──
    let buf = (pending.get(key) ?? '') + delta
    for (;;) {
      let idx = -1
      for (let i = 0; i < buf.length; i++) {
        if (BOUNDARY.has(buf[i])) {
          idx = i + 1
          while (idx < buf.length && BOUNDARY.has(buf[idx])) idx++ // 连续标点整组归当前句
          break
        }
      }
      if (idx < 0) break
      const sentence = buf.slice(0, idx).trim()
      buf = buf.slice(idx)
      // 长句再切成短朗读单元（同一份切分逻辑，widget 侧不重复切）
      if (sentence) {
        for (const unit of spokenUnits(sentence, config.maxSentence)) {
          statAssistant += 1
          lastAssistant = unit.slice(0, 60)
          broadcast({ type: 'assistant', session: sid, text: unit, turn })
        }
      }
    }
    // 超长兜底：防止单 step 无限累积
    if (buf.length > config.maxSentence * 3) {
      const units = spokenUnits(buf, config.maxSentence)
      for (let n = 0; n < units.length - 1; n++) {
        const unit = units[n]!
        statAssistant += 1
        lastAssistant = unit.slice(0, 60)
        broadcast({ type: 'assistant', session: sid, text: unit, turn })
      }
      // 注意：必须保留切点之后的尾巴——旧代码 buf = '' 会把软切之后的文本整段丢掉
      // （既不广播也不留 pending，长 URL / 无标点长段直接失声且无日志）
      buf = units.length ? units[units.length - 1]! : ''
    }
    if (buf) { pending.set(key, buf); armRestFlush(sid, turn, key) }
    else { pending.delete(key); clearRestFlushOne(key) }
  }

  // ─── Nori 人设改写层 ───────────────────────────────────────────
  /**
   * 把一段文本经 LLM 改写为 Nori 口吻；失败返回 null（调用方降级用原文）。
   * key 路径：reframeApiKeyRef 配置了专用 key → 直连 DeepSeek 官方 API（独立计量）；
   * 否则走 dsh 内置 llm 服务（与主会话共用计量）。
   */
  async function reframeText(text: string, mode: 'reframe' | 'summary' = 'reframe'): Promise<string | null> {
    if (!persona) return text // 人设缺失：不改写，直接以原文朗读（保持链路通）
    const t0 = Date.now()
    const input = text.length > config.reframeMaxInput ? text.slice(0, config.reframeMaxInput) + '……' : text
    const userContent = input
    const system = persona.prompt + '\n\n' + persona.reframe + (mode === 'summary' ? '\n\n' + SUMMARY_RULES : '')

    // 运行时直读 nori.config.json reframe 段（明文，可随时改无需重装）：
    // apiKey / reframeBaseUrl / reframeModel / reframeMaxTokens / reframeTimeoutMs / reframeTrace
    let dedicatedKey = ''
    let dedicatedBase = config.reframeBaseUrl
    let dedicatedModel = config.reframeModel
    let dedicatedMaxTokens = config.reframeMaxTokens
    let dedicatedTimeoutMs = config.reframeTimeoutMs
    let traceOn = config.reframeTrace
    try {
      const nc = JSON.parse(readFileSync(join(dirname(HOST_DIR), 'nori.config.json'), 'utf8'))
      const rf = nc?.reframe ?? {}
      if (typeof rf.apiKey === 'string' && rf.apiKey.trim().length > 10) dedicatedKey = rf.apiKey.trim()
      if (typeof rf.reframeBaseUrl === 'string' && rf.reframeBaseUrl.trim()) dedicatedBase = rf.reframeBaseUrl.trim()
      if (typeof rf.reframeModel === 'string' && rf.reframeModel.trim()) dedicatedModel = rf.reframeModel.trim()
      if (typeof rf.reframeMaxTokens === 'number' && rf.reframeMaxTokens > 0) dedicatedMaxTokens = rf.reframeMaxTokens
      if (typeof rf.reframeTimeoutMs === 'number' && rf.reframeTimeoutMs > 0) dedicatedTimeoutMs = rf.reframeTimeoutMs
      // 追踪日志含对话原文，默认为关；这里支持在 nori.config.json 里随时开关
      if (typeof rf.reframeTrace === 'boolean') traceOn = rf.reframeTrace
    } catch { /* 无配置文件 → 用 dsh 配置层默认 */ }
    lastTraceOn = traceOn

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), dedicatedTimeoutMs)
    try {
      // 路径 1：专用 key 直连官方 API（独立计量，绝不碰主 key）
      // ② dsh 凭据引用（reframeApiKeyRef，默认 DEEPSEEK_NORI_API_KEY；由 install.ps1 写入）
      if (!dedicatedKey) {
        try {
          const creds: any = (ctx as any).credentials
          if (creds?.resolve && config.reframeApiKeyRef) {
            const hit = await creds.resolve(config.reframeApiKeyRef)
            if (hit && typeof hit.value === 'string' && hit.value.length > 10) dedicatedKey = hit.value
          }
        } catch { /* 解析失败则回退 */ }
      }
      if (dedicatedKey) {
        const baseUrl = dedicatedBase.replace(/\/+$/, '')
        // 兼容通用 OpenAI 格式端点：baseUrl 已含 /chat/completions 则直接用，否则补全
        const url = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : baseUrl + '/chat/completions'
        const retryBody = JSON.stringify({
          model: dedicatedModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userContent },
          ],
          temperature: 0.8,
          max_tokens: dedicatedMaxTokens,
          stream: false,
        })
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + dedicatedKey },
          body: retryBody,
          signal: ctrl.signal,
        })
        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          appendErr('reframe direct API HTTP ' + res.status + ' url=' + url + ' model=' + dedicatedModel + ': ' + errBody.slice(0, 200))
          // 中转端点偶发 400/5xx（实测 "There was an error parsing the body" 后紧接一次就成功）
          // → 重试一次，仍失败才降级。重试比"直接播原文"便宜，也比再包一层容错简单。
          if (res.status >= 400) {
            const retry = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + dedicatedKey },
              body: retryBody,
              signal: ctrl.signal,
            }).catch(() => null)
            if (retry && retry.ok) {
              const d2: any = await retry.json().catch(() => null)
              const t2 = ((d2?.choices?.[0]?.message?.content as string) ?? '').trim()
              if (t2) { traceReframe(input, t2, Date.now() - t0, traceOn, mode); return t2 }
            }
            appendErr('reframe direct API retry failed; status=' + (retry ? retry.status : 'network'))
          }
          return null
        }
        const data: any = await res.json().catch(() => null)
        const out = (data?.choices?.[0]?.message?.content as string) ?? ''
        const trimmed = out.trim()
        if (!trimmed) appendErr('reframe direct API EMPTY output; model=' + dedicatedModel + ' (推理模型思考链占满 max_tokens? 可调大 reframeMaxTokens)')
        traceReframe(input, trimmed, Date.now() - t0, traceOn, mode)
        return trimmed || null
      }
      // 路径 2：dsh 内置 llm 服务
      const llm: any = (ctx as any).llm
      if (!llm || typeof llm.stream !== 'function') return null
      let out = ''
      for await (const chunk of llm.stream({
        provider: config.reframeProvider,
        model: config.reframeModel,
        messages: [{ role: 'user', content: [{ type: 'text', text: userContent }] }],
        system,
        temperature: 0.8,
        maxTokens: config.reframeMaxTokens,
        signal: ctrl.signal,
      })) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      }
      const trimmed = out.trim()
      if (!trimmed) appendErr('reframe llm EMPTY output; provider=' + config.reframeProvider + ' model=' + config.reframeModel + ' (推理模型思考链占满 max_tokens? 可调大 reframeMaxTokens)')
      traceReframe(input, trimmed, Date.now() - t0, traceOn, mode)
      return trimmed || null
    } catch (e) {
      log('[dsh-nori-pet] reframe failed: ' + String(e))
      appendErr('reframe failed: ' + String(e))
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // 日志目录独立于注入器（~/.dsh/super-injector 是 dsh-super-injector 的地盘），
  // 迁到 ~/.dsh/logs/nori-pet/（DSH_HOME 未设置则用 ~/.dsh）
  const logDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'logs', 'nori-pet')
  try { mkdirSync(logDir(), { recursive: true }) } catch { /* ignore */ }
  // 日志条数内存计数（文件裁剪阈值 100 → 保留 50）
  const errCount = { n: 0 }
  /** 最近一次 reframeText 读到的 trace 开关（nori.config.json 可热改）：
   * traceSummary 在 reframeText 之后调用，用它跟主开关保持一致 */
  let lastTraceOn = config.reframeTrace
  /** trace 文件当前条数（内存计数，避免每次写都读盘数一遍） */
  let traceCount = 0

  // ── trace 日志：单文件 + 行数硬上限 ──
  // 追踪日志用于排障，但**必须自带上限**：早期版本是 5 个 slot 轮转、每个只按"条数"裁剪，
  // 总量无上限，且热重载会把 slot 指针重置回 0 → 同一个文件被反复续写，实测长到 1MB 还在涨。
  //
  // 现在只有**一条规则**：单文件超过 TRACE_MAX_ENTRIES 条就从最旧删到 TRACE_KEEP_ENTRIES 条。
  // 为什么不按字节设阈值：字节阈值必须配"裁到多少字节"，两者挨太近会抖动
  //（刚裁到目标、下一次写入又贴上限 → 每条都读写一遍 1MB 文件）。行数上限单调、可一眼证明有界，
  // 实际体积由"每条 ≤ 约 1.2KB（IN/OUT 各 500 字）"封顶 —— 400 条 ≈ 500KB。
  const TRACE_FILE = 'nori-pet-trace.log'
  const TRACE_MAX_ENTRIES = 900 // 超过即裁剪（实测约 1.1MB 触发一次）
  const TRACE_KEEP_ENTRIES = 400 // 裁剪后保留最新（约 500KB）
  const LOG_BUDGET = 8 << 20 // 日志目录总预算 8MB：超了就删最旧的文件
  const TRACE_ENTRY_RE = /(?=^\[\d{4}-\d{2}-\d{2}T)/m
  const tracePath = join(logDir(), TRACE_FILE)

  /** 载入现有条数（启动时一次），并做一次总体预算检查 */
  function initTraceLog(): void {
    try {
      // 旧版是「nori-pet-trace.1.log ~ .4.log + slot 文件」多文件轮转，总量无上限。
      // 改成单文件后这些旧文件不会再被写入，留着只会让人分不清哪个是当前日志 → 顺手收掉。
      try { unlinkSync(join(logDir(), 'nori-pet-trace.slot')) } catch { /* 可能不存在 */ }
      for (let s = 1; s < 10; s++) {
        try { unlinkSync(join(logDir(), `nori-pet-trace.${s}.log`)) } catch { /* 可能不存在 */ }
      }
      if (existsSync(tracePath)) {
        const raw = readFileSync(tracePath, 'utf8')
        traceCount = raw.split(TRACE_ENTRY_RE).filter((b) => b.trim()).length
      }
      enforceLogBudget()
    } catch { /* ignore */ }
  }

  /**
   * 单文件裁剪：条数超上限就从最旧删起，保留最新 TRACE_KEEP_ENTRIES 条。
   * 返回裁剪后条数；未超限返回 null（跳过读盘，正常路径零额外开销）。
   */
  function traceTrim(): number | null {
    try {
      if (traceCount + 1 <= TRACE_MAX_ENTRIES) return null
      const blocks = readFileSync(tracePath, 'utf8').split(TRACE_ENTRY_RE).filter((b) => b.trim())
      const slice = blocks.slice(-TRACE_KEEP_ENTRIES)
      writeFileSync(tracePath, slice.join(''), 'utf8')
      traceCount = slice.length
      enforceLogBudget()
      return traceCount
    } catch { return null }
  }

  /**
   * 日志目录总预算：超过 LOG_BUDGET 时，从**最旧的文件**开始删。
   * 为什么需要：单文件上限只约束单文件；轮转历史上会攒出多个文件（实测 2.4MB 一整个目录）。
   * 用文件 mtime 排序，删到预算以内为止（只删本插件自己的 trace/error/summary 日志）。
   */
  function enforceLogBudget(): void {
    try {
      const files = readdirSync(logDir())
        .filter((f) => f.startsWith('nori-pet-') && f.endsWith('.log'))
        .map((f) => {
          const p = join(logDir(), f)
          const st = statSync(p)
          return { f, p, size: st.size, mtime: st.mtimeMs }
        })
      let total = files.reduce((n, x) => n + x.size, 0)
      if (total <= LOG_BUDGET) return
      for (const x of files.sort((a, b) => a.mtime - b.mtime)) {
        if (total <= LOG_BUDGET) break
        try { unlinkSync(x.p) } catch { /* ignore */ }
        total -= x.size
        if (x.p === tracePath) traceCount = 0
        log(`[dsh-nori-pet] 日志超出预算，已删除最旧：${x.f}（${Math.round(x.size / 1024)}KB）`)
      }
    } catch { /* ignore */ }
  }

  initTraceLog()

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

  /**
   * 改写层输入/输出追踪：材料→改写结果，两列记录（IN=当前块材料本体、OUT=改写输出）。
   * 存储在单文件 `nori-pet-trace.log`，超 1MB 自动从最旧删到 512KB（见 TRACE_MAX_BYTES）。
   *
   * ⚠ 这条日志写的是**对话原文**（各截 500 字），只在排障时有用；不想要就设
   * `nori.config.json` 的 `reframe.trace = false`。
   * 开关每次调用从 reframeText 传进来（`on`），所以配置改动立即生效、无需重装。
   */
  function traceReframe(input: string, output: string, ms: number, on: boolean, src = ''): void {
    try {
      if (!on) return
      // 记录来源与长度：出现"同一段被改写两次"时，靠 src/len 一眼判断是投递重复还是模型重复
      const tag = src ? ` src=${src} len=${input.length}` : ` len=${input.length}`
      const fp = createHash('sha1').update(input).digest('hex').slice(0, 8)
      const entry = `[${new Date().toISOString()}] (${ms}ms)${tag} fp=${fp}\nIN : ${input.slice(0, 500)}\nOUT: ${output.slice(0, 500)}\n────\n`
      traceTrim() // 先裁后写：文件始终在上限内
      appendFileSync(tracePath, entry)
      traceCount += 1
    } catch { /* ignore */ }
  }

  /** 概括层追踪：原文→概括输出，用"压缩比"验证是否真的省了朗读时间。
   * 与 traceReframe 同开关（traceOn）：这里同样会写原文片段，属隐私面，默认关。
   * 计数用独立对象：原先与 trace 共用一个计数器，会把 trace 的行数当成 summary 的条数，
   * 于是 summary 日志几乎每次都被判定"超上限"而裁剪，日志被反复重写。 */
  const summaryCount = { n: 0 }
  function traceSummary(raw: string, out: string, ms: number, on: boolean): void {
    try {
      if (!on) return
      const ratio = raw.length ? Math.round((out.length / raw.length) * 100) : 0
      const p = join(logDir(), 'nori-pet-summary.log')
      appendFileSync(p, `[${new Date().toISOString()}] (${ms}ms) 原文${raw.length}字 → 概括${out.length}字（压缩到 ${ratio}%）\nRAW: ${raw.slice(0, 300)}\nSUM: ${out.slice(0, 300)}\n────\n`)
      summaryCount.n += 1
      pruneLogFile(p, summaryCount)
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
    const MIN = 300
    const MAX = 1000 // 块上限调大：超长文本请求次数更少、Nori 输出更精炼（话少）
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
        while (rest.length > MAX) {
          const cut = softCut(rest, MAX) // 软切：尽量保住自然断点，避免"奇怪位置切断"
          out.push(rest.slice(0, cut))
          rest = rest.slice(cut)
        }
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

  // softCut / spokenUnits 统一来自 src/segmentation.ts（宿主与 widget 共用同一实现）：
  // 旧版本地实现把"非词内部"当断点，会在 danger-full-access 的连字符处下刀，故整体退役。

  /** 逐句改写并广播（流式路径；改写失败降级原文） */
  async function reframeAndBroadcast(sid: string, turn: number, text: string): Promise<void> {
    const reframed = await reframeText(text)
    const out = reframed || text
    statAssistant += 1
    lastAssistant = out.slice(0, 60)
    broadcast({ type: 'assistant', session: sid, text: out, turn })
  }

  // ── 改写串行队列：防止并发 LLM 调用风暴导致宿主 OOM（内存爆炸修复）──
  const reframeQueue: Array<{ sid: string; turn: number; text: string; mode: 'reframe' | 'summary' }> = []
  let reframeBusy = false
  const REFRAME_QUEUE_MAX = 30

  /**
   * 投递去重：同一 turn 内**完全相同的文本**只排队一次。
   *
   * 为什么需要：曾出现同一段文字被投递两次（trace 里两条 IN 完全相同、各自跑了 LLM），
   * 结果是同一段内容被改写、播报两遍——听感上非常明显。触发路径与增量怎么切分有关，
   * 与其在每条路径上各堵一次，不如在唯一的收口处按指纹去重（指纹同时写进 trace，
   * 下次真出现重复时能一眼对上是哪条路径送进来的）。
   */
  const reframeHashes = new Map<number, Set<string>>()

  /**
   * 本代一次性定时器登记表：所有"稍后要做事"的 setTimeout 都登记进来，fiber dispose 时统一清。
   *
   * 为什么必须收口（实测踩过）：不清的定时器在热重载后仍会触发，带着**旧代的状态**再投递/再
   * 播报一次（同一段被改写播报两遍）。单个地方各清一次容易漏（概括等待上限这处就漏过），
   * 所以这里提供一个统一入口。
   */
  const genTimers = new Set<any>()

  function later(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      genTimers.delete(id)
      fn()
    }, ms)
    genTimers.add(id)
  }

  function enqueueReframe(sid: string, turn: number, text: string, mode: 'reframe' | 'summary' = 'reframe'): void {
    const body = text.trim()
    if (!body) return
    const fp = createHash('sha1').update(body).digest('hex').slice(0, 8)
    let seen = reframeHashes.get(turn)
    if (!seen) {
      if (reframeHashes.size > 16) reframeHashes.clear() // 只关心近期 turn
      seen = new Set<string>()
      reframeHashes.set(turn, seen)
    }
    if (seen.has(fp)) {
      appendErr(`[nori-pet] reframe dedup: 同一 turn(${turn}) 内重复投递已丢弃 fp=${fp} len=${body.length} head=${body.slice(0, 40)}`)
      return
    }
    seen.add(fp)
    if (reframeQueue.length >= REFRAME_QUEUE_MAX) {
      const dropped = reframeQueue.shift() // 防积压：丢最旧保最新
      if (dropped) appendErr('[nori-pet] reframe queue overflow: dropped ' + dropped.text.slice(0, 40) + '…')
    }
    reframeQueue.push({ sid, turn, text, mode })
    void pumpReframe()
  }

  async function pumpReframe(): Promise<void> {
    if (reframeBusy) return
    reframeBusy = true
    try {
      while (reframeQueue.length) {
        const job = reframeQueue.shift()!
        if (job.mode === 'summary') await summarizeAndBroadcast(job.sid, job.turn, job.text)
        else await reframeAndBroadcast(job.sid, job.turn, job.text)
      }
    } finally {
      reframeBusy = false
    }
  }

  /**
   * 概括并播报：整轮只有一次，播报时用 sentinel turn 触发 widget 侧 speakInterrupt，
   * 替换掉队列里尚未播出的细粒度内容（保证听感只有一段统一概括）。
   */
  async function summarizeAndBroadcast(sid: string, turn: number, text: string): Promise<void> {
    if (summarizedTurns.has(turn)) return
    summarizedTurns.add(turn)
    if (summarizedTurns.size > 32) { // 防无界增长：只需覆盖仍在等待判定的 turn
      const f = summarizedTurns.values().next().value
      if (f !== undefined && f !== turn) summarizedTurns.delete(f)
    }
    const t0 = Date.now()
    let out = await reframeText(text, 'summary')
    if (!out) out = extractSpeakable(text) // 概括失败 → 播精简后的原文（跳过代码/日志/清单），仍好过念全文
    if (!out) return
    // 长度硬兜底：prompt 约束实测会被超（3111 字原文曾概括出 262 字）→ 超长时按句截断
    const capped = capSpeech(out, 4, 150)
    if (capped !== out) appendErr(`[nori-pet] summary truncated ${out.length}→${capped.length} chars (turn=${turn})`)
    out = capped
    const ms = Date.now() - t0
    statAssistant += 1
    lastAssistant = out.slice(0, 60)
    broadcast({ type: 'assistant', session: sid, text: out, turn: `${turn}-sum` })
    traceSummary(text, out, ms, lastTraceOn)
    log(`[dsh-nori-pet] summary: turn=${turn} 原文${text.length}字 → 播报${out.length}字 (${ms}ms)`)
  }

  /** 概括播报的兜底提示：等待超时/概括失败时，至少让用户知道"内容多、别干等" */
  function broadcastSummaryFallback(sid: string, turn: number, reason: string): void {
    if (summarizedTurns.has(turn)) return
    summarizedTurns.add(turn)
    if (summarizedTurns.size > 32) {
      const f = summarizedTurns.values().next().value
      if (f !== undefined && f !== turn) summarizedTurns.delete(f)
    }
    broadcast({ type: 'assistant', session: sid, text: '内容有点多，我先记下来，稍后说重点。', turn: `${turn}-sum` })
    appendErr(`[nori-pet] summary fallback (${reason}) turn=${turn} chars=${(turnSummaryText.get(turn) ?? '').length}`)
  }

  // extractSpeakable 已抽到 src/speakable.ts（纯函数，便于单测）

  /** 逐块改写并广播：全部进串行队列（同 turn 块带 turn 供浏览器排队） */
  async function reframeBlocks(sid: string, turn: number, blocks: string[]): Promise<void> {
    const MAX_BLOCKS = 10
    const list = blocks.slice(0, MAX_BLOCKS)
    if (blocks.length > MAX_BLOCKS) {
      // 旧版静默丢弃第 11 块起的内容（长报告会被念掉大半且无任何痕迹）
      appendErr('[nori-pet] reframe dropped ' + (blocks.length - MAX_BLOCKS) + ' blocks (turn=' + turn + ', over MAX_BLOCKS=' + MAX_BLOCKS + ')')
    }
    for (const block of list) {
      enqueueReframe(sid, turn, block)
    }
  }

  // ─── 会话事件观察 ──
  const toolCallNames = new Map<string, string>() // callId → 工具名（tool/call 才有名字）
  // ── 实时流：当前 dsh（session format v4）的正文不走 `assistant/chunk`（v0 已移除），而是
  //    `agent/assistant-stream`（进程本地、非持久）：start 帧带 turn/step，chunk 帧带
  //    `frame.chunk`。文本块只在 `block-end` 携带完整内容（{type:'block-end',block:{type:'text',
  //    text}}），部分 provider 还会发 `text-delta` 块内增量，两条都接。──
  //   ⚠ `agent/assistant-stream` 是 **scope-filtered** 事件（`this: Scoped<Agent>`）：
  //     agent 作用域内的监听器只收自己那个 agent。插件在**外层作用域**注册，必须显式
  //     `{ global: true }` 才能收到任何 agent 的帧——漏掉这个参数时监听器永不触发、
  //     且不报错（旧版因此整条流式播报静默，是"长内容一口气读完"的根因之一）。
  const attemptTurn = new Map<string, { turn: number; step: number }>()
  ;(ctx as any).on('agent/assistant-stream', (payload: any) => {
    const frame = payload?.frame
    if (!frame) return
    const sid = String(payload?.agent?.session?.id ?? '')
    if (!sid) return
    if (frame.type === 'start') {
      attemptTurn.set(String(frame.attemptId), { turn: Number(frame.turn ?? 0), step: Number(frame.step ?? 0) })
      if (attemptTurn.size > 64) { // 防无界增长（异常结束的 attempt 会残留）
        const first = attemptTurn.keys().next().value
        if (first !== undefined) attemptTurn.delete(first)
      }
      return
    }
    if (frame.type === 'end') { attemptTurn.delete(String(frame.attemptId)); return }
    if (frame.type !== 'chunk') return
    const c = frame.chunk
    if (!c || typeof c.type !== 'string') return
    const ts = attemptTurn.get(String(frame.attemptId))
    const feed = (text: string): void => { if (text) pushChunk(sid, ts?.turn ?? 0, ts?.step ?? 0, text) }
    // 协议（实测当前 DSH）：文本不走 text-delta，而是 `block-end` 携带整块内容：
    //   { type:'block-end', index, block:{ type:'text'|'reasoning'|'tool-call', text } }
    // 旧的 `text-delta` 分支保留兼容（其他 provider/版本可能仍发增量）。
    if (c.type === 'text-delta') { if (typeof c.text === 'string') feed(c.text); return }
    if (c.type !== 'block-end') return
    const block = c.block
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return // 只播正文：reasoning 规划与 tool-call 参数不朗读
    feed(block.text)
  }, { global: true })
  const delayedSub = setTimeout(() => {
    ;(ctx as any).on('session/event', (session: any, event: any) => {
      eventCount += 1
      const sid: string = session?.id ?? '?'
      // 回放过滤：事件 seq < 水位 = 宿主订阅前已存在的历史 → 精确跳过。
      // 只靠 seq，不用"启动后 N 秒内不播报"这类时间窗——那会连实时事件一起丢掉。
      const evSeq = typeof event?.seq === 'number' ? event.seq : -1
      if (evSeq >= 0) {
        const w = watermark.get(sid)
        if (w !== undefined && evSeq < w) return
        watermark.set(sid, evSeq + 1) // 推进水位（新会话首个事件即实时）
      }
      const data = event?.data
    if (!data) return
    switch (event.type) {
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
        // 权限申请提醒：原文播报（不走改写，保证准确）
        const tool = String((data as any)?.toolName ?? '')
        const reason = String((data as any)?.reason ?? '').trim()
        const text = '有权限申请' + (tool ? '：' + tool : '') + (reason ? '。原因：' + reason : '') + '。'
        broadcast({ type: 'approval', session: sid, text })
        break
      }
      case 'turn/end': {
        statTurnEnd += 1
        // 清理该 turn 的流式标记与失声超时器，防无限增长（旧版 reframe 分支关闭时不清
        // chunkedSteps → 该 Set 只增不减，且 turn/step 复用会误跳过 message 兜底）
        const prefix = `${sid}/${data.turn}/`
        for (const k of [...chunkedSteps]) if (k.startsWith(prefix)) chunkedSteps.delete(k)
        clearRestFlush(prefix)
        if (config.reframe) {
          // 收尾批次（低延迟流式改写的剩余句子），再 collect 未断句残留
          flushBatch()
          const tailText = collectTurnText(sid, data.turn).trim()
          // 概括轨：本段正文不逐句播，整轮只播一次概括（见 lockSummaryBand 注释）
          const band = turnBand.get(data.turn)
          if (band === 'sum' || (tailText.length > 0 && (turnChars.get(data.turn) ?? 0) > config.detailMaxChars * 2)) {
            if (band !== 'sum') lockSummaryBand(sid, data.turn, prefix, `整轮 ${turnChars.get(data.turn)} 字 > ${config.detailMaxChars * 2}`, true)
            const raw = ((turnSummaryText.get(data.turn) ?? '') + tailText).trim()
            turnSummaryText.delete(data.turn)
            if (raw) {
              const turnNo = data.turn
              enqueueReframe(sid, turnNo, raw, 'summary')
              // 等待上限：LLM 慢时不至于让宠物静默到让人以为挂了
              later(() => {
                if (!reframeQueue.some((j) => j.mode === 'summary' && j.turn === turnNo)) return // 已出队处理/已完成
                if (summarizedTurns.has(turnNo)) return
                broadcastSummaryFallback(sid, turnNo, 'wait-timeout')
              }, config.summaryWaitMs)
            }
          } else if (tailText) {
            const blocks = splitBlocks(tailText)
            void reframeBlocks(sid, data.turn, blocks)
          }
          // 轨道状态回收（防无界增长）
          turnBand.delete(data.turn)
          turnChars.delete(data.turn)
          turnSummaryText.delete(data.turn)
          for (const k of [...stepBand.keys()]) if (k.startsWith(prefix)) stepBand.delete(k)
          for (const k of [...stepChars.keys()]) if (k.startsWith(prefix)) stepChars.delete(k)
          broadcast({ type: 'turn-end', session: sid, turn: data.turn, reason: data.reason?.kind })
          break
        }
        // reframe 关闭时的兜底：把该 turn 的未断句残留原文直接播掉
        for (const [k, v] of [...pending]) {
          if (k.startsWith(prefix)) {
            pending.delete(k)
            if (v && v.trim()) { statAssistant += 1; lastAssistant = v.trim().slice(0, 60); broadcast({ type: 'assistant', session: sid, text: v.trim(), turn: data.turn }) }
          }
        }
        broadcast({ type: 'turn-end', session: sid, turn: data.turn, reason: data.reason?.kind })
        break
      }
      case 'user/message': {
        const t = extractText(data.content)
        if (t) broadcast({ type: 'user', session: sid, text: t.slice(0, 300) })
        break
      }
      case 'tool/call': {
        // 工具名只在这里：tool/result 的 ToolResultMessage 只有 { role, source{kind,callId},
        // toolCallId, content, isError }，既无 name 也无顶层 callId（旧代码取 message.name
        // ?? message.callId 恒得空串，广播出来是 name:""）
        if (data.callId) toolCallNames.set(String(data.callId), String(data.name ?? ''))
        if (toolCallNames.size > 200) { // 防无界增长：会话异常结束时会残留
          const first = toolCallNames.keys().next().value
          if (first !== undefined) toolCallNames.delete(first)
        }
        break
      }
      case 'tool/result': {
        const callId = String(data.message?.toolCallId ?? data.message?.source?.callId ?? '')
        const name = toolCallNames.get(callId) ?? ''
        toolCallNames.delete(callId)
        broadcast({ type: 'tool', session: sid, name })
        break
      }
      default:
        break
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
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size <= MAX_BODY) body += chunk
      }
    } catch {
      // 客户端中断（ECONNRESET/aborted）：迭代器会 reject，吞掉并结束该请求
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'request aborted' }))
      return
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
    // TTS 配置以 nori.config.json 为运行时真相（注入器热重载不重读该文件，这里请求时即时读取，
    // 改 refAudio/refPrompt/温度/top_k 无需重载插件即生效）
    const fileCfg: Record<string, unknown> = {}
    try {
      Object.assign(fileCfg, JSON.parse(readFileSync(join(dirname(HOST_DIR), 'nori.config.json'), 'utf8')))
    } catch { /* 文件缺失/损坏则回退注入配置 */ }
    const tts = { ...config }
    if (typeof fileCfg.ttsTemperature === 'number') tts.ttsTemperature = fileCfg.ttsTemperature
    if (typeof fileCfg.ttsTopK === 'number') tts.ttsTopK = fileCfg.ttsTopK
    if (typeof fileCfg.ttsSpeedFactor === 'number') tts.ttsSpeedFactor = fileCfg.ttsSpeedFactor
    if (typeof fileCfg.refAudio === 'string' && fileCfg.refAudio) tts.refAudio = fileCfg.refAudio
    if (typeof fileCfg.refPrompt === 'string' && fileCfg.refPrompt) tts.refPrompt = fileCfg.refPrompt
    // ttsUrl 来自配置/注入 patch，缺协议头（`127.0.0.1:9880/tts`）时 new URL 会抛 TypeError；
    // 这个 async 函数曾经没有兜底 → unhandledRejection → fail-loud 打死整台 dsh。
    let url: URL
    try {
      url = new URL(tts.ttsUrl)
    } catch {
      appendErr('[nori-pet] ttsUrl 非法（需形如 http://127.0.0.1:9880/tts）：' + String(tts.ttsUrl))
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'tts url invalid', ttsUrl: String(tts.ttsUrl) }))
      return
    }
    url.searchParams.set('text', normalizeSpeakText(text))
    url.searchParams.set('text_lang', 'zh')
    url.searchParams.set('prompt_lang', 'zh')
    url.searchParams.set('media_type', 'wav')
    url.searchParams.set('temperature', String(tts.ttsTemperature))
    url.searchParams.set('top_k', String(tts.ttsTopK))
    url.searchParams.set('speed_factor', String(tts.ttsSpeedFactor))
    // ref 兜底：配置未设 refAudio 时回退到插件自带 voice/nori.wav（否则上游 400 → /speak 502 静音）
    const refPath = tts.refAudio ? resolveConfigPath(tts.refAudio) : join(dirname(HOST_DIR), 'voice', 'nori.wav')
    if (existsSync(refPath)) url.searchParams.set('ref_audio_path', refPath)
    if (tts.refPrompt) url.searchParams.set('prompt_text', tts.refPrompt)
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
        } catch (e) {
          clearTimeout(timer)
          throw e
        }
        lastStatus = tts.status
        if (tts.ok) {
          // 超时定时器必须覆盖到响应体读完：上游"先回头再卡住流"时 await arrayBuffer 会永不返回，
          // 面板 pumping 永久占用 → 之后所有朗读排队卡死（用户观感"桌宠哑了"）。
          buf = Buffer.from(await Promise.race([
            tts.arrayBuffer(),
            new Promise<never>((_, rej) => setTimeout(() => { try { ctrl.abort() } catch { /* ignore */ } ; rej(new Error('tts response body timeout')) }, 30000)),
          ]))
          clearTimeout(timer)
          ct = tts.headers.get('content-type') || 'audio/wav'
          break
        }
        clearTimeout(timer)
        upBody = (await tts.text()).slice(0, 200)
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800))
      }
      if (!buf) {
        // TTS 失败此前只回前端气泡、不落任何日志 → 线上"没声音"完全不可观测
        appendErr('[nori-pet] tts http ' + lastStatus + ' ref=' + refPath + ' upstream=' + upBody.slice(0, 120))
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'tts http ' + lastStatus, ref: !!tts.refAudio, refPath, upstream: upBody }))
        return
      }
      // 安全网：最长连续语音 >3.5s 判定为 AR 采样循环拖长（"嗯/唔"等鼻音叹词偶发），
      // 用更高随机性参数（0.95/15）重生成替换，最多 3 次；仅当结果更短才采用。
      let guardLoops = 0
      while (buf && maxContiguousSpeech(buf) > 3.5 && guardLoops < 3) {
        guardLoops++
        const warm = new URL(url)
        warm.searchParams.set('temperature', '0.95')
        warm.searchParams.set('top_k', '15')
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 30000)
        try {
          const w = await fetch(warm, { signal: ctrl.signal })
          if (w.ok) {
            const nb = Buffer.from(await w.arrayBuffer())
            clearTimeout(timer)
            if (maxContiguousSpeech(nb) <= maxContiguousSpeech(buf)) buf = nb
            else break
          } else { clearTimeout(timer); break }
        } catch {
          break
        } finally {
          clearTimeout(timer)
        }
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
        appendErr('[nori-pet] assets read error ' + file + ': ' + String(e?.message ?? e))
        if (!res.headersSent) { try { res.writeHead(404); res.end('not found') } catch { /* ignore */ } }
        else try { res.destroy() } catch { /* ignore */ }
      })
      res.writeHead(200, { 'content-type': mime, 'content-length': st.size, 'cache-control': 'no-cache' })
      rs.pipe(res)
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
    try {
      const pu = new URL(config.ttsUrl)
      pu.searchParams.set('text', '测')
      pu.searchParams.set('media_type', 'wav')
      probeUrl = pu.toString()
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
        } catch (e) { log('[dsh-nori-pet] tts model preset 读取配置失败: ' + String((e as Error)?.message ?? e)) }
        try {
          const { spawn } = await import('node:child_process')
          const child = spawn(VENV_PY, ['api_v2.py', '-a', '127.0.0.1', '-p', '9880', '-c', ttsCfgArg], {
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
            log('[dsh-nori-pet] api_v2 spawn error: ' + String(e?.message ?? e) + '（路径或权限有问题：VENV_PY=' + VENV_PY + '）')
          })
          child.on('exit', (code) => {
            spawnWaitUntil.delete(child)
            if (code !== 0) log('[dsh-nori-pet] api_v2 exited code=' + code + '（若端口被占用或权重缺失会秒退，下次探测才会重试）')
          })
          log('[dsh-nori-pet] api_v2 watchdog: spawning pid=' + (child.pid ?? '?') + ' (9880 was down)')
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
        appendErr('[nori-pet] ' + tag + ' handler error @ ' + where + ': ' + String(e?.stack ?? e).slice(0, 400))
        log('[dsh-nori-pet] ' + tag + ' handler error @ ' + where + ': ' + String(e?.message ?? e))
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
  ctx.effect(() => () => {
    if (batchTimer) { try { clearTimeout(batchTimer) } catch { /* ignore */ } batchTimer = null }
    for (const t of restFlushTimers.values()) { try { clearTimeout(t) } catch { /* ignore */ } }
    restFlushTimers.clear()
    for (const t of genTimers) { try { clearTimeout(t) } catch { /* ignore */ } }
    genTimers.clear()
  }, 'nori-pet-broadcast-timers')
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
