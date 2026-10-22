/**
 * turn 路由：一条 assistant 文本该排队还是打断。
 *
 * 这条判定曾经藏在 widget 的 WebSocket 回调里，出错的表现是"最后一句凭空消失"：
 * 改写路径给数字 turn `12`、概括路径给字符串 `12-sum`，只认数字时概括那批拿到 null
 * → 落到打断分支 → 正在读的句子被腰斩、队列里剩下的句子作废。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { planAssistantRoute } from '../lib/turns.js'

test('没有 turn 身份：打断（无从判断是不是同一轮）', () => {
  assert.deepEqual(planAssistantRoute('12', null), { base: null, action: 'interrupt' })
  assert.deepEqual(planAssistantRoute('12', undefined), { base: null, action: 'interrupt' })
})

test('首条带 turn：排队（不该抢断自己）', () => {
  assert.deepEqual(planAssistantRoute(null, 12), { base: '12', action: 'append' })
})

test('同一轮的第二条：排队，不打断正在读的上一句', () => {
  assert.deepEqual(planAssistantRoute('12', 12), { base: '12', action: 'append' })
})

test('`12-sum` 与 `12` 是同一逻辑轮：概括文本要排队，不能把改写那条打断', () => {
  assert.deepEqual(planAssistantRoute('12', '12-sum'), { base: '12', action: 'append' })
  assert.deepEqual(planAssistantRoute('12-sum', 12), { base: '12', action: 'append' })
})

test('换了一轮：打断（新问题优先，旧回答让位）', () => {
  assert.deepEqual(planAssistantRoute('12', 13), { base: '13', action: 'interrupt' })
  assert.deepEqual(planAssistantRoute('12', '13-sum'), { base: '13', action: 'interrupt' })
})

test('turn 0 是合法值：不能被当成"没有 turn"', () => {
  assert.deepEqual(planAssistantRoute(null, 0), { base: '0', action: 'append' })
})
