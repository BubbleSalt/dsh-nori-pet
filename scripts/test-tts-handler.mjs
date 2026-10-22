#!/usr/bin/env node
/**
 * `/api/speak` 代理的单测（node scripts/test-tts-handler.mjs）。
 *
 * 这段逻辑原先埋在宿主闭包里，只能靠"对着真 GPT-SoVITS 听声音"验证：
 * 403/413/204/502 这些分支、以及"拖长自动重生"的成功路径，全都没有任何自动覆盖。
 * 抽成 createSpeakHandler(deps) 之后，注入假 fetch 即可把每条分支钉死。
 *
 * 覆盖：来源校验 403 / 体超限 413 / 非法 JSON 400 / 无可朗读内容 204 /
 *      上游 5xx 单次重试后 502（并落日志）/ ttsUrl 非法 503 /
 *      正常 200 透传 WAV / 连续有声 >3.5s 触发高温重生并采用更短的那条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpeakHandler, normalizeSpeakText } from '../lib/tts.js'

/** 造最小合法 WAV：16bit 单声道、指定时长与幅度（振幅 0 = 静音） */
function wav(seconds, amp = 0, sampleRate = 8000) {
  const frames = Math.round(sampleRate * seconds)
  const dataLen = frames * 2
  const buf = Buffer.alloc(44 + dataLen)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataLen, 40)
  for (let i = 0; i < frames; i++) buf.writeInt16LE(amp, 44 + i * 2)
  return buf
}

function fakeReq(bodyObj, { trusted = true, raw = null } = {}) {
  const payload = raw ?? Buffer.from(JSON.stringify(bodyObj), 'utf8')
  return {
    trusted,
    headers: { origin: 'http://127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < payload.length; i += 7) yield payload.subarray(i, i + 7)
    },
  }
}

function fakeRes() {
  const out = { status: 0, headers: null, body: null, ended: false }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(b) { out.ended = true; if (b !== undefined) out.body = b },
  }
}

const CONFIG = {
  ttsUrl: 'http://127.0.0.1:9880/tts',
  refAudio: '',
  refPrompt: '你好,初次见面,我的名字是Nori',
  ttsTemperature: 0.9,
  ttsTopK: 12,
  ttsSpeedFactor: 1,
}

function makeHandler({ config = CONFIG, fetchImpl } = {}) {
  const seen = { speaks: [], errs: [] }
  const dir = mkdtempSync(join(tmpdir(), 'nori-tts-')) // 无 nori.config.json → 走注入配置
  const handler = createSpeakHandler({
    config,
    repoRoot: dir,
    isTrusted: (req) => req.trusted !== false,
    noteSpeak: (...args) => seen.speaks.push(args),
    appendErr: (l) => seen.errs.push(l),
    resolveConfigPath: (v) => v,
  })
  return { handler, seen, dir, fetchImpl }
}

/** 假上游响应 */
const fakeResponse = ({ status = 200, body = Buffer.alloc(0), text = '', ct = 'audio/wav' }) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) },
  async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) },
  async text() { return text },
})

test('来源不可信 → 403，且不发起上游请求', async () => {
  const { handler, dir } = makeHandler()
  let called = 0
  globalThis.fetch = async () => { called += 1; return fakeResponse({}) }
  try {
    const res = fakeRes()
    await handler(fakeReq({ text: '你好' }, { trusted: false }), res)
    assert.equal(res.out.status, 403)
    assert.equal(called, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('非法 JSON → 400；空 text → 400', async () => {
  const { handler, dir } = makeHandler()
  try {
    let res = fakeRes()
    await handler(fakeReq(null, { raw: Buffer.from('{not json') }), res)
    assert.equal(res.out.status, 400)
    res = fakeRes()
    await handler(fakeReq({ text: '' }), res)
    assert.equal(res.out.status, 400)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('请求体超 16KB → 413', async () => {
  const { handler, dir } = makeHandler()
  try {
    const res = fakeRes()
    await handler(fakeReq(null, { raw: Buffer.alloc(17 * 1024, 0x61) }), res)
    assert.equal(res.out.status, 413)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('没有可朗读内容 → 204（不合成、不重试，且不落 error 日志以外的动作）', async () => {
  const { handler, seen, dir } = makeHandler()
  let called = 0
  globalThis.fetch = async () => { called += 1; return fakeResponse({}) }
  try {
    const res = fakeRes()
    await handler(fakeReq({ text: '。。。' }), res)
    assert.equal(res.out.status, 204)
    assert.equal(called, 0, '204 绝不能打上游')
    assert.equal(seen.speaks.length, 1, '取证环仍要记一笔')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('上游连续 5xx → 重试一次后 502，并落错误日志（线上"没声音"可观测）', async () => {
  const { handler, seen, dir } = makeHandler()
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return fakeResponse({ status: 500, text: 'tts failed' }) }
  try {
    const res = fakeRes()
    await handler(fakeReq({ text: '这是一句正常的话' }), res)
    assert.equal(res.out.status, 502)
    assert.equal(calls, 2, '4xx/5xx 应单次重试（共 2 次上游调用）')
    assert.ok(seen.errs.some((l) => l.includes('tts http 500')), seen.errs.join('|'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ttsUrl 缺协议头 → 503（曾因此 unhandledRejection 打死整台 dsh）', async () => {
  const { handler, seen, dir } = makeHandler({ config: { ...CONFIG, ttsUrl: '127.0.0.1:9880/tts' } })
  try {
    const res = fakeRes()
    await handler(fakeReq({ text: '正常文本' }), res)
    assert.equal(res.out.status, 503)
    assert.ok(seen.errs.some((l) => l.includes('ttsUrl 非法')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('正常合成 → 200 + audio/wav 透传字节，且带上 ref 路径与推理参数', async () => {
  const { handler, dir } = makeHandler()
  const audio = wav(0.5, 12000)
  const urls = []
  globalThis.fetch = async (u) => { urls.push(String(u)); return fakeResponse({ body: audio }) }
  try {
    const res = fakeRes()
    await handler(fakeReq({ text: '今天天气不错，出门走走吧' }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.headers['content-type'], 'audio/wav')
    assert.equal(res.out.headers['content-length'], audio.length)
    assert.ok(Buffer.compare(res.out.body, audio) === 0, '字节必须原样透传')
    assert.ok(urls[0].includes('temperature=0.9') && urls[0].includes('top_k=12'), urls[0])
    assert.ok(urls[0].includes('media_type=wav') && urls[0].includes('text_lang=zh'), urls[0])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('连续有声 >3.5s → 高参数重生一次，采用更短的结果', async () => {
  const { handler, dir } = makeHandler()
  const long = wav(6, 20000) // 6 秒不间断有声 → 触发拖长判定
  const short = wav(1, 20000)
  const urls = []
  globalThis.fetch = async (u) => {
    urls.push(String(u))
    return fakeResponse({ body: urls.length === 1 ? long : short })
  }
  try {
    const res = fakeRes()
    await handler(fakeReq({ text: '这一句话故意写得长一点，用来触发拖长重生' }), res)
    assert.equal(res.out.status, 200)
    assert.equal(urls.length, 2, '应触发一次高温重生')
    assert.ok(urls[1].includes('temperature=0.95') && urls[1].includes('top_k=15'), urls[1])
    assert.equal(res.out.body.length, short.length, '采用更短的那条')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('normalizeSpeakText：补句号、中英混排补逗号、剥情绪标签与反引号', () => {
  assert.equal(normalizeSpeakText('正常中文'), '正常中文。')
  assert.equal(normalizeSpeakText('我先看 index.ts'), '我先看，index.ts。')
  assert.equal(normalizeSpeakText('【happy】好耶'), '好耶。')
  assert.equal(normalizeSpeakText('`code` 在此'), 'code 在此。')
  assert.equal(normalizeSpeakText('已经有句号了。'), '已经有句号了。')
})
