/**
 * 口型：把一段时域波形换算成嘴巴张开度。
 *
 * 从 src/client/widget.ts 的播放循环里搬出（原来内联在 requestAnimationFrame 里，不可测）。
 * 两条经验值都保留原样，改动前先想想"口型跟不上/一直大张着嘴"的观感：
 *  - 用 RMS（均方根）而不是峰值：峰值会让每个音节都顶满；
 *  - 增益 ×7：实测这个倍数下日语/中文音节的口型起伏最自然。
 */
export function mouthFromWaveform(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0
  let sum = 0
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] - 128) / 128
    sum += v * v
  }
  return Math.min(1, Math.sqrt(sum / bytes.length) * 7)
}

/** 播放是否已经过了音频时长（rAF 循环的收尾判定） */
export function playbackDone(elapsedMs: number, durationMs: number): boolean {
  return elapsedMs >= durationMs
}
