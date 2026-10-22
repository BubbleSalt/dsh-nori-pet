#!/usr/bin/env node
/**
 * 投喂幂等回归：同一块内容被投喂多次时，不得重复播报。
 * node scripts/test-stream-feed-dedup.mjs
 *
 * 用例全部来自真实 trace（2026-10-22，用户报"连续改写两次"）：
 *   IN: 明智的选择。…别推荐半天你买不到。明智的选择。…别推荐半天你买不到。      ← 整块 ×2
 *   IN: 连续改写两次是之前修过的问题（…）。先取证，不猜：连续改写两次是之前修过的问题（…）。
 *   IN: 我来查 DSH 的启动耗时。 ／ 先找它的日志和启动链路。 ／ 我来查 DSH 的启动耗时。先找它的日志和启动链路。
 *
 * 与既有 test-stream-dedup.mjs 的区别：那个测"同一份 delta 只走一条播报路径"（分支互斥），
 * 这个测"同一块内容被投喂两次时只播一次"（投喂幂等）——是更上游的一层。
 * 本测试直接 import 宿主的 src/streamFeed.ts 编译产物，**不是镜像实现**（镜像实现会随源码漂移而失真）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyBlockEnd, applyTextDelta, blockKey, clearFeedByPrefix } from '../lib/streamFeed.js'

/** 把一串投喂动作跑成"实际播出去的文本"（模拟 pushChunk 的追加语义） */
function run(actions) {
  const state = new Map()
  let fed = ''
  const ctx = { dup: 0 }
  for (const a of actions) {
    if (a.kind === 'delta') {
      fed += applyTextDelta(state, a.key, a.text)
    } else {
      const r = applyBlockEnd(state, a.key, a.text)
      fed += r.delta
      if (r.dup) ctx.dup += 1
    }
  }
  return { fed, dup: ctx.dup, state }
}

const K = (i = 0) => blockKey('s1', 7, 2, i)

test('★ 整块被重复投递两次 → 只播一遍（实测 trace: 明智的选择…×2）', () => {
  const X = '明智的选择。这游戏最核心的体验是法庭辩论加强密推理，但满足这个体验的游戏一大把。'
  const { fed, dup } = run([
    { kind: 'block', key: K(0), text: X },
    { kind: 'block', key: K(0), text: X },
  ])
  assert.equal(fed, X, '第二次整块投递必须完全不播')
  assert.equal(dup, 1, '应当被判定为重复投喂并计数')
})

test('★ 先增量后整块全文（text-delta + block-end 重叠）→ 不重复', () => {
  const A = '我来查 DSH 的启动耗时。'
  const B = '先找它的日志和启动链路。'
  const { fed } = run([
    { kind: 'delta', key: K(0), text: A },
    { kind: 'delta', key: K(0), text: B },
    { kind: 'block', key: K(0), text: A + B }, // block-end 带整块全文
  ])
  assert.equal(fed, A + B)
})

test('★ 增量已到一部分时，整块全文只补剩余那截', () => {
  const full = '断句改成按标点切分后，长句的停顿位置就正常了。'
  const { fed } = run([
    { kind: 'delta', key: K(0), text: '断句改成按标点切分后，' },
    { kind: 'block', key: K(0), text: full },
  ])
  assert.equal(fed, full, '不能出现"前半 + 全文"')
})

test('★ 两个块各播一次后，整段重复投喂 → 不再整段重播（实测 trace: A / B / A+B）', () => {
  const A = '我来查 DSH 的启动耗时。'
  const B = '先找它的日志和启动链路。'
  const { fed } = run([
    { kind: 'block', key: K(0), text: A },
    { kind: 'block', key: K(1), text: B },
    { kind: 'block', key: K(0), text: A }, // 重试又送了一遍块 0
    { kind: 'block', key: K(1), text: B },
  ])
  assert.equal(fed, A + B, '同一块即使换时间投喂也只播一次')
})

test('正常情况不受影响：不同块、块内正常重复都照原样播', () => {
  const { fed } = run([
    { kind: 'block', key: K(0), text: '哈哈哈，好的好的。' },
    { kind: 'block', key: K(1), text: '这一点很重要哦。' },
  ])
  assert.equal(fed, '哈哈哈，好的好的。这一点很重要哦。', '块内的正常重复（哈哈哈/好的好的）不许被误删')
})

test('块内容增长（快照语义）→ 只播新增部分', () => {
  const { fed } = run([
    { kind: 'block', key: K(0), text: '第一步' },
    { kind: 'block', key: K(0), text: '第一步，第二步' },
  ])
  assert.equal(fed, '第一步，第二步')
})

test('重试产出了不同文本（关系不明）→ 按新内容整块播，不吞内容', () => {
  const { fed } = run([
    { kind: 'block', key: K(0), text: '旧的尝试结果。' },
    { kind: 'block', key: K(0), text: '重试后的另一个结果。' },
  ])
  assert.equal(fed, '旧的尝试结果。重试后的另一个结果。')
})

test('回退型快照（新文本是已有内容的前缀）→ 不播，避免倒退', () => {
  const { fed, dup } = run([
    { kind: 'block', key: K(0), text: '完整的一句话。' },
    { kind: 'block', key: K(0), text: '完整' },
  ])
  assert.equal(fed, '完整的一句话。')
  assert.equal(dup, 1)
})

test('turn 结束时回收水位（防无界增长）', () => {
  const state = new Map()
  applyBlockEnd(state, blockKey('s9', 3, 0, 0), 'a')
  applyBlockEnd(state, blockKey('s9', 3, 1, 0), 'b')
  applyBlockEnd(state, blockKey('s9', 4, 0, 0), 'c')
  assert.equal(state.size, 3)
  const n = clearFeedByPrefix(state, 's9/3/')
  assert.equal(n, 2)
  assert.equal(state.size, 1, '其它 turn 的水位不受影响')
})
