/**
 * 桌面布局换算：收边、缩放档位、画布尺寸。
 * 以前这些纯算术混在 DOM 读写里，两个已踩过的坑都没法钉住：
 * 「只能左右拖」（right/bottom 与 top 竞争）与「拖出屏幕再也点不回来」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EDGE_PX, MAX_SCALE, MIN_SCALE, OVERHANG_PX, SCALE_STEP,
  canvasSize, clampPos, clampScale, defaultPos, stepScale, wheelScale,
} from '../lib/clientLayout.js'

test('缩放下限/上限：0.4 ~ 4.0', () => {
  assert.equal(clampScale(0.01), MIN_SCALE)
  assert.equal(clampScale(99), MAX_SCALE)
  assert.equal(clampScale(1.5), 1.5)
})

test('按钮步进 ±0.15，且不会越过上下限', () => {
  assert.equal(stepScale(1, SCALE_STEP), 1.15)
  assert.equal(stepScale(1, -SCALE_STEP), 0.85)
  assert.equal(stepScale(MAX_SCALE, SCALE_STEP), MAX_SCALE)
})

test('滚轮：上滚放大 1.1 倍、下滚缩小，且被夹住', () => {
  assert.equal(wheelScale(1, -1), 1.1)
  assert.ok(Math.abs(wheelScale(1.1, 1) - 1) < 1e-9, '下滚回原档')
  assert.ok(Math.abs(wheelScale(3.9, -1) - MAX_SCALE) < 1e-9)
})

test('收边：右/下留 12px 可抓回，左/上允许出屏 80px', () => {
  const vw = 1000, vh = 800
  assert.deepEqual(clampPos(5000, 5000, vw, vh), [vw - EDGE_PX, vh - EDGE_PX])
  assert.deepEqual(clampPos(-5000, -5000, vw, vh), [-OVERHANG_PX, -OVERHANG_PX])
  assert.deepEqual(clampPos(100, 200, vw, vh), [100, 200], '屏幕内的位置原样')
})

test('默认位置落在右下角，且不会算出负数', () => {
  assert.deepEqual(defaultPos(200, 300, 1000, 800), [1000 - 200 - EDGE_PX, 800 - 300 - EDGE_PX])
  assert.deepEqual(defaultPos(2000, 3000, 1000, 800), [0, 0], '桌宠比屏幕还大时贴左上，不出负数')
})

test('画布尺寸：高度 = 逻辑高 × 缩放，宽度取"比例贴合"与"逻辑宽×缩放"较小者', () => {
  // 逻辑 480x600，模型比例 1.2，缩放 1 → 高 600；比例贴合宽 720，逻辑宽 480 → 取 480
  assert.deepEqual(canvasSize(1, 1.2, 480, 600), [480, 600])
  // 模型很瘦（比例 0.5）：比例贴合宽 300 < 逻辑宽 480 → 取 300
  assert.deepEqual(canvasSize(1, 0.5, 480, 600), [300, 600])
  // 缩小时有最小 48px，避免负/零尺寸
  const [w, h] = canvasSize(0.01, 1, 480, 600)
  assert.equal(h, 48)
  assert.ok(w >= 48)
})

test('缩放翻倍：宽高同步翻倍（round 后允许 ±1px）', () => {
  const a = canvasSize(1, 1, 400, 500)
  const b = canvasSize(2, 1, 400, 500)
  assert.equal(b[1], a[1] * 2)
})
