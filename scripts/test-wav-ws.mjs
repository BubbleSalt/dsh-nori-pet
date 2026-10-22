#!/usr/bin/env node
/**
 * WAV 波形分析 + WebSocket 帧编解码的单测。
 *
 * 这两块原先活在 src/index.ts 的宿主闭包里，是全仓唯一"纯逻辑但没有单测"的代码：
 *   · wavFrameRms 曾有两个真实 bug（8bit 读成 `& 0xff - 128` 抹平负半周、32bit 按 float 读），
 *     当时只能靠"听出来电音"发现；
 *   · parseFrame/encodeFrame 决定推送能不能到达浏览器，坏了就是整条播报链路静默。
 * 搬到 src/wav.ts、src/ws.ts 之后，这里把行为钉死（含 125/126/127 三种长度形态）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wavFrameRms, maxContiguousSpeech, FRAME_SEC } from '../lib/wav.js'
import { encodeFrame, parseFrame, acceptKey } from '../lib/ws.js'

/** 造一个最小合法的 WAV：单/双声道、8/16/32bit 整型 PCM */
function makeWav({ bits = 16, channels = 1, sampleRate = 8000, seconds = 0.3, amp = 0, extra = '' } = {}) {
  const frames = Math.round(sampleRate * seconds)
  const bytesPer = bits / 8
  const dataLen = frames * bytesPer * channels
  const fmtLen = 16
  const extraBuf = extra ? Buffer.from(extra, 'ascii') : Buffer.alloc(0)
  const buf = Buffer.alloc(12 + 8 + fmtLen + (extraBuf.length ? 8 + extraBuf.length + (extraBuf.length % 2) : 0) + 8 + dataLen)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(buf.length - 8, 4)
  buf.write('WAVE', 8, 'ascii')
  let off = 12
  buf.write('fmt ', off, 'ascii')
  buf.writeUInt32LE(fmtLen, off + 4)
  buf.writeUInt16LE(1, off + 8) // PCM
  buf.writeUInt16LE(channels, off + 10)
  buf.writeUInt32LE(sampleRate, off + 12)
  buf.writeUInt32LE(sampleRate * bytesPer * channels, off + 16)
  buf.writeUInt16LE(bytesPer * channels, off + 20)
  buf.writeUInt16LE(bits, off + 22)
  off += 8 + fmtLen
  if (extraBuf.length) {
    buf.write('LIST', off, 'ascii')
    buf.writeUInt32LE(extraBuf.length, off + 4)
    extraBuf.copy(buf, off + 8)
    off += 8 + extraBuf.length + (extraBuf.length % 2)
  }
  buf.write('data', off, 'ascii')
  buf.writeUInt32LE(dataLen, off + 4)
  const dataOff = off + 8
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (f * channels + c) * bytesPer
      if (bits === 16) buf.writeInt16LE(amp, p)
      else if (bits === 8) buf.writeUInt8(128 + Math.round((amp / 32768) * 127), p)
      else buf.writeInt32LE(amp * 65536, p)
    }
  }
  return buf
}

test('非 WAV / 过短缓冲区 → 空数组（不抛）', () => {
  assert.deepEqual(wavFrameRms(Buffer.alloc(0)), [])
  assert.deepEqual(wavFrameRms(Buffer.from('this is not a wav file at all, just text bytes')), [])
  assert.deepEqual(wavFrameRms(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64)])), [])
})

test('16bit 单声道静音 → 每帧 RMS 为 0；满幅方波 → 接近 1', () => {
  assert.deepEqual(wavFrameRms(makeWav({ seconds: 0.3 })), [0, 0, 0])
  const loud = wavFrameRms(makeWav({ seconds: 0.3, amp: 32767 }))
  assert.equal(loud.length, 3)
  for (const r of loud) assert.ok(Math.abs(r - 1) < 0.001, `rms=${r}`)
})

test('8bit 无符号 PCM：静音=128 → 0；正半周读到正值（曾因 & 优先级抹平负半周）', () => {
  assert.deepEqual(wavFrameRms(makeWav({ bits: 8, seconds: 0.2 })), [0, 0])
  const r = wavFrameRms(makeWav({ bits: 8, seconds: 0.2, amp: 32767 }))[0]
  assert.ok(r > 0.9 && r <= 1, `rms=${r}`)
})

test('32bit 整型 PCM 按整型读（旧代码按 float 读 → 垃圾值）', () => {
  const r = wavFrameRms(makeWav({ bits: 32, seconds: 0.2, amp: 32767 }))[0]
  assert.ok(r > 0.9 && r <= 1, `rms=${r}`)
})

test('双声道：帧长按 声道数 折算，不会把立体声当成两倍时长', () => {
  const frames = wavFrameRms(makeWav({ channels: 2, seconds: 0.3 }))
  assert.equal(frames.length, 3)
})

test('跳过未知 chunk（含奇数长度补齐）后仍能定位 data', () => {
  const wav = makeWav({ seconds: 0.3, amp: 20000, extra: 'abcdefg' }) // 7 字节 → 需补齐 1 字节
  const rms = wavFrameRms(wav)
  assert.equal(rms.length, 3)
  assert.ok(rms[0] > 0)
})

test('maxContiguousSpeech：静音 0 秒 / 连续有声按 100ms 帧累计', () => {
  assert.equal(maxContiguousSpeech(makeWav({ seconds: 1 })), 0)
  assert.equal(FRAME_SEC, 0.1)
  assert.equal(maxContiguousSpeech(makeWav({ seconds: 1, amp: 20000 })), 1)
  assert.equal(maxContiguousSpeech(makeWav({ seconds: 3.5, amp: 20000, sampleRate: 24000 })), 3.5)
  assert.equal(maxContiguousSpeech(Buffer.alloc(0)), 0)
})

test('encodeFrame：125/126/127 三种长度形态的头字节与长度字段', () => {
  const small = encodeFrame('hi')
  assert.deepEqual([...small.subarray(0, 2)], [0x81, 2])
  assert.equal(small.subarray(2).toString(), 'hi')

  const mid = encodeFrame('x'.repeat(200))
  assert.deepEqual([...mid.subarray(0, 2)], [0x81, 126])
  assert.equal(mid.readUInt16BE(2), 200)

  const big = encodeFrame('y'.repeat(70000))
  assert.deepEqual([...big.subarray(0, 2)], [0x81, 127])
  assert.equal(big.readUInt32BE(2), 0) // 高 32 位
  assert.equal(big.readUInt32BE(6), 70000) // 低 32 位
})

test('encodeFrame：opcode 可指定（close=8 / pong=0xa）', () => {
  assert.equal(encodeFrame(Buffer.alloc(0), 8)[0], 0x88)
  assert.equal(encodeFrame('p', 0xa)[0], 0x8a)
})

test('parseFrame：缓冲区不完整时返回 null（等更多字节）', () => {
  assert.equal(parseFrame(Buffer.alloc(0)), null)
  assert.equal(parseFrame(Buffer.from([0x81])), null)
  assert.equal(parseFrame(Buffer.from([0x81, 126, 0x00])), null)
  const f = encodeFrame('abc')
  assert.equal(parseFrame(f.subarray(0, 4)), null) // 头齐了、payload 差一字节
})

test('parseFrame：服务端帧（无 mask）原样取出 payload 与 consumed', () => {
  const f = encodeFrame('hello')
  const p = parseFrame(f)
  assert.equal(p.opcode, 1)
  assert.equal(p.payload.toString(), 'hello')
  assert.equal(p.consumed, f.length)
})

test('parseFrame：客户端帧（带 mask）解掩码；与 encodeFrame 往返一致', () => {
  const text = JSON.stringify({ type: 'hello', sessionId: '' })
  const payload = Buffer.from(text, 'utf8')
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked])
  const p = parseFrame(frame)
  assert.equal(p.payload.toString(), text)
  assert.equal(p.consumed, frame.length)
})

test('parseFrame：ping 帧（0x9）与 16 位长度客户端帧', () => {
  const ping = encodeFrame('p', 0x9)
  assert.equal(parseFrame(ping).opcode, 0x9)

  const payload = Buffer.alloc(300, 7)
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | 126, 0x01, 0x2c]), mask, masked])
  const p = parseFrame(frame)
  assert.equal(p.payload.length, 300)
  assert.equal(p.consumed, frame.length)
})

test('parseFrame：fin 标志（分片消息靠它判定收齐）', () => {
  // 0x81 = FIN=1 文本帧；0x01 = FIN=0 文本起始帧；0x00 = FIN=0 续帧
  assert.equal(parseFrame(encodeFrame('done')).fin, true, 'encodeFrame 总是打 FIN=1')
  assert.equal(parseFrame(Buffer.from([0x01, 0x02, 0x61, 0x62])).fin, false, 'FIN=0 起始帧')
  assert.equal(parseFrame(Buffer.from([0x00, 0x02, 0x63, 0x64])).fin, false, 'FIN=0 续帧')
  assert.equal(parseFrame(Buffer.from([0x80, 0x02, 0x65, 0x66])).fin, true, 'FIN=1 续帧')
})

test('acceptKey：RFC 6455 §1.3 官方示例向量', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})
