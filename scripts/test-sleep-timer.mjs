/**
 * 入睡计时器：几条规则以前只能靠盯着桌宠才发现被违反 —— 这里逐条钉住。
 *
 * 注意：goSleep 发现"忙"时会**重新排计时**（播完再从头算），所以每个用例结束时都要 stop()，
 * 否则挂着的计时器会一直重排。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSleepTimer } from '../lib/sleepTimer.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function make(opts = {}) {
  const calls = { slept: 0, woke: [] }
  let ready = opts.ready ?? true
  let busy = opts.busy ?? false
  const t = createSleepTimer({
    sleepAfterMs: 30,
    canSleep: () => ready && !busy,
    onSleep: () => { calls.slept += 1 },
    onWake: (was) => { calls.woke.push(was) },
  })
  return { t, calls, setReady: (v) => { ready = v }, setBusy: (v) => { busy = v } }
}

test('空闲到点就睡', async () => {
  const { t, calls } = make()
  t.reset()
  await wait(60)
  t.stop()
  assert.equal(calls.slept, 1)
  assert.equal(t.isSleeping(), true)
})

test('turn 活跃期间不入睡（回答还在推流，桌宠不能先睡）', async () => {
  const { t, calls } = make()
  t.setTurnActive(true)
  t.reset()
  await wait(60)
  assert.equal(calls.slept, 0, 'turn 活跃时不排入睡计时')
  t.setTurnActive(false)
  t.reset()
  await wait(60)
  t.stop()
  assert.equal(calls.slept, 1, 'turn 结束后重新计时才睡')
})

test('朗读中不入睡：到点发现忙 → 重新计时而不是硬睡', async () => {
  const { t, calls, setBusy } = make({ busy: true })
  t.reset()
  await wait(60)
  assert.equal(calls.slept, 0)
  assert.equal(t.isSleeping(), false, '忙的时候绝不能置睡眠态')
  setBusy(false) // 读完 → 下一次重排自然入睡
  await wait(60)
  t.stop()
  assert.equal(calls.slept, 1)
})

test('模型没加载好也不睡（不播空转的睡姿）', async () => {
  const { t, calls, setReady } = make({ ready: false })
  t.reset()
  await wait(60)
  assert.equal(calls.slept, 0)
  setReady(true)
  await wait(60)
  t.stop()
  assert.equal(calls.slept, 1)
})

test('唤醒：真醒标记 wasSleeping=true', async () => {
  const { t, calls } = make()
  t.reset()
  await wait(60)
  assert.equal(t.isSleeping(), true)
  t.wake()
  t.stop()
  assert.equal(t.isSleeping(), false)
  assert.deepEqual(calls.woke, [true])
})

test('未睡时的唤醒是「假醒防御」：onWake(false)', async () => {
  const { t, calls } = make()
  t.wake()
  t.stop()
  assert.deepEqual(calls.woke, [false])
  assert.equal(t.isSleeping(), false)
})

test('反复 reset 不会睡（有交互就一直不睡）', async () => {
  const { t, calls } = make()
  for (let i = 0; i < 4; i++) { t.reset(); await wait(15) }
  t.stop()
  assert.equal(calls.slept, 0)
})
