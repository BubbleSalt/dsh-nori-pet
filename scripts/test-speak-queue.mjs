/**
 * 朗读队列：打断 / 追加 / 优先插入 —— 这三条策略此前只能靠"盯着桌宠听"验证。
 * 搬成 createSpeakQueue(deps) 之后，排队决策可以在这里逐条钉死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpeakQueue } from '../lib/speakQueue.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * 受控队列：speakOne 每次都会挂在 gate 上，测试自己决定"这句读完了"，
 * 从而能稳定复现"正在朗读时又来了新文本"这种真实时序。
 */
function makeQueue(opts = {}) {
  const calls = { spoke: [], prewarmed: [], stopped: 0, bubbles: [], previews: [], logs: [] }
  const gate = []
  let token = 1
  const q = createSpeakQueue({
    speakOne: async (text) => {
      calls.spoke.push(text)
      if (opts.hold) await new Promise((res) => gate.push(res))
    },
    prewarm: async (unit) => { calls.prewarmed.push(unit) },
    hasCached: (unit) => (opts.cached ?? []).includes(unit),
    currentToken: () => token,
    bumpToken: () => { token += 1 },
    stopCurrent: () => { calls.stopped += 1 },
    isMuted: () => !!opts.muted,
    wake: () => {},
    onDropped: (units) => { calls.bubbles.push(...units) },
    onPreview: (u) => { calls.previews.push(u) },
    log: (m) => { calls.logs.push(m) },
  })
  /** 放行一句 + 让微任务跑完 */
  const step = async () => {
    const r = gate.shift()
    if (r) r()
    await tick()
    await tick()
  }
  return { q, calls, token: () => token, step }
}

test('append：排队不打断（token 不变），按序朗读', async () => {
  const { q, calls, token } = makeQueue()
  const t0 = token()
  q.append('第一段')
  q.append('第二段')
  await q.drain()
  assert.deepEqual(calls.spoke, ['第一段', '第二段'])
  assert.equal(token(), t0, 'append 不该作废在途播放')
  assert.equal(calls.stopped, 0)
})

test('interrupt：未读句子改气泡（可以没听到，但不能既听不到又看不到）', async () => {
  const { q, calls, step } = makeQueue({ hold: true })
  q.append('正在读的这句很长')
  await tick()
  q.append('还没读的第二句')
  q.append('还没读的第三句')
  await tick()
  q.interrupt('新 turn 的第一句')
  await step()
  assert.deepEqual(calls.bubbles, ['还没读的第二句', '还没读的第三句'])
  assert.equal(q.dropped(), 2)
  assert.ok(calls.logs.some((l) => l.includes('改以气泡呈现')))
})

test('interrupt：首句未缓存 → 先预合成再切（不先掐断再等好几秒）', async () => {
  const { q, calls } = makeQueue({ cached: [] })
  q.interrupt('【happy】马上就要说的这句')
  await q.drain()
  assert.equal(calls.prewarmed.length, 1, '打断前应先预合成首句')
  assert.equal(calls.prewarmed[0], '马上就要说的这句', '缓存键是剥掉情绪标签后的句首单元')
})

test('interrupt：首句已缓存 → 直接切，不重复合成', async () => {
  const { q, calls } = makeQueue({ cached: ['马上就要说的这句'] })
  q.interrupt('【happy】马上就要说的这句')
  await q.drain()
  assert.deepEqual(calls.prewarmed, [], '命中缓存不该再发合成请求')
})

test('priority：抢到队首，但保留剩余等待文本（摸头台词不截断后文）', async () => {
  const { q, calls, step } = makeQueue({ hold: true })
  q.append('正在读')
  await tick()
  q.append('后面还有一句')
  await tick()
  q.priority('摸头台词')
  assert.equal(calls.stopped, 1, '优先插入要停掉当前音频')
  await step() // 放行"正在读"
  assert.equal(calls.spoke[1], '摸头台词', '插队到队首')
  await step() // 放行"摸头台词"
  assert.equal(calls.spoke[2], '后面还有一句', '剩余队列必须保留')
})

test('静音：append 只出气泡不合成', async () => {
  const { q, calls } = makeQueue({ muted: true })
  q.append('静音时这句话只该出现在气泡里')
  await q.drain()
  assert.deepEqual(calls.spoke, [])
  assert.deepEqual(calls.previews, ['静音时这句话只该出现在气泡里'])
})

test('重复朗读取证：同一段文本第二次入队会记一条 REPEAT', async () => {
  const { q, calls } = makeQueue()
  q.append('同一段话')
  await q.drain()
  q.append('同一段话')
  await q.drain()
  assert.equal(calls.logs.filter((l) => l.includes('REPEAT PLAY detect')).length, 1)
})

test('busy：有在途朗读或排队时为真（睡觉计时器据此让路）', async () => {
  const { q, step } = makeQueue({ hold: true })
  assert.equal(q.busy(), false)
  q.append('正在读')
  await tick()
  assert.equal(q.busy(), true)
  await step()
  assert.equal(q.busy(), false)
})
