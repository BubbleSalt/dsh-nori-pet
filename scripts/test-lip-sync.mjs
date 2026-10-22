/**
 * 口型换算：RMS → 嘴巴张开度。原本内联在 rAF 循环里，没有任何覆盖，
 * 调错的表现是"口型跟不上"或"一直大张着嘴"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mouthFromWaveform, playbackDone } from '../lib/lipSync.js'

const silence = (n = 512) => new Uint8Array(n).fill(128)
/** 生成一个振幅 a（0..1）的方波字节帧 */
const square = (a, n = 512) => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = 128 + Math.round((i % 2 === 0 ? a : -a) * 127)
  return b
}

test('静音（全是 128）→ 嘴闭上', () => {
  assert.equal(mouthFromWaveform(silence()), 0)
})

test('空数组 → 0（不除零）', () => {
  assert.equal(mouthFromWaveform(new Uint8Array(0)), 0)
})

test('满幅方波 → 夹在 1（不会算出 7 这种离谱值）', () => {
  assert.equal(mouthFromWaveform(square(1)), 1)
})

test('振幅越大嘴张越大，且单调', () => {
  const a = mouthFromWaveform(square(0.1))
  const b = mouthFromWaveform(square(0.3))
  assert.ok(a > 0 && a < b, `expected 0 < ${a} < ${b}`)
  assert.ok(b <= 1)
})

test('用 RMS 而非峰值：单个尖峰不会把嘴顶满', () => {
  const spike = new Uint8Array(512).fill(128)
  spike[0] = 255
  // RMS = sqrt((127/128)^2/512) × 7 ≈ 0.307（实测值）：单个尖峰只让嘴张开三成，峰值法会直接顶满
  const v = mouthFromWaveform(spike)
  assert.ok(v > 0.2 && v < 0.4, '单个尖峰只该轻微微张嘴，实际 ' + v.toFixed(3))
  assert.ok(mouthFromWaveform(square(1)) - v > 0.5, '满幅波形必须明显大于单个尖峰')
})

test('播放收尾判定：到时长即为结束', () => {
  assert.equal(playbackDone(999, 1000), false)
  assert.equal(playbackDone(1000, 1000), true)
  assert.equal(playbackDone(1200, 1000), true)
})
