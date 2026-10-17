#!/usr/bin/env node
/**
 * 流式去重测试：node scripts/test-stream-dedup.mjs
 *
 * 真实踩坑（用户在监听里听到重复）：`pushChunk` 本就是**唯一的流式入口**，内部按
 * `config.reframe` 二分：开着改写 → 成句入批；关着 → 按句广播原文。重构时在其 reframe
 * 分支末尾补了一句 `pushChunkPlain(...)`，于是同一份 delta：
 *   ① 成句进了改写批（会改写后播报）
 *   ② 又被按原文广播一遍
 * 结果同一段文字被播/被改写两次（trace 里表现为 `IN : X…X…` 前缀重复）。
 *
 * 本文件用与 host `pushChunk` 同构的状态机，断言"同一份 delta 只走一条路径"：
 *  - 开改写：原文广播数必须为 0（全部经改写批）
 *  - 关改写：改写批必须为空（全部直接广播）
 *  - 两种模式下，同一句都不允许出现两次
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spokenUnits } from '../lib/segmentation.js'

const BOUNDARY = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n'])
const MAX = 140
const BATCH_MAX = 500

/** 与 host pushChunk 同构。doublePath=true 复刻修复前的"双路径"缺陷 */
function makeHost({ reframe = true, doublePath = false } = {}) {
  let pending = ''
  let batch = ''
  const jobs = [] // 改写批（每项 = 一次改写请求的输入）
  const broadcasts = [] // 直接广播的原文单元
  const flush = () => { if (batch.trim()) jobs.push(batch.trim()); batch = '' }
  const queue = (unit) => { batch += unit; if (batch.length >= BATCH_MAX) flush() }
  const emit = (unit) => broadcasts.push(unit)

  function reframeBranch(delta) {
    let rest = pending + delta
    for (;;) {
      let idx = -1
      for (let i = 0; i < rest.length; i++) {
        if (BOUNDARY.has(rest[i])) { idx = i + 1; while (idx < rest.length && BOUNDARY.has(rest[idx])) idx++; break }
      }
      if (idx > 0) {
        const sentence = rest.slice(0, idx).trim()
        rest = rest.slice(idx)
        if (sentence) for (const u of spokenUnits(sentence, MAX)) queue(u)
        continue
      }
      const units = rest.length >= MAX ? spokenUnits(rest, MAX) : []
      if (units.length > 1) {
        for (let n = 0; n < units.length - 1; n++) queue(units[n])
        rest = units[units.length - 1]
      }
      break
    }
    pending = rest
  }
  function plainBranch(delta) {
    let buf = pending + delta
    for (;;) {
      let idx = -1
      for (let i = 0; i < buf.length; i++) if (BOUNDARY.has(buf[i])) { idx = i + 1; break }
      if (idx < 0) break
      const s = buf.slice(0, idx).trim()
      buf = buf.slice(idx)
      if (s) for (const u of spokenUnits(s, MAX)) emit(u)
    }
    pending = buf
  }

  return {
    push(delta) {
      if (reframe) { reframeBranch(delta); if (doublePath) plainBranch(delta); return }
      plainBranch(delta)
    },
    done() { flush(); return { jobs, broadcasts, all: jobs.join('') + broadcasts.join('') } },
  }
}

const SAMPLE = '理论站不住——宿主那行是无条件执行的，所以 pending 不会留旧内容。我的假设错了。看真正的收集路径：'

test('回归：开改写时不得再按原文广播同一份 delta（修复前会重复）', () => {
  const h = makeHost({ reframe: true })
  h.push(SAMPLE.slice(0, 40))
  h.push(SAMPLE.slice(40))
  const { jobs, broadcasts, all } = h.done()
  assert.equal(broadcasts.length, 0, '开改写时不应直接广播原文: ' + JSON.stringify(broadcasts))
  assert.equal((all.match(/理论站不住/g) ?? []).length, 1, '同一句出现两次: ' + JSON.stringify(all))
  assert.equal(jobs.length, 1, '应恰好一次改写请求')
})

test('修复前的双路径确实会重复（证明用例有效）', () => {
  const h = makeHost({ reframe: true, doublePath: true })
  h.push(SAMPLE.slice(0, 40))
  h.push(SAMPLE.slice(40))
  const { all } = h.done()
  assert.ok((all.match(/理论站不住/g) ?? []).length > 1, '该用例必须能抓到修复前的重复')
})

test('关改写时只走原文广播，不产生改写请求', () => {
  const h = makeHost({ reframe: false })
  for (let i = 0; i < SAMPLE.length; i += 9) h.push(SAMPLE.slice(i, i + 9))
  const { jobs, broadcasts, all } = h.done()
  assert.equal(jobs.length, 0, '关改写时不应产生改写请求')
  assert.equal((all.match(/理论站不住/g) ?? []).length, 1, JSON.stringify(all))
  assert.ok(broadcasts.length > 0)
})

test('逐字增量：开改写时同一句只出现一次', () => {
  const h = makeHost({ reframe: true })
  for (const ch of SAMPLE) h.push(ch)
  const { all } = h.done()
  assert.equal((all.match(/理论站不住/g) ?? []).length, 1, JSON.stringify(all))
})

test('短于句长上限的无标点串：整段滞留 pending（等成句或 turn/end），不入批', () => {
  const text = '这是一段没有任何句末标点的连续文本但还没超过句长上限'
  assert.ok(text.length < MAX, '用例前提：短于上限')
  const h = makeHost({ reframe: true })
  h.push(text)
  const { jobs, broadcasts, all } = h.done()
  assert.equal(jobs.length, 0, '未超上限不应入批')
  assert.equal(broadcasts.length, 0, '开改写时不应原文广播')
  assert.equal(all, '', '内容应留在 pending 等 turn/end')
})

test('超长无标点串：入批后不重复、不丢字', () => {
  const text = '没有句末标点的连续文本'.repeat(70)
  const h = makeHost({ reframe: true })
  h.push(text)
  const { jobs, broadcasts, all } = h.done()
  assert.equal(broadcasts.length, 0, '开改写时不应原文广播')
  assert.ok(jobs.length > 0, '超长串应入批')
  const joined = all.replace(/\s+/g, '')
  const src = text.replace(/\s+/g, '')
  assert.ok(src.startsWith(joined), '入批内容必须是原文前缀（不丢字）')
  // 真正的不变量：入批的每一段都不同（相同则说明同一段被排了多次）
  for (const job of jobs) {
    const units = spokenUnits(job, MAX)
    for (let i = 1; i < units.length; i++) {
      assert.notEqual(units[i], units[i - 1], '相邻两段完全相同 = 重复入批: ' + JSON.stringify(units.slice(0, 3)))
    }
  }
})
