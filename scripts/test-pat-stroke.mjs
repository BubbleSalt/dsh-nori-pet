/**
 * 摸头触发判定：按住时长、拖动距离、冷却、头部跟随归一化。
 * 以前这三条规则写在指针事件回调里，只能靠手真的去揉桌宠验证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPatDetector, inHeadZone, HEAD_ZONE, PAT_REPLIES } from '../lib/patStroke.js'

test('头部区域：命中中心、边界内，画布下半部不算头', () => {
  assert.equal(inHeadZone(0.5, 0.2), true)
  assert.equal(inHeadZone(HEAD_ZONE.x0, HEAD_ZONE.y1), true, '左上边界也算')
  assert.equal(inHeadZone(HEAD_ZONE.x1, HEAD_ZONE.y1), true, '右上边界也算')
  assert.equal(inHeadZone(0.1, 0.2), false, '左边太远')
  assert.equal(inHeadZone(0.9, 0.2), false, '右边太远')
  assert.equal(inHeadZone(0.5, 0.6), false, '身体不是头')
})

test('按住够久但没拖动 → 不触发（防止点一下就叫）', () => {
  const p = createPatDetector()
  p.start(0, 100, 100)
  const r = p.move(0.5, 0.3, 100, 100, 2500) // 2.5s 原地
  assert.equal(r.speaks, false)
})

test('拖动够远但按得不久 → 不触发', () => {
  const p = createPatDetector()
  p.start(0, 100, 100)
  const r = p.move(0.5, 0.3, 140, 100, 500) // 0.5s 内拖 40px
  assert.equal(r.speaks, false)
})

test('按住 ≥2s 且拖动 ≥20px → 触发一次', () => {
  const p = createPatDetector()
  p.start(0, 100, 100)
  const r = p.move(0.5, 0.3, 100, 130, 2100) // 2.1s，拖 30px
  assert.equal(r.speaks, true)
})

test('同一次按住内不重复触发（松手才算一次）', () => {
  const p = createPatDetector()
  p.start(0, 100, 100)
  assert.equal(p.move(0.5, 0.3, 100, 130, 2100).speaks, true)
  assert.equal(p.move(0.5, 0.3, 100, 160, 2400).speaks, false)
  assert.equal(p.move(0.5, 0.3, 100, 190, 2700).speaks, false)
})

test('冷却期（6s）：再揉只跟随不说话', () => {
  const p = createPatDetector()
  p.start(0, 100, 100)
  assert.equal(p.move(0.5, 0.3, 100, 130, 2100).speaks, true)
  p.end()
  p.start(3000, 100, 100)
  const r = p.move(0.7, 0.3, 100, 130, 5100) // 距上次触发 3s，仍在 6s 冷却内
  assert.equal(r.speaks, false)
  assert.ok(Math.abs(r.headX - 0.4) < 1e-9, '头部跟随不能被冷却吞掉')
})

test('冷却结束后再揉会重新触发', () => {
  const p = createPatDetector()
  p.start(0, 100, 100)
  assert.equal(p.move(0.5, 0.3, 100, 130, 2100).speaks, true)
  p.end()
  p.start(8000, 100, 100)
  assert.equal(p.move(0.5, 0.3, 100, 130, 10100).speaks, true)
})

test('头部跟随量归一化到 -1..1（鼠标拖出画布也不越界）', () => {
  const p = createPatDetector()
  p.start(0, 0, 0)
  assert.equal(p.move(2.5, -3, 0, 0, 0).headX, 1)
  assert.equal(p.move(-4, 2.5, 0, 0, 0).headY, 1)
  assert.equal(p.move(-4, -9, 0, 0, 0).headX, -1)
  const mid = p.move(0.5, 0.5, 0, 0, 0)
  assert.equal(mid.headX, 0)
  assert.equal(mid.headY, 0)
})

test('台词表：11 条、情绪都合法、文本非空', () => {
  assert.equal(PAT_REPLIES.length, 11)
  for (const r of PAT_REPLIES) {
    assert.ok(r.text.length > 0)
    assert.equal(typeof r.emo, 'string')
  }
})
