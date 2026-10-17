#!/usr/bin/env node
/**
 * 跨代定时器清理测试：node scripts/test-timer-cleanup.mjs
 *
 * 真实踩坑（用户听到同一段被播两遍）：插件的播报定时器（攒批 flush / 无句失声兜底）
 * **从不在 fiber dispose 时清理**。热重载后旧代 fiber 的 setTimeout 回调仍会触发，
 * 带着它那一代的 batchText 再走一遍 flushBatch → 同一段文字被投递第二次、被改写播报两遍。
 *
 * 契约：dispose 之后，本代排下的定时器一律不得再执行（宁可少播，也不重复播）。
 * 本测试用假定时器复刻插件里的两个定时器 + 清理钩子，断言 dispose 后回调不再触发。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 最小假定时器：手动推进时间，便于断言"推进后有没有触发" */
function fakeClock() {
  let now = 0
  let seq = 0
  const pending = new Map()
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(id) { pending.delete(id) },
    tick(ms) {
      now += ms
      for (const [id, t] of [...pending]) {
        if (t.at <= now) { pending.delete(id); t.fn() }
      }
    },
    get size() { return pending.size },
  }
}

/**
 * 与 src/index.ts 同构：一个攒批定时器 + 一组按 key 的无句兜底定时器，
 * 外加 dispose 钩子（就是本次修复加上的那段清理）。
 */
function makePlugin(clock, onFlush) {
  let batchText = ''
  let batchTimer = null
  const restFlushTimers = new Map()
  const genTimers = new Set()
  const flushBatch = () => { batchTimer = null; if (batchText.trim()) onFlush(batchText.trim()) }
  return {
    add(text) {
      batchText += text
      if (batchTimer) clock.clearTimeout(batchTimer)
      batchTimer = clock.setTimeout(flushBatch, 1200)
    },
    armRest(key) {
      const old = restFlushTimers.get(key)
      if (old) clock.clearTimeout(old)
      restFlushTimers.set(key, clock.setTimeout(() => {
        restFlushTimers.delete(key)
        onFlush('(rest)' + key)
      }, 2000))
    },
    /** 统一入口：稍后要做的事都登记进 genTimers（概括等待上限这类一次性回调） */
    later(fn, ms) {
      const id = clock.setTimeout(() => { genTimers.delete(id); fn() }, ms)
      genTimers.add(id)
      return id
    },
    /** dispose 钩子：本次修复的核心 */
    dispose() {
      if (batchTimer) { clock.clearTimeout(batchTimer); batchTimer = null }
      for (const t of restFlushTimers.values()) clock.clearTimeout(t)
      restFlushTimers.clear()
      for (const t of genTimers) clock.clearTimeout(t)
      genTimers.clear()
    },
  }
}

test('dispose 后攒批定时器不再触发（修复前会重复投递）', () => {
  const clock = fakeClock()
  const flushed = []
  const oldGen = makePlugin(clock, (t) => flushed.push('old:' + t))
  oldGen.add('同一段文字')
  assert.equal(clock.size, 1, '应排下一个攒批定时器')

  // 模拟热重载：旧代 dispose，新代接管
  oldGen.dispose()
  const newGen = makePlugin(clock, (t) => flushed.push('new:' + t))
  newGen.add('新一段文字')

  clock.tick(5000)
  assert.deepEqual(flushed, ['new:新一段文字'], '旧代回调不得再执行: ' + JSON.stringify(flushed))
})

test('不 dispose 时确实会重复（证明用例有效，不是空测）', () => {
  const clock = fakeClock()
  const flushed = []
  const oldGen = makePlugin(clock, (t) => flushed.push('old:' + t))
  oldGen.add('同一段文字')
  // 故意不 dispose（复刻修复前）
  const newGen = makePlugin(clock, (t) => flushed.push('new:' + t))
  newGen.add('同一段文字')
  clock.tick(5000)
  assert.equal(flushed.length, 2, '两代各自触发 = 同一段被投递两次')
})

test('dispose 清掉无句失声兜底定时器', () => {
  const clock = fakeClock()
  const flushed = []
  const gen = makePlugin(clock, (t) => flushed.push(t))
  gen.armRest('sid/1/0')
  assert.equal(clock.size, 1)
  gen.dispose()
  assert.equal(clock.size, 0, 'dispose 后不应残留定时器')
  clock.tick(10000)
  assert.deepEqual(flushed, [], '兜底回调不应执行')
})

test('dispose 后同 key 重新排定时器仍正常工作', () => {
  const clock = fakeClock()
  const flushed = []
  const p = makePlugin(clock, (t) => flushed.push(t))
  p.armRest('k')
  p.dispose()
  p.armRest('k')
  clock.tick(3000)
  assert.deepEqual(flushed, ['(rest)k'])
})

test('统一登记表 later()：dispose 后不再触发（概括等待上限这类回调）', () => {
  const clock = fakeClock()
  const fired = []
  const gen = makePlugin(clock, () => {})
  gen.later(() => fired.push('fallback'), 8000)
  assert.equal(clock.size, 1, 'later 应排下一个定时器')
  gen.dispose()
  assert.equal(clock.size, 0, 'dispose 应清掉 later 登记的定时器')
  clock.tick(20000)
  assert.deepEqual(fired, [], '跨代不得再触发兜底播报（否则同一段被播两遍）')
})

test('later() 正常触发后自动从登记表摘除（不泄漏）', () => {
  const clock = fakeClock()
  const fired = []
  const gen = makePlugin(clock, () => {})
  gen.later(() => fired.push('once'), 1000)
  clock.tick(1500)
  assert.deepEqual(fired, ['once'])
  assert.equal(clock.size, 0)
  gen.dispose()
  assert.equal(clock.size, 0)
})
