#!/usr/bin/env node
/**
 * src/util.ts 单测：三种"有界/前缀"惯用法的边界语义。
 * 这些语义原先散落在 11 处手写代码里，每处都要自己判断"刚写入的 key 不能被自己挤掉"，
 * 漏判就是"写进去立刻被删"的隐性丢数据 —— 所以直接把语义钉在这里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addBounded, dropByPrefix, errMsg, evictOldest } from '../lib/util.js'

test('errMsg：Error 取 message，非 Error 原样转字符串', () => {
  assert.equal(errMsg(new Error('boom')), 'boom')
  assert.equal(errMsg('plain'), 'plain')
  assert.equal(errMsg({ code: 1 }), '[object Object]')
  assert.equal(errMsg(undefined), 'undefined')
})

test('evictOldest：超上限删最旧，未超不动', () => {
  const m = new Map([['a', 1], ['b', 2]])
  evictOldest(m, 5)
  assert.deepEqual([...m.keys()], ['a', 'b'])
  evictOldest(m, 2)
  assert.deepEqual([...m.keys()], ['a', 'b'], '正好等于上限时不删')
  m.set('c', 3)
  evictOldest(m, 2)
  assert.deepEqual([...m.keys()], ['b', 'c'], '删最旧的 a')
})

test('evictOldest：skip 保护的 key 不会把自己挤掉（但没有别人可删时上限优先）', () => {
  const m = new Map([['old', 0], ['fresh', 1]])
  // 上限 1：正常会删 'old'；但若最旧的恰是 fresh（写入时正好超限），不能删 fresh
  evictOldest(m, 1, 'fresh')
  assert.deepEqual([...m.keys()], ['fresh'], 'skip 命中时应淘汰别的 key')
  const swap = new Map([['fresh', 1], ['old', 0]])
  evictOldest(swap, 1, 'fresh')
  assert.deepEqual([...swap.keys()], ['fresh'], 'skip 在插入序最前时也要保住')
  const only = new Map([['fresh', 1]])
  evictOldest(only, 0, 'fresh')
  assert.deepEqual([...only.keys()], [], '只有 skip 一个时可删它就是删；上限优先，绝不留无界容器')
})

test('addBounded：Set 版写入 + 淘汰', () => {
  const s = new Set()
  for (let i = 0; i < 5; i++) addBounded(s, i, 3)
  assert.deepEqual([...s], [2, 3, 4], '保留最新 3 个')
})

test('dropByPrefix：Map/Set 通用，按前缀删完并返回条数', () => {
  const m = new Map([['t1/a', 1], ['t1/b', 2], ['t2/a', 3]])
  assert.equal(dropByPrefix(m, 't1/'), 2)
  assert.deepEqual([...m.keys()], ['t2/a'])
  const s = new Set(['t1/a', 't1/b', 't2/a'])
  assert.equal(dropByPrefix(s, 't1/'), 2)
  assert.deepEqual([...s], ['t2/a'])
  assert.equal(dropByPrefix(s, 'zzz/'), 0, '没命中返回 0')
})
