/**
 * WAV 波形分析（纯函数，零依赖）。
 *
 * 唯一用途：给 TTS 结果做"拖长"体检。GPT-SoVITS 的 AR 模型在"嗯/唔"这类鼻音叹词上偶发
 * 采样循环——某个字无限拖长（实测 >3.5s 不间断有声），听感就是"卡住/电音"。检测手段不能靠
 * 时长（正常长句也长），必须看**连续有声段的长度**。
 *
 * 从 index.ts 搬出：这里曾是全仓唯一"纯逻辑但无法单测"的代码（因为它活在宿主的闭包里）。
 * 行为由 scripts/test-wav-ws.mjs 锁定（含 8/16/32bit、单/双声道、奇数块补齐等真实形态）。
 */

/** 每帧时长（秒）：100ms 足够分辨"拖长"，又不会被音节内的静音切碎 */
export const FRAME_SEC = 0.1
/** 判定"有声"的 RMS 门限：实测 TTS 静音的 RMS 约 1e-3，正常语音 >0.05 */
export const VOICE_RMS = 0.01

/** 解析 WAV（RIFF/WAVE，PCM 8/16/32 位，单/双声道），返回每 100ms 帧的 RMS 能量数组（失败返回 []） */
export function wavFrameRms(buf: Buffer): number[] {
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
    const frameN = Math.max(1, Math.floor(sampleRate * FRAME_SEC))
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
  } catch { // WAV 非法或被截断 → 无帧数据（调用方按无长音处理，不阻断播报）
    return []
  }
}

/** 最长连续语音时长（秒）。GPT-SoVITS AR 采样循环（如"嗯/唔"鼻音拖长）会形成 >3.5s 不间断长音 */
export function maxContiguousSpeech(buf: Buffer): number {
  const rms = wavFrameRms(buf)
  if (!rms.length) return 0
  let mx = 0
  let cur = 0
  for (const r of rms) {
    cur = r > VOICE_RMS ? cur + 1 : 0
    if (cur > mx) mx = cur
  }
  return mx * FRAME_SEC
}
