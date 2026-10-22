/**
 * 音频播放：解码 → 起播 → RMS 驱动口型 → 结束/被打断收尾。
 *
 * 从 src/client/widget.ts 搬出。这段的坑不在"能不能响"，而在**收尾**：
 *  1) 每个 await 之后都要重新校验 `token`（被打断/换 turn 时立即放弃），否则旧音频会在
 *     新 turn 已经开播之后突然冒出来；
 *  2) 结束或被作废时必须把口型**交还**（onMouth(-1)），否则嘴会永远张着；
 *  3) `currentSrc` 要在 onended 里比对后清空 —— 直接清会把新一句的句柄误伤成 null。
 *
 * AudioContext 通过 deps 注入，node 里用假上下文就能测完整生命周期。
 */
import { mouthFromWaveform, playbackDone } from './lipSync.js'

export interface AudioSourceLike {
  buffer: unknown
  connect: (node: unknown) => void
  disconnect: () => void
  start: () => void
  onended: (() => void) | null
}

export interface AnalyserLike {
  fftSize: number
  connect: (node: unknown) => void
  getByteTimeDomainData: (arr: Uint8Array) => void
}

export interface AudioBufferLike { duration: number }

export interface AudioCtxLike {
  resume: () => Promise<void>
  decodeAudioData: (buf: ArrayBuffer) => Promise<AudioBufferLike>
  createBufferSource: () => AudioSourceLike
  createAnalyser: () => AnalyserLike
  destination: unknown
}

export interface PlaybackDeps {
  getCtx: () => AudioCtxLike
  isMuted: () => boolean
  /** 当前播放令牌：async 之后必须重新比对 */
  currentToken: () => number
  /** 口型目标值（-1 = 交还给表情/呼吸） */
  onMouth: (v: number) => void
  /** 当前音频源变化（widget 用来在打断时 stop 掉） */
  onSourceChange: (src: AudioSourceLike | null) => void
  /** requestAnimationFrame（注入以便测试同步驱动） */
  raf: (fn: () => void) => void
  now: () => number
}

export interface Playback {
  /** 播放一段已合成的音频；播放完、被打断或静音时 resolve（不会 reject） */
  play: (buf: ArrayBuffer, token: number) => Promise<void>
}

export function createPlayback(deps: PlaybackDeps): Playback {
  const stale = (token: number): boolean => token !== deps.currentToken() || deps.isMuted()

  return {
    play: (buf: ArrayBuffer, token: number): Promise<void> => new Promise((resolve) => {
      void (async () => {
        if (stale(token)) { resolve(); return }
        const ctx = deps.getCtx()
        // 自动播放策略：suspended 时静默尝试恢复（解锁引导由"睡着等首次点击"完成）
        try { await ctx.resume() } catch { /* 恢复失败就按静音处理，下一次手势会解锁 */ }
        if (stale(token)) { resolve(); return }

        const audio = await ctx.decodeAudioData(buf)
        if (stale(token)) { resolve(); return }

        const src = ctx.createBufferSource()
        src.buffer = audio
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        src.connect(analyser)
        analyser.connect(ctx.destination)
        deps.onSourceChange(src)

        const data = new Uint8Array(analyser.fftSize)
        const start = deps.now()
        const loop = (): void => {
          if (token !== deps.currentToken()) { deps.onMouth(-1); return }
          if (playbackDone(deps.now() - start, audio.duration * 1000)) { deps.onMouth(-1); return }
          analyser.getByteTimeDomainData(data)
          deps.onMouth(mouthFromWaveform(data))
          deps.raf(loop)
        }
        loop()

        src.onended = (): void => {
          deps.onMouth(-1)
          deps.onSourceChange(null)
          src.disconnect()
          resolve()
        }
        src.start()
      })()
    }),
  }
}
