/**
 * TTS 客户端：合成缓存 + 单句请求。
 *
 * 从 src/client/widget.ts 搬出。这里的两条规矩都是踩过坑换来的，注释必须跟着走：
 *  1) **必须给超时**。fetch 永不返回时这句的 Promise 会挂死，而播报是串行队列 —— 一句卡住
 *     整条队列，用户观感是"桌宠哑了、之后再也不说话"。
 *  2) 错误要**分得清**：204 = 宿主判定这段没有可朗读内容（纯符号/语气词，硬送合成 AR 会吐
 *     怪音）；503 = sovits 未上线；TimeoutError = 服务端太慢还在跑。三种给用户看的话术不同。
 *
 * 缓存的作用不只是省一次合成：打断时"先预合成新首句再切旧音频"靠它命中，才能做到无缝衔接。
 */
import { SPEAK_MAX } from './segmentation.js'

export interface TtsClientDeps {
  /** 宿主前缀（PREFIX） */
  basePath: string
  /** 每句"汉字宽"预算 */
  budget?: number
  /** 该文本占多少汉字宽（上报给宿主核对断句） */
  unitsOf: (text: string) => number
  /** 气泡最近一次实际占了几行（真机反馈，上报后可在 /api/status 核对预算） */
  lines: () => number
  /** 本轮被打断丢弃（改气泡）的条数 */
  dropped: () => number
  /** 当前播放令牌：返回时比对，过期结果丢弃（但仍然入缓存） */
  currentToken: () => number
  /** 给用户看的气泡提示（sovits 未上线 / 超时 / 未就绪） */
  onNotice: (msg: string) => void
  fetchImpl?: typeof fetch
  timeoutMs?: number
  log?: (msg: string) => void
}

export interface TtsClient {
  /** 合成一句（命中缓存直接返回；被打断/失败返回 null） */
  get: (text: string, token: number) => Promise<ArrayBuffer | null>
  has: (text: string) => boolean
  size: () => number
}

const CACHE_MAX = 16
export const DEFAULT_TIMEOUT_MS = 60000

export function createTtsClient(deps: TtsClientDeps): TtsClient {
  const doFetch = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const budget = deps.budget ?? SPEAK_MAX
  const cache = new Map<string, ArrayBuffer>()

  function put(text: string, buf: ArrayBuffer): void {
    if (cache.size >= CACHE_MAX) {
      const first = cache.keys().next().value
      if (first !== undefined) cache.delete(first)
    }
    cache.set(text, buf)
  }

  async function get(text: string, token: number): Promise<ArrayBuffer | null> {
    // ⚠ 必须返回**副本**：decodeAudioData 会把传入的 ArrayBuffer 转移掉（detach），
    // 缓存里那份若被直接交出去，同一句第二次播放就拿到 detached buffer →
    // Chrome 抛 "DataCloneError: Cannot decode detached ArrayBuffer"（实测踩到）
    const hit = cache.get(text)
    if (hit) return token === deps.currentToken() ? hit.slice(0) : null
    try {
      const res = await doFetch(deps.basePath + '/api/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          text,
          budget,
          units: deps.unitsOf(text),
          lines: deps.lines(),
          dropped: deps.dropped(),
        }),
      })
      // 204 = 没有可朗读内容 → 静默跳过：不弹气泡、不重试、不缓存
      if (res.status === 204) return null
      if (res.status === 503) { deps.onNotice('（sovits 未上线）'); return null }
      if (!res.ok) { deps.onNotice('（TTS 未就绪：' + res.status + '）'); return null }
      const buf = await res.arrayBuffer()
      put(text, buf.slice(0)) // 缓存留底（不交出原实例），打断时预合成的结果下次直接命中
      return token === deps.currentToken() ? buf : null
    } catch (e: any) {
      // 超时与"连不上"要分开说：前者是服务端还（在跑），后者是 sovits 没起来
      deps.onNotice(e?.name === 'TimeoutError' ? '（TTS 超时）' : '（sovits 未上线）')
      deps.log?.('[nori-pet] tts failed: ' + String(e?.message ?? e))
      return null
    }
  }

  return { get, has: (text: string) => cache.has(text), size: () => cache.size }
}
