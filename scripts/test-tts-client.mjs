/**
 * TTS 客户端：超时、204/503/超时三种话术、缓存命中与逐出 —— 这些规则以前埋在 widget.ts 里，
 * 只能靠"桌宠哑了"这种症状反向推断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTtsClient } from '../lib/ttsClient.js'

function makeClient(opts = {}) {
  const calls = { urls: [], bodies: [], notices: [], logs: [] }
  let token = 1
  const res = opts.responses ?? []
  const client = createTtsClient({
    basePath: '/@bubblesalt/dsh-nori-pet',
    unitsOf: (t) => t.length,
    lines: () => 2,
    dropped: () => 3,
    currentToken: () => token,
    onNotice: (m) => { calls.notices.push(m) },
    log: (m) => { calls.logs.push(m) },
    timeoutMs: 1234,
    fetchImpl: async (url, init) => {
      calls.urls.push(url)
      calls.bodies.push(JSON.parse(init.body))
      const r = res.shift()
      if (!r) throw new Error('no more fake responses')
      if (r instanceof Error) throw r
      return r
    },
  })
  return { client, calls, setToken: (t) => { token = t } }
}

const ok = (bytes) => ({ status: 200, ok: true, arrayBuffer: async () => bytes })
const status = (code) => ({ status: code, ok: code >= 200 && code < 300, arrayBuffer: async () => new ArrayBuffer(0) })

test('正常合成：返回音频、入缓存、上报 budget/units/lines/dropped', async () => {
  const buf = new ArrayBuffer(8)
  const { client, calls } = makeClient({ responses: [ok(buf)] })
  const out = await client.get('你好呀', 1)
  assert.equal(out, buf)
  assert.equal(client.has('你好呀'), true)
  assert.equal(calls.urls[0], '/@bubblesalt/dsh-nori-pet/api/speak')
  assert.deepEqual(calls.bodies[0], { text: '你好呀', budget: 34, units: 3, lines: 2, dropped: 3 })
})

test('缓存命中返回副本：decodeAudioData 会 detach 原 buffer，第二次播放不能拿到同一实例', async () => {
  const { client } = makeClient({ responses: [ok(new ArrayBuffer(8))] })
  const a = await client.get('同一句', 1)
  const b = await client.get('同一句', 1)
  assert.notEqual(a, b) // 两次取到的必须是不同实例
  structuredClone(a, { transfer: [a] }) // 模拟 decodeAudioData 的转移语义
  assert.equal(a.byteLength, 0) // a 已 detach
  assert.equal(b.byteLength, 8) // b 仍可用
})

test('缓存命中：不打第二次请求（打断前预合成就靠它无缝衔接）', async () => {
  const { client, calls } = makeClient({ responses: [ok(new ArrayBuffer(4))] })
  await client.get('同一句', 1)
  await client.get('同一句', 1)
  assert.equal(calls.urls.length, 1)
})

test('204：没有可朗读内容 → 静默跳过（不弹气泡、不缓存）', async () => {
  const { client, calls } = makeClient({ responses: [status(204)] })
  assert.equal(await client.get('……', 1), null)
  assert.deepEqual(calls.notices, [])
  assert.equal(client.has('……'), false)
})

test('503：提示 sovits 未上线（与超时区分开）', async () => {
  const { client, calls } = makeClient({ responses: [status(503)] })
  assert.equal(await client.get('你好', 1), null)
  assert.deepEqual(calls.notices, ['（sovits 未上线）'])
})

test('其它错误码：带上状态码，便于排障', async () => {
  const { client, calls } = makeClient({ responses: [status(500)] })
  assert.equal(await client.get('你好', 1), null)
  assert.deepEqual(calls.notices, ['（TTS 未就绪：500）'])
})

test('请求抛 TimeoutError：提示 TTS 超时（而不是"sovits 未上线"）', async () => {
  const err = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  const { client, calls } = makeClient({ responses: [err] })
  assert.equal(await client.get('你好', 1), null)
  assert.deepEqual(calls.notices, ['（TTS 超时）'])
  assert.equal(calls.logs.length, 1)
})

test('连不上：提示 sovits 未上线', async () => {
  const { client, calls } = makeClient({ responses: [new TypeError('fetch failed')] })
  assert.equal(await client.get('你好', 1), null)
  assert.deepEqual(calls.notices, ['（sovits 未上线）'])
})

test('已被打断（token 过期）：结果丢弃但仍入缓存（下一轮还能命中）', async () => {
  const buf = new ArrayBuffer(4)
  const { client, setToken } = makeClient({ responses: [ok(buf)] })
  setToken(2) // 请求途中被打断
  assert.equal(await client.get('这段话', 1), null)
  assert.equal(client.has('这段话'), true)
})

test('缓存上限 16：超了淘汰最旧的一条', async () => {
  const responses = Array.from({ length: 17 }, () => ok(new ArrayBuffer(2)))
  const { client } = makeClient({ responses })
  for (let i = 0; i < 17; i++) await client.get('句子' + i, 1)
  assert.equal(client.size(), 16)
  assert.equal(client.has('句子0'), false, '最旧的一条应被淘汰')
  assert.equal(client.has('句子16'), true)
})
