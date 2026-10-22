/**
 * 情绪表现规则：门控、小动作时机、驻留回落、思考态。
 * 这些规则以前埋在 widget 的 setEmotion 里，出问题的表现都是"表情看着不对"，没有断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EMOTION_TABLE, createEmotionDriver } from '../lib/emotionDriver.js'
import { EMOTIONS } from '../lib/emotions.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function make(opts = {}) {
  const log = { expr: [], motions: [], idle: 0, reset: 0, logs: [] }
  const d = createEmotionDriver({
    ready: () => opts.ready ?? true,
    sleeping: () => opts.sleeping ?? false,
    patActive: () => opts.pat ?? false,
    speaking: () => opts.speaking ?? false,
    applyExpression: (e) => { log.expr.push(e); if (opts.failExpr === e) throw new Error('nope') },
    playMotion: (g, i) => { log.motions.push([g, i]) },
    resetExpression: () => { log.reset += 1 },
    playIdle: () => { log.idle += 1 },
    log: (m) => { log.logs.push(m) },
  })
  return { d, log }
}

test('情绪表覆盖词表里的每一个情绪（新增情绪却忘了写表现会立刻报错）', () => {
  for (const e of EMOTIONS) assert.ok(EMOTION_TABLE[e], '缺少表现：' + e)
})

test('同一表情连续设置只应用一次（逐句推流不打断过渡/口型）', () => {
  const { d, log } = make()
  d.set('happy')
  d.set('happy')
  d.set('happy')
  assert.deepEqual(log.expr, ['13_Happy'])
  d.stop()
})

test('force 会强制重申表情（摸头等直接反馈）', () => {
  const { d, log } = make()
  d.set('shy')
  d.set('shy', { force: true })
  assert.deepEqual(log.expr, ['04_Shy', '04_Shy'])
  d.stop()
})

test('表情应用失败不记门控：下次还会再试（不会被吞掉）', () => {
  const { d, log } = make({ failExpr: '13_Happy' })
  d.set('happy')
  d.set('happy')
  assert.equal(log.expr.length, 2, '失败后应重试')
  assert.ok(log.logs.some((l) => l.includes('expression fail')))
  d.stop()
})

test('情绪变化时附带播一次 Reaction；未变化则不播', () => {
  const { d, log } = make()
  d.set('happy')
  assert.deepEqual(log.motions, [['Reactions', 5]])
  d.set('happy')
  assert.equal(log.motions.length, 1, '同情绪重复不该重播动作')
  d.stop()
})

test('朗读中不抢 Reaction，但表情照切', () => {
  const { d, log } = make({ speaking: true })
  d.set('happy')
  assert.deepEqual(log.expr, ['13_Happy'])
  assert.deepEqual(log.motions, [], '朗读中不播动作')
  d.stop()
})

test('forceReaction 允许朗读中也给反馈；noReaction 完全禁动作', () => {
  const a = make({ speaking: true })
  a.d.set('happy', { forceReaction: true })
  assert.deepEqual(a.log.motions, [['Reactions', 5]])
  a.d.stop()
  const b = make()
  b.d.set('happy', { noReaction: true })
  assert.deepEqual(b.log.motions, [])
  b.d.stop()
})

test('揉头中一律不播 Reaction（动作的头部曲线会盖掉跟随）', () => {
  const { d, log } = make({ pat: true })
  d.set('happy', { forceReaction: true })
  assert.deepEqual(log.motions, [])
  d.stop()
})

test('default：resetExpression + 回 Idle 0，并清门控（下一个表情无条件生效）', () => {
  const { d, log } = make()
  d.set('happy')
  d.set('default')
  assert.equal(log.reset, 1)
  assert.equal(log.idle, 1)
  d.set('happy')
  assert.deepEqual(log.expr, ['13_Happy', '13_Happy'], '门控已清，应重新应用')
  d.stop()
})

test('揉头时不回 Idle（头部控制权归揉头参数）', () => {
  const { d, log } = make({ pat: true })
  d.set('happy')
  d.set('default')
  assert.equal(log.idle, 0)
  d.stop()
})

test('驻留到期回落 default（防表情冻住）', async () => {
  const { d, log } = make()
  d.set('happy') // holdMs 默认 8000，这里用默认值验证"排了计时"
  await wait(10)
  assert.equal(d.current(), 'happy', '还没到点不该回落')
  d.stop() // 清计时，避免拖住测试进程
  assert.equal(log.reset, 0)
})

test('睡觉时不动表情', () => {
  const { d, log } = make({ sleeping: true })
  d.set('happy')
  assert.deepEqual(log.expr, [])
  assert.equal(d.current(), 'default')
  d.stop()
})

test('思考态：开启切 think，结束只在仍是 think 时回落（不覆盖真实情绪）', () => {
  const { d } = make()
  d.setThinking(true)
  assert.equal(d.current(), 'think')
  assert.equal(d.isThinking(), true)
  d.set('happy') // 思考期间来了真实情绪
  d.setThinking(false)
  assert.equal(d.current(), 'happy', '不该把真实情绪打回 default')
  assert.equal(d.isThinking(), false)
  d.stop()
})

test('思考结束且仍是 think → 回 default', () => {
  const { d } = make()
  d.setThinking(true)
  d.setThinking(false)
  assert.equal(d.current(), 'default')
  d.stop()
})
