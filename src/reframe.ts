/**
 * Nori 人设改写层：把要朗读的文本经 LLM 改写成 Nori 口吻（或概括成一段）。
 *
 * 从 index.ts 搬出（原本 320 行活在宿主闭包里）。这是全插件最"重"的一块：
 * 两条推理通道（专用 key 直连 / dsh 内置 llm）、串行队列、指纹去重、退化兜底。
 *
 * 依赖全部显式化（`ReframeDeps`），因此可以在测试里注入假 llm / 假 fetch ——
 * 这也是这一层第一次变得"可单测"。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.js'
import type { NoriLogs } from './logs.js'
import type { loadPersona, resolvePersonaPaths } from './prompt.js'
import { buildSystemPrompt, readReframeHot, readSummaryHot } from './prompt.js'
import { RUNAWAY_MAX_CHARS, RUNAWAY_MAX_SENTENCES } from './capSpeech.js'
import { softCut } from './segmentation.js'
import { extractSpeakable } from './speakable.js'
import { addBounded } from './util.js'

/** 概括层附加规则（整轮内容太长时用"一段话"替代逐句播报） */

type Persona = ReturnType<typeof loadPersona>
type PersonaPaths = ReturnType<typeof resolvePersonaPaths>

export interface ReframeDeps {
  config: Config
  logs: NoriLogs
  log: (...args: unknown[]) => void
  /** 仓库根：nori.config.json 就在这里（reframe 段支持热改） */
  repoRoot: string
  persona: Persona
  personaPaths: PersonaPaths
  /** dsh 凭据服务（reframeApiKeyRef 引用的专用 key） */
  credentials?: { resolve?: (ref: string) => Promise<{ value?: string } | null> }
  /** dsh 内置 llm 服务（通道 2） */
  llm?: { stream?: (req: unknown) => AsyncIterable<any> }
  broadcast: (obj: unknown) => void
  /** 统计与 /api/status 的 lastAssistant（宿主维护） */
  onAssistant: (out: string) => void
  /** 概括层硬截断（宿主测过 262 字的概括超长） */
  capSpeech: (text: string, maxSentences: number, maxChars: number) => string
  /** 某 turn 被抑制的原文长度（兜底日志里用） */
  summaryCharsOf: (turn: number) => number
}

export function createReframe(deps: ReframeDeps) {
  const { config, logs, log, repoRoot, persona, personaPaths, credentials, llm: llmSvc, broadcast, onAssistant, capSpeech, summaryCharsOf } = deps

  /** 已发过概括的 turn（防重复播报）；只关心近期，故有界 */
  const summarizedTurns = new Set<number>()


/**
 * 把一段文本经 LLM 改写为 Nori 口吻；失败返回 null（调用方降级用原文）。
 * key 路径：reframeApiKeyRef 配置了专用 key → 直连 DeepSeek 官方 API（独立计量）；
 * 否则走 dsh 内置 llm 服务（与主会话共用计量）。
 */
async function reframeText(text: string, mode: 'reframe' | 'summary' = 'reframe'): Promise<string | null> {
  if (!persona) return text // 人设缺失：不改写，直接以原文朗读（保持链路通）
  const t0 = Date.now()
  const rf = (config.reframe ?? {}) as Record<string, unknown>
  const maxInput = Number(rf.maxInput ?? 4000)
  const input = text.length > maxInput ? text.slice(0, maxInput) : text
  // 两处都热读：reframe.txt（风格）与 summary.txt（概括规则）改完下一次请求就生效，无需重载
  const system = buildSystemPrompt({
    prompt: persona.prompt,
    reframe: readReframeHot(personaPaths.reframePath, persona.reframe),
    summary: readSummaryHot(personaPaths.summaryPath, persona.summary),
  }, mode)

  // 运行时直读 nori.config.json reframe 段（明文，可随时改无需重装）：
  // apiKey / reframeBaseUrl / reframeModel / reframeMaxTokens / reframeTimeoutMs / reframeTrace
  let dedicatedKey = ''
  let dedicatedBase = ''
  let dedicatedModel = ''
  const configKeyRef = String((config.reframe as Record<string, unknown> | undefined)?.apiKeyRef ?? 'DEEPSEEK_NORI_API_KEY')
  let dedicatedMaxTokens = 2048
  let dedicatedTimeoutMs = 60000
  let traceOn = true
  try {
    const nc = JSON.parse(readFileSync(join(repoRoot, 'nori.config.json'), 'utf8'))
    const rf = nc?.reframe ?? {}
    if (typeof rf.apiKey === 'string' && rf.apiKey.trim().length > 10) dedicatedKey = rf.apiKey.trim()
  // 键名与 config.ts 的 reframe 对象一致：baseUrl / model / maxTokens / timeoutMs / trace
  const rfObj = rf as Record<string, unknown>
  if (typeof rfObj.baseUrl === 'string' && rfObj.baseUrl.trim()) dedicatedBase = rfObj.baseUrl.trim()
  if (typeof rfObj.model === 'string' && rfObj.model.trim()) dedicatedModel = rfObj.model.trim()
  if (typeof rfObj.maxTokens === 'number' && rfObj.maxTokens > 0) dedicatedMaxTokens = rfObj.maxTokens
  if (typeof rfObj.timeoutMs === 'number' && rfObj.timeoutMs > 0) dedicatedTimeoutMs = rfObj.timeoutMs
    // 追踪日志含对话原文，默认为关；这里支持在 nori.config.json 里随时开关
  if (typeof rfObj.trace === 'boolean') traceOn = rfObj.trace
  } catch { /* 无配置文件 → 用 dsh 配置层默认 */ }
  lastTraceOn = traceOn

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), dedicatedTimeoutMs)
  try {
    // 路径 1：专用 key 直连官方 API（独立计量，绝不碰主 key）
    // ② dsh 凭据引用（reframeApiKeyRef，默认 DEEPSEEK_NORI_API_KEY；由 install.ps1 写入）
    if (!dedicatedKey) {
      try {
        const creds: any = credentials
  if (creds?.resolve && configKeyRef) {
    const hit = await creds.resolve(configKeyRef)
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
          { role: 'user', content: input },
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
        logs.appendErr('reframe direct API HTTP ' + res.status + ' url=' + url + ' model=' + dedicatedModel + ': ' + errBody.slice(0, 200))
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
            if (t2) { logs.trace(input, t2, Date.now() - t0, traceOn, mode); return t2 }
          }
          logs.appendErr('reframe direct API retry failed; status=' + (retry ? retry.status : 'network'))
        }
        return null
      }
      const data: any = await res.json().catch(() => null)
      const out = (data?.choices?.[0]?.message?.content as string) ?? ''
      const trimmed = out.trim()
      if (!trimmed) logs.appendErr('reframe direct API EMPTY output; model=' + dedicatedModel + ' (推理模型思考链占满 max_tokens? 可调大 reframeMaxTokens)')
      logs.trace(input, trimmed, Date.now() - t0, traceOn, mode)
      return trimmed || null
    }
    // 路径 2：dsh 内置 llm 服务
    const llm: any = llmSvc
    if (!llm || typeof llm.stream !== 'function') return null
    let out = ''
    for await (const chunk of llm.stream({
    provider: String((config.reframe as Record<string, unknown> | undefined)?.provider ?? ''),
    // 不硬编码模型名（deepseek-chat 之类已被官方废弃）：配置里没写就不传，由 provider 决定默认模型
    model: String((config.reframe as Record<string, unknown> | undefined)?.model ?? '') || undefined,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      system,
      temperature: 0.8,
    maxTokens: dedicatedMaxTokens,
      signal: ctrl.signal,
    })) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
    const trimmed = out.trim()
    if (!trimmed) logs.appendErr('reframe llm EMPTY output; provider=' + String((config.reframe as Record<string, unknown> | undefined)?.provider ?? ''))
    logs.trace(input, trimmed, Date.now() - t0, traceOn, mode)
    return trimmed || null
  } catch (e) {
    log('[dsh-nori-pet] reframe failed: ' + String(e))
    logs.appendErr('reframe failed: ' + String(e))
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 最近一次 reframeText 读到的 trace 开关（nori.config.json 可热改）：
 * traceSummary 在 reframeText 之后调用，用它跟主开关保持一致 */
let lastTraceOn = true

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
  onAssistant(out)
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
    logs.appendErr(`[nori-pet] reframe dedup: 同一 turn(${turn}) 内重复投递已丢弃 fp=${fp} len=${body.length} head=${body.slice(0, 40)}`)
    return
  }
  seen.add(fp)
  if (reframeQueue.length >= REFRAME_QUEUE_MAX) {
    const dropped = reframeQueue.shift() // 防积压：丢最旧保最新
    if (dropped) logs.appendErr('[nori-pet] reframe queue overflow: dropped ' + dropped.text.slice(0, 40) + '…')
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
  addBounded(summarizedTurns, turn, 32) // 防无界增长：只需覆盖仍在等待判定的 turn
  const t0 = Date.now()
  let out = await reframeText(text, 'summary')
  if (!out) out = extractSpeakable(text) // 概括失败 → 播精简后的原文（跳过代码/日志/清单），仍好过念全文
  if (!out) return
  // 只拦"跑飞"：正常概括略超目标（3 句/140 字）不管 —— 多说两句只是多读几秒，
  // 删掉结论才是真损失。超过 6 句/400 字才认为失控，且截断时保住开头和结尾。
  const guarded = capSpeech(out, RUNAWAY_MAX_SENTENCES, RUNAWAY_MAX_CHARS)
  if (guarded !== out) logs.appendErr(`[nori-pet] summary runaway ${out.length}→${guarded.length} chars (turn=${turn})`)
  out = guarded
  const ms = Date.now() - t0
  onAssistant(out)
  // turn 用 `<N>-sum` 标记"这是概括"；widget 侧会把它归一成同一个逻辑 turn N
  // （同一轮回答的改写与概括应当排队朗读，不能互相抢断——否则前一句被腰斩、最后一句消失）
  broadcast({ type: 'assistant', session: sid, text: out, turn: `${turn}-sum` })
  logs.traceSummary(text, out, ms, lastTraceOn)
  log(`[dsh-nori-pet] summary: turn=${turn} 原文${text.length}字 → 播报${out.length}字 (${ms}ms)`)
}

/** 概括播报的兜底提示：等待超时/概括失败时，至少让用户知道"内容多、别干等" */
function broadcastSummaryFallback(sid: string, turn: number, reason: string): void {
  if (summarizedTurns.has(turn)) return
  addBounded(summarizedTurns, turn, 32) // 防无界增长：只需覆盖仍在等待判定的 turn
  broadcast({ type: 'assistant', session: sid, text: '内容有点多，我先记下来，稍后说重点。', turn: `${turn}-sum` })
  logs.appendErr(`[nori-pet] summary fallback (${reason}) turn=${turn} chars=${summaryCharsOf(turn)}`)
}

// extractSpeakable 已抽到 src/speakable.ts（纯函数，便于单测）

/** 逐块改写并广播：全部进串行队列（同 turn 块带 turn 供浏览器排队） */
async function reframeBlocks(sid: string, turn: number, blocks: string[]): Promise<void> {
  const MAX_BLOCKS = 10
  const list = blocks.slice(0, MAX_BLOCKS)
  if (blocks.length > MAX_BLOCKS) {
    // 旧版静默丢弃第 11 块起的内容（长报告会被念掉大半且无任何痕迹）
    logs.appendErr('[nori-pet] reframe dropped ' + (blocks.length - MAX_BLOCKS) + ' blocks (turn=' + turn + ', over MAX_BLOCKS=' + MAX_BLOCKS + ')')
  }
  for (const block of list) {
    enqueueReframe(sid, turn, block)
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

  return { reframeText, enqueueReframe, reframeBlocks, broadcastSummaryFallback, dropQueuedReframe, splitBlocks, hasQueuedSummary: (turn: number) => reframeQueue.some((j) => j.mode === 'summary' && j.turn === turn), hasSummarized: (turn: number) => summarizedTurns.has(turn) }
}
