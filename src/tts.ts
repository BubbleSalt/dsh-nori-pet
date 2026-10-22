/**
 * TTS 代理：`POST {prefix}/api/speak` → 本地 GPT-SoVITS api_v2 合成 → WAV 字节流。
 *
 * 从 index.ts 搬出：这 167 行原本埋在宿主的 applyInner 闭包里，与"会话播报"没有关系，
 * 却是最容易踩坑的一段（超时、重试、AR 拖长重生、ref 音频回退、运行时热读配置）。
 * 抽成工厂后依赖显式化（配置 / 日志 / 取证环 / 来源校验），也便于单测注入假的 fetch。
 *
 * 三个真实事故停留在这里，改动请保留注释：
 *  · `new URL(ttsUrl)` 会抛 TypeError（配置缺协议头）→ 曾因没有兜底 unhandledRejection 打死整台 dsh；
 *  · 超时定时器必须覆盖**响应体**读取：上游"先回头再卡住流"会让 await arrayBuffer 永不返回，
 *    面板 pumping 永久占用 → 之后所有朗读排队卡死（用户观感"桌宠哑了"）；
 *  · 失败必须落日志：早期只回前端气泡、不留痕迹，"没声音"完全不可观测。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.js'
import { cleanSpeech } from './segmentation.js'
import { endWithPeriod, toSpeakable } from './speakText.js'
import { maxContiguousSpeech } from './wav.js'
import { CJK_CLASS } from './textPatterns.js'

/** 单次上游请求的超时（毫秒）。覆盖"拿到响应头"与"读完响应体"两段 */
const UPSTREAM_TIMEOUT_MS = 30000
/**
 * 单个 /api/speak 请求的**总预算**（毫秒）：重试 + 拖长重生都会再打上游，
 * 不封顶时最坏情况是 2 次合成 + 3 次重生 ≈ 150s —— 面板那边的播报队列会跟着卡死。
 */
const TOTAL_BUDGET_MS = 40000
/** 4xx/5xx 后重试前的等待（毫秒）：GPT-SoVITS Windows 热路径偶发 "tts failed" */
const RETRY_DELAY_MS = 800
/** "拖长"判定阈值（秒）与重生次数上限：AR 在鼻音叹词上采样循环，实测 >3.5s 不间断有声 */
const LOOP_SPEECH_SEC = 3.5
const LOOP_REGEN_MAX = 3
/** 请求体上限（防本地页面/进程灌大请求；超限继续排空流但不累积） */
const MAX_BODY = 16 * 1024
/** 送进面板气泡的文本上限（防超长文本把上游打爆） */
const MAX_TEXT_CHARS = 512

/** 朗读文本规整：
 *  1) 保证句尾有断句标点（便于 GPT-SoVITS cut5 分句）；
 *  2) 中英混排保护：英文词会让 AR 对齐失败，有约 75% 概率跳过它前面的中文片段
 *     （实测"会自己移除那条 ref"→ 跳过"会自己移除那条"）。在中文与英文词之间补逗号
 *     强制分片，让每个片段语言单一（实测把读出率提到 ~90%）。英文词须 ≥2 字符，
 *     避免误伤"C盘"这类单字母。反引号等无关字符清掉防干扰分句。
 *  注意：不要给叹词硬插逗号——实测会把句子切碎（某些 ref 下时长翻倍、听感断断续续）。 */
export function normalizeSpeakText(raw: string): string {
  let t = String(raw).replace(/\r/g, '').trim()
  if (!t) return t
  t = t.replace(/[`′]/g, '')
  // 情绪标签是控制标记、不是正文：断句/截断后可能残留（ICU 会切在 `【` 与 `serious` 之间），
  // 必须在送去合成前剥干净，否则 GPT-SoVITS 会把"serious】"当文本念出来（用户实测听到过）
  t = cleanSpeech(t)
  // 中文紧贴拉丁词（`用index.ts`）在 TTS 里会连读，插一个逗号断开；CJK 范围取共享类，别再抄一份
  t = t.replace(new RegExp(`([${CJK_CLASS}])\\s*([A-Za-z]{2,}[A-Za-z0-9'\\-]*)`, 'g'), '$1，$2')
  return endWithPeriod(t)
}

export interface SpeakHandlerDeps {
  config: Config
  /** 仓库根（nori.config.json 与 voice/ 相对它解析） */
  repoRoot: string
  /** 来源校验：宿主侧唯一实现（跨站 GET/POST 防护） */
  isTrusted(req: IncomingMessage): boolean
  /** 取证环：记下每次送进合成的文本与前端上报的预算，供 /api/status 核对 */
  noteSpeak(text: string, budget?: number, units?: number, lines?: number, dropped?: number): void
  appendErr(line: string): void
  /** 配置里的相对路径 → 绝对路径 */
  resolveConfigPath(v: string): string
}

/** 建 `/api/speak` handler（handler 内所有依赖都通过参数显式取得，不再读宿主闭包） */
export function createSpeakHandler(deps: SpeakHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { config, repoRoot, isTrusted, noteSpeak, appendErr, resolveConfigPath } = deps

  return async function handleSpeak(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, obj: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (!isTrusted(req)) {
      json(403, { error: 'forbidden' })
      return
    }
    let body = ''
    let size = 0
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size <= MAX_BODY) body += chunk
      }
    } catch {
      // 客户端中断（ECONNRESET/aborted）：迭代器会 reject，吞掉并结束该请求
      json(400, { error: 'request aborted' })
      return
    }
    if (size > MAX_BODY) {
      json(413, { error: 'payload too large' })
      return
    }
    let text = ''
    try {
      const parsed = JSON.parse(body || '{}') as { text?: unknown; budget?: unknown; units?: unknown; lines?: unknown }
      text = String(parsed.text ?? '').slice(0, MAX_TEXT_CHARS)
      const budget = Number(parsed.budget)
      const units = Number(parsed.units)
      const lines = Number(parsed.lines)
      if (text) noteSpeak(
        text,
        Number.isFinite(budget) && budget > 0 ? budget : undefined,
        Number.isFinite(units) && units > 0 ? units : undefined,
        Number.isFinite(lines) && lines > 0 ? lines : undefined,
      )
    } catch { // body 不是合法 JSON → 400
      json(400, { error: 'invalid json' })
      return
    }
    if (!text) {
      json(400, { error: 'empty text' })
      return
    }
    // 朗读文本清理：URL/路径/命令→可朗读说法、符号→读音、Markdown→剥。
    // 必须在**合成之前**做：GPT-SoVITS 前端会把非汉字字符整段删掉，残句太短时 AR 会自由发挥
    // （实测 URL 被念成"秒每每.米每每毫秒减减"、命令被念成"施行三批耳门斗都行啦" ）。
    const speak = toSpeakable(normalizeSpeakText(text))
    if (speak.dropped) {
      // 没有可朗读内容（纯符号 / 纯语气词）：**宁可不出声**，也不让模型吐怪音。
      // 返回 204 让面板当作"本段无需朗读"处理，而不是当成失败重试。
      appendErr('[nori-pet] speak skipped（无可朗读内容）: ' + text.slice(0, 60))
      res.writeHead(204, { 'content-type': 'application/json' })
      res.end()
      return
    }
    // TTS 配置以 nori.config.json 为运行时真相（注入器热重载不重读该文件，这里请求时即时读取，
    // 改 refAudio/refPrompt/温度/top_k 无需重载插件即生效）
    const fileCfg: Record<string, unknown> = {}
    try {
      Object.assign(fileCfg, JSON.parse(readFileSync(join(repoRoot, 'nori.config.json'), 'utf8')))
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
      json(503, { error: 'tts url invalid', ttsUrl: String(tts.ttsUrl) })
      return
    }
    url.searchParams.set('text', speak.text)
    url.searchParams.set('text_lang', 'zh')
    url.searchParams.set('prompt_lang', 'zh')
    url.searchParams.set('media_type', 'wav')
    url.searchParams.set('temperature', String(tts.ttsTemperature))
    url.searchParams.set('top_k', String(tts.ttsTopK))
    url.searchParams.set('speed_factor', String(tts.ttsSpeedFactor))
    // ref 兜底：配置未设 refAudio 时回退到插件自带 voice/nori.wav（否则上游 400 → /speak 502 静音）
    const refPath = tts.refAudio ? resolveConfigPath(tts.refAudio) : join(repoRoot, 'voice', 'nori.wav')
    if (existsSync(refPath)) url.searchParams.set('ref_audio_path', refPath)
    if (tts.refPrompt) url.searchParams.set('prompt_text', tts.refPrompt)
    try {
      // 上游偶发推理 400（GPT-SoVITS Windows 热路径偶发 "tts failed"）：对 4xx/5xx 单次重试
      const deadline = Date.now() + TOTAL_BUDGET_MS
      let lastStatus = 0
      let upBody = ''
      let buf: Buffer | null = null
      let ct = 'audio/wav'
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0 && Date.now() > deadline) break // 预算耗尽就别再打一次上游
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS)
        let r: Response
        try {
          r = await fetch(url, { signal: ctrl.signal })
        } catch (e) {
          clearTimeout(timer)
          throw e
        }
        lastStatus = r.status
        if (r.ok) {
          // 超时定时器必须覆盖到响应体读完：上游"先回头再卡住流"时 await arrayBuffer 会永不返回，
          // 面板 pumping 永久占用 → 之后所有朗读排队卡死（用户观感"桌宠哑了"）。
          // 注意：竞速的**败方**定时器必须显式清掉，否则每次成功合成都留下一个 30s 定时器
          //（事件循环多挂 30s、也是被测出来的：单测进程会跟着空转到定时器触发）。
          let bodyTimer: ReturnType<typeof setTimeout> | undefined
          try {
            buf = Buffer.from(await Promise.race([
              r.arrayBuffer(),
              new Promise<never>((_, rej) => {
                bodyTimer = setTimeout(() => {
                  try { ctrl.abort() } catch { /* ignore */ }
                  rej(new Error('tts response body timeout'))
                }, UPSTREAM_TIMEOUT_MS)
              }),
            ]))
          } finally {
            if (bodyTimer) clearTimeout(bodyTimer)
          }
          clearTimeout(timer)
          ct = r.headers.get('content-type') || 'audio/wav'
          break
        }
        clearTimeout(timer)
        upBody = (await r.text()).slice(0, 200)
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      }
      if (!buf) {
        // TTS 失败此前只回前端气泡、不落任何日志 → 线上"没声音"完全不可观测
        appendErr('[nori-pet] tts http ' + lastStatus + ' ref=' + refPath + ' upstream=' + upBody.slice(0, 120))
        json(502, { error: 'tts http ' + lastStatus, ref: !!tts.refAudio, refPath, upstream: upBody })
        return
      }
      // 安全网：最长连续语音 >3.5s 判定为 AR 采样循环拖长（"嗯/唔"等鼻音叹词偶发），
      // 用更高随机性参数（0.95/15）重生成替换，最多 3 次；仅当结果更短才采用。
      let guardLoops = 0
      while (buf && maxContiguousSpeech(buf) > LOOP_SPEECH_SEC && guardLoops < LOOP_REGEN_MAX && Date.now() < deadline) {
        guardLoops++
        const warm = new URL(url)
        warm.searchParams.set('temperature', '0.95')
        warm.searchParams.set('top_k', '15')
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS)
        try {
          const w = await fetch(warm, { signal: ctrl.signal })
          if (w.ok) {
            const nb = Buffer.from(await w.arrayBuffer())
            clearTimeout(timer)
            if (maxContiguousSpeech(nb) <= maxContiguousSpeech(buf)) buf = nb
            else break
          } else { clearTimeout(timer); break }
        } catch { // 拖长重生是尽力而为：这次重生失败就保留上一版音频
          break
        } finally {
          clearTimeout(timer)
        }
      }
      res.writeHead(200, { 'content-type': ct, 'content-length': buf.length, 'cache-control': 'no-store' })
      res.end(buf)
    } catch (e) { // 上游合成失败 → 503（前端据此区分 sovits 未上线 / 超时）
      json(503, { error: 'tts offline: ' + String((e as Error)?.message ?? e).slice(0, 120) })
    }
  }
}
