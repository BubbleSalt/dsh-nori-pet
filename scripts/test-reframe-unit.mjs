#!/usr/bin/env node
/**
 * src/reframe.ts 单测（node scripts/test-reframe.mjs）。
 *
 * 这一层此前完全不可测：320 行改写/概括逻辑活在宿主闭包里，只能靠"跑一轮 agent 听声音"验证。
 * 抽成 createReframe(deps) 后可以注入假 llm，把几个关键契约钉住：
 *   · 两条推理通道的返回值/空输出降级
 *   · 同一 turn 内**相同文本只投递一次**（曾导致同一段被改写播报两遍）
 *   · 概括走 sentinel turn `<N>-sum`、且被 capSpeech 硬截断
 *   · 分块规则（单块上限 1000 字，短块合并）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReframe } from '../lib/reframe.js'

const baseConfig = {
  reframeMaxInput: 4000,
  reframeBaseUrl: 'https://api.example.com',
  reframeModel: 'm',
  reframeMaxTokens: 512,
  reframeTimeoutMs: 5000,
  reframeTrace: false,
  reframeProvider: 'p',
  reframeApiKeyRef: '',
  detailMaxChars: 400,
  summaryWaitMs: 1000,
}

/** 造一套依赖：llm 由各用例注入；broadcast 收集广播；logs 收集错误/追踪 */
function makeHarness({ llm, persona = { prompt: '你是Nori', reframe: '改写规则' }, dir } = {}) {
  const seen = { broadcasts: [], errs: [], traces: [], summaries: [] }
  const d = dir ?? mkdtempSync(join(tmpdir(), 'nori-reframe-'))
  const r = createReframe({
    config: { ...baseConfig },
    logs: {
      appendErr: (l) => seen.errs.push(l),
      trace: (...a) => seen.traces.push(a),
      traceSummary: (...a) => seen.summaries.push(a),
    },
    log: () => {},
    repoRoot: d,
    persona,
    personaPaths: { reframePath: join(d, 'no-such.md') },
    credentials: undefined,
    llm,
    broadcast: (o) => seen.broadcasts.push(o),
    onAssistant: () => {},
    capSpeech: (t, n, c) => (t.length > c ? t.slice(0, c) : t),
    summaryCharsOf: () => 100,
    dir: d,
  })
  return { r, seen, dir: d }
}

/** 假 llm：把预设文本按 chunk 切开发出 */
const fakeLlm = (text, { empty = false } = {}) => {
  let calls = 0
  return {
    get calls() { return calls },
    stream() {
      calls += 1
      return (async function* () {
        if (empty) { yield { type: 'text-delta', text: '' }; return }
        for (const ch of text.match(/[\s\S]{1,4}/g) ?? []) yield { type: 'text-delta', text: ch }
      })()
    },
  }
}

test('reframeText：走内置 llm 通道，拼回完整文本（首尾空白剥掉）', async () => {
  const llm = fakeLlm('  我看了下，那个文件没问题。  ')
  const { r, seen, dir } = makeHarness({ llm })
  try {
    const out = await r.reframeText('原始文本')
    assert.equal(out, '我看了下，那个文件没问题。')
    assert.equal(llm.calls, 1)
    assert.equal(seen.traces.length, 1) // trace 记录一次（开关关着也要走一遍调用点）
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('reframeText：空输出 → 返回 null 且落错误日志（提示可能被思考链吃满）', async () => {
  const { r, seen, dir } = makeHarness({ llm: fakeLlm('', { empty: true }) })
  try {
    assert.equal(await r.reframeText('原始文本'), null)
    assert.ok(seen.errs.some((l) => l.includes('EMPTY output')), seen.errs.join('|'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('reframeText：没有 llm 服务 → 返回 null（调用方降级原文）', async () => {
  const { r, dir } = makeHarness({ llm: undefined })
  try {
    assert.equal(await r.reframeText('原始文本'), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('enqueueReframe：同一 turn 内相同文本只投递一次（去重）', async () => {
  const llm = fakeLlm('改写结果')
  const { r, seen, dir } = makeHarness({ llm })
  try {
    r.enqueueReframe('s1', 7, '同一段话')
    r.enqueueReframe('s1', 7, '同一段话')
    r.enqueueReframe('s1', 8, '同一段话') // 不同 turn 不算重复
    await new Promise((res) => setTimeout(res, 120))
    assert.equal(llm.calls, 2, '同 turn 去重后应只剩 2 个任务（turn7 一个 + turn8 一个）')
    assert.ok(seen.errs.some((l) => l.includes('reframe dedup')), '去重要留痕')
    assert.deepEqual(seen.broadcasts.map((b) => b.turn), [7, 8])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('概括：sentinel turn <N>-sum + capSpeech 硬截断 + 记入 hasSummarized', async () => {
  const long = '很长的概括内容。'.repeat(60) // 480 字，必须被截到 150
  const { r, seen, dir } = makeHarness({ llm: fakeLlm(long) })
  try {
    r.enqueueReframe('s1', 3, '很长的原文', 'summary')
    await new Promise((res) => setTimeout(res, 150))
    const b = seen.broadcasts.find((x) => String(x.turn).endsWith('-sum'))
    assert.ok(b, '应广播一条 <N>-sum')
    assert.equal(b.turn, '3-sum')
    assert.ok(b.text.length <= 150, '必须被 capSpeech 截断，实测 ' + b.text.length)
    assert.equal(r.hasSummarized(3), true)
    assert.equal(r.hasSummarized(4), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('splitBlocks：短文本一块、超长按 1000 字上限分块、空文本零块', () => {
  const { r, dir } = makeHarness({ llm: fakeLlm('x') })
  try {
    assert.deepEqual(r.splitBlocks('   '), [])
    assert.deepEqual(r.splitBlocks('一句话。'), ['一句话。'])
    const long = ('这是一句用来测试分块的话。'.repeat(120)) // 1560 字
    const blocks = r.splitBlocks(long)
    assert.ok(blocks.length >= 2, '超长文本应被拆开，实测 ' + blocks.length)
    for (const b of blocks) assert.ok(b.length <= 1000 + 1, '单块不得超过上限，实测 ' + b.length)
    assert.equal(blocks.join('').replace(/\n/g, ''), long.replace(/\n/g, ''), '拆块不能丢字')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('nori.config.json 热改：reframe 段能覆盖模型与超时（运行时直读）', async () => {
  const llm = fakeLlm('好')
  const { r, dir } = makeHarness({ llm })
  try {
    writeFileSync(join(dir, 'nori.config.json'), JSON.stringify({ reframe: { reframeModel: 'hot-model' } }), 'utf8')
    // hot 模型名只影响路径 1（专用 key）；这里只验证读取不炸、仍能出结果
    assert.equal(await r.reframeText('原文'), '好')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
