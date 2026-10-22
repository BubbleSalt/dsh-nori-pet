/**
 * WebSocket 客户端：握手、后台不重连、退避重试上限、自愈 ensure。
 * 这几条以前埋在 widget 里，出问题的表现是"后台放一会儿回来，Nori 永远不说话了"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWsClient, WS_CONNECTING, WS_OPEN } from '../lib/wsClient.js'

function makeDeps(opts = {}) {
  const created = []
  const state = { hidden: false, connected: 0, errors: 0, sent: [], got: [], logs: [] }
  const client = createWsClient({
    url: () => 'ws://test/ws',
    create: (url) => {
      const ws = {
        url,
        readyState: WS_CONNECTING,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        sent: [],
        closed: false,
        send(d) { this.sent.push(d); state.sent.push(d) },
        close() { this.closed = true; this.readyState = 3 },
      }
      created.push(ws)
      return ws
    },
    hello: () => JSON.stringify({ type: 'hello' }),
    onMessage: (raw, reply) => { state.got.push(raw); reply(JSON.stringify({ type: 'ack' })) },
    isHidden: () => state.hidden,
    onConnectError: () => { state.errors += 1 },
    baseDelayMs: 1,
    maxDelayMs: 4,
    log: (m) => { state.logs.push(m) },
  })
  return { client, created, state }
}

const open = (ws) => { ws.readyState = WS_OPEN; ws.onopen?.() }
const tick = () => new Promise((r) => setTimeout(r, 20))

test('连接：onopen 发 hello 并把重试计数清零', () => {
  const { client, created, state } = makeDeps()
  client.connect()
  assert.equal(created.length, 1)
  open(created[0])
  assert.deepEqual(state.sent, [JSON.stringify({ type: 'hello' })])
  assert.equal(client.retries(), 0)
})

test('消息：转发原始字符串，回包走同一个连接（ack）', () => {
  const { client, created, state } = makeDeps()
  client.connect()
  open(created[0])
  created[0].onmessage?.({ data: '{"type":"assistant","text":"嗨"}' })
  assert.deepEqual(state.got, ['{"type":"assistant","text":"嗨"}'])
  assert.deepEqual(created[0].sent.at(-1), JSON.stringify({ type: 'ack' }))
})

test('reply 走同一个连接：传输层不关心内容语义', () => {
  const { client, created, state } = makeDeps()
  client.connect()
  open(created[0])
  created[0].onmessage?.({ data: 'weird-payload' })
  assert.deepEqual(state.got, ['weird-payload'], '原样交给上层判断')
  assert.equal(created[0].sent.length, 2, 'hello + reply')
})

test('前端连不上宿主：只提示一次，不乱抛', () => {
  const { client, state } = makeDeps()
  // 让 create 抛错
  const c2 = createWsClient({
    url: () => 'ws://test/ws',
    create: () => { throw new Error('boom') },
    hello: () => '{}',
    onMessage: () => {},
    isHidden: () => false,
    onConnectError: () => { state.errors += 1 },
    log: (m) => { state.logs.push(m) },
  })
  c2.connect()
  assert.equal(state.errors, 1)
  assert.equal(state.logs.length, 1)
  void client
})

test('断线：可见时按 1s×次数退避重连（这里用 1ms 基数验证次数）', async () => {
  const { client, created, state } = makeDeps()
  client.connect()
  open(created[0])
  created[0].onclose?.()
  await tick()
  assert.equal(created.length, 2, '应当自动重连一次')
  assert.equal(state.hidden, false)
})

test('断线：后台标签页不重连（省得一堆后台页反复撞宿主）', async () => {
  const { client, created, state } = makeDeps()
  client.connect()
  open(created[0])
  state.hidden = true
  created[0].onclose?.()
  await tick()
  assert.equal(created.length, 1, 'hidden 时不排重连')
})

test('断线重连有上限：到 10 次就停（不无限狂刷）', async () => {
  const { client, created } = makeDeps()
  client.connect()
  for (let i = 0; i < 15; i++) {
    const ws = created.at(-1)
    ws.readyState = WS_OPEN
    ws.onclose?.()
    await tick()
  }
  assert.ok(created.length <= 11, `重连次数应封顶，实际 ${created.length}`)
})

test('ensure：连接健康时不新建，断了才补（回前台/周期兜底用同一入口）', () => {
  const { client, created } = makeDeps()
  client.connect()
  open(created[0])
  client.ensure()
  assert.equal(created.length, 1, 'OPEN 时 ensure 不该新建连接')
  created[0].readyState = 3
  created[0].onclose?.()
  client.ensure()
  assert.ok(created.length >= 2, '断了的连接会被 ensure 补上')
})

test('stop：主动停用后不再重连', async () => {
  const { client, created } = makeDeps()
  client.connect()
  open(created[0])
  client.stop()
  created[0].onclose?.()
  await tick()
  assert.equal(created.length, 1)
})
