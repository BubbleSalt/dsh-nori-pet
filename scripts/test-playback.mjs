/**
 * 播放生命周期：token 作废、口型交还、句柄清理。
 * 以前这些收尾动作内联在 widget 的 rAF 循环里，"嘴张着不动""旧音频突然冒出来"都只能靠听和看。
 *
 * 注意：play() 只在"播完 / 被打断"时才 resolve，所以测试不能直接 await 它 ——
 * 用 flush() 把微任务推进到"已起播"，再由用例自己触发 onended 或改 token。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlayback } from '../lib/playback.js'

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve() }

function make(opts = {}) {
  const log = { mouth: [], sources: [], decoded: 0, started: 0, resumed: 0, disconnected: 0 }
  let token = opts.token ?? 1
  let muted = opts.muted ?? false
  let nowMs = 0
  const rafQueue = []
  const wave = opts.wave ?? (() => { const b = new Uint8Array(512).fill(128); for (let i = 0; i < 512; i++) b[i] = i % 2 ? 255 : 0; return b })

  const src = {
    buffer: null,
    connect: () => {},
    disconnect: () => { log.disconnected += 1 },
    start: () => { log.started += 1 },
    onended: null,
  }
  const analyser = {
    fftSize: 512,
    connect: () => {},
    getByteTimeDomainData: (arr) => { arr.set(wave()) },
  }
  const ctx = {
    resume: async () => { log.resumed += 1 },
    decodeAudioData: async () => { log.decoded += 1; return { duration: opts.duration ?? 1 } },
    createBufferSource: () => src,
    createAnalyser: () => analyser,
    destination: {},
  }
  const playback = createPlayback({
    getCtx: () => ctx,
    isMuted: () => muted,
    currentToken: () => token,
    onMouth: (v) => log.mouth.push(v),
    onSourceChange: (s) => log.sources.push(s),
    raf: (fn) => rafQueue.push(fn),
    now: () => nowMs,
  })
  const pump = (n = 3) => { for (let i = 0; i < n; i++) { const f = rafQueue.shift(); if (!f) break; f() } }
  const advance = (ms) => { nowMs += ms }
  return { playback, log, src, pump, advance, flush, setToken: (t) => { token = t }, setMuted: (m) => { muted = m } }
}

test('正常播放：驱动口型 → 结束时交还口型并清句柄', async () => {
  const { playback, log, src, pump, flush } = make()
  const p = playback.play(new ArrayBuffer(8), 1)
  await flush()
  assert.equal(log.decoded, 1)
  assert.equal(log.started, 1)
  pump(2)
  assert.ok(log.mouth.some((v) => v > 0.5), '有声音时嘴要张开')
  src.onended?.()
  await p
  assert.equal(log.mouth.at(-1), -1, '结束时必须把口型交还')
  assert.equal(log.sources.at(-1), null, '句柄要清空（避免打断时误伤新句）')
  assert.equal(log.disconnected, 1)
})

test('令牌已过期：不解码、不起播（旧 turn 的音频不能冒出来）', async () => {
  const { playback, log, setToken } = make()
  setToken(2)
  await playback.play(new ArrayBuffer(8), 1) // 直接 resolve
  assert.equal(log.decoded, 0)
  assert.equal(log.started, 0)
  assert.deepEqual(log.mouth, [])
})

test('静音：同样不解码不起播', async () => {
  const { playback, log, setMuted } = make()
  setMuted(true)
  await playback.play(new ArrayBuffer(8), 1)
  assert.equal(log.decoded, 0)
  assert.equal(log.started, 0)
})

test('播放中途被作废：下一帧就交还口型并停止驱动', async () => {
  const { playback, log, pump, flush, setToken } = make()
  void playback.play(new ArrayBuffer(8), 1)
  await flush()
  pump(1)
  const before = log.mouth.length
  setToken(2)
  pump(1)
  assert.equal(log.mouth.length, before + 1, '只该多出一次"交还"')
  assert.equal(log.mouth.at(-1), -1)
  pump(1)
  assert.equal(log.mouth.length, before + 1, '交还之后不再驱动口型')
})

test('时长到点：自动收尾（不依赖 onended 回调）', async () => {
  const { playback, log, pump, flush, advance } = make({ duration: 1 })
  void playback.play(new ArrayBuffer(8), 1)
  await flush()
  pump(1)
  advance(1500)
  pump(1)
  assert.equal(log.mouth.at(-1), -1)
})

test('suspended 的 AudioContext 会被静默恢复（不抛）', async () => {
  const { playback, log, flush } = make()
  void playback.play(new ArrayBuffer(8), 1)
  await flush()
  assert.equal(log.resumed, 1)
})
