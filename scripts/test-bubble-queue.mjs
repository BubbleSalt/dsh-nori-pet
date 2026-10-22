/**
 * 气泡队列：独立淡出、同屏上限、行数回报。
 * 以前这三条混在 DOM 操作里，只能靠"盯着屏幕看气泡是不是堆住了"验证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBubbleQueue } from '../lib/bubbleQueue.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function make(opts = {}) {
  const log = []
  const q = createBubbleQueue({
    mount: (text) => { const el = { text, cls: [] }; log.push(['mount', text]); return el },
    fade: (el) => { el.cls.push('fading'); log.push(['fade', el.text]) },
    remove: (el) => log.push(['remove', el.text]),
    measureLines: opts.lines ?? (() => 2),
    retag: (el, text) => { el.text = text; log.push(['retag', text]) },
    onLines: opts.onLines,
    maxBubbles: opts.max ?? 6,
    lifeMs: opts.life ?? 40,
    fadeMs: opts.fadeDelay ?? 10,
  })
  return { q, log }
}

test('每条气泡独立计时：先出现的先淡出，不被后来的重置', async () => {
  const { q, log } = make({ life: 40 })
  q.show('第一句')
  await wait(25)
  q.show('第二句')
  await wait(25) // 第一句到点，第二句还没到
  assert.deepEqual(log.filter((e) => e[0] === 'fade').map((e) => e[1]), ['第一句'])
  await wait(30)
  assert.deepEqual(log.filter((e) => e[0] === 'fade').map((e) => e[1]), ['第一句', '第二句'])
})

test('淡出后要等动画结束才移除（不闪一下消失）', async () => {
  const { q, log } = make({ life: 20, fadeDelay: 30 })
  q.show('一句话')
  await wait(30)
  assert.equal(log.some((e) => e[0] === 'remove'), false, '淡出中不该立刻移除')
  await wait(40)
  assert.deepEqual(log.filter((e) => e[0] === 'remove').map((e) => e[1]), ['一句话'])
  assert.equal(q.count(), 0)
})

test('同屏上限：第 7 条进来时挤掉最旧的那条', () => {
  const { q, log } = make({ max: 6, life: 1000 })
  for (let i = 0; i < 7; i++) q.show('第' + i)
  assert.deepEqual(log.filter((e) => e[0] === 'remove').map((e) => e[1]), ['第0'])
  assert.equal(q.count(), 6)
})

test('检测占几行并回报（断句预算只能靠这个真机信号核对）', () => {
  const got = []
  const { q } = make({ lines: () => 3, onLines: (n) => got.push(n) })
  q.show('一行很长很长的话')
  assert.deepEqual(got, [3])
})

test('量不出行数时不回报（DOM 未布局等），不抛错', () => {
  const got = []
  const { q } = make({ lines: () => null, onLines: (n) => got.push(n) })
  q.show('x')
  assert.deepEqual(got, [])
})

test('clear：清掉所有气泡且不再有后续淡出动作', async () => {
  const { q, log } = make({ life: 20, fadeDelay: 10 })
  q.show('a')
  q.show('b')
  q.clear()
  assert.equal(q.count(), 0)
  assert.equal(log.filter((e) => e[0] === 'remove').length, 2)
  await wait(40)
  assert.equal(log.filter((e) => e[0] === 'fade').length, 0, 'clear 后计时器不该再触发')
})

test('retag：合成失败时把气泡改成"（没读出来）"，别让它看着像正常播报', () => {
  const { q, log } = make({ life: 1000 })
  const el = q.show('这句话没有合成出来')
  q.retag(el, '这句话没有合成出来（没读出来）')
  assert.equal(el.text, '这句话没有合成出来（没读出来）')
  assert.deepEqual(log.filter((e) => e[0] === 'retag').length, 1)
})
