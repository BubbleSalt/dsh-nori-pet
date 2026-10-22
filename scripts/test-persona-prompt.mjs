/**
 * 人设资产与 system prompt 组装：概括规则必须和改写规则一样是"可改的文件"，不是代码常量。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync as rf } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildSystemPrompt, loadPersona, resolvePersonaPaths, readSummaryHot, DEFAULT_SUMMARY_RULES } from '../lib/prompt.js'

const parts = { prompt: '你是 Nori。', reframe: '改写规则。', summary: '概括规则。' }

test('reframe 模式只拼人设 + 改写规则（不带概括规则）', () => {
  const s = buildSystemPrompt(parts, 'reframe')
  assert.ok(s.includes('你是 Nori。') && s.includes('改写规则。'))
  assert.ok(!s.includes('概括规则。'))
})

test('summary 模式追加概括规则', () => {
  const s = buildSystemPrompt(parts, 'summary')
  assert.ok(s.endsWith('概括规则。'))
})

test('概括文件缺失 → 退回内置默认规则（老安装不至于没规则）', () => {
  const s = buildSystemPrompt({ prompt: 'p', reframe: 'r', summary: '' }, 'summary')
  assert.ok(s.includes('【本次任务：概括】'))
  assert.ok(s.includes(DEFAULT_SUMMARY_RULES.split('\n')[0]))
})

test('空白的概括文件也当缺失处理', () => {
  const s = buildSystemPrompt({ prompt: 'p', reframe: 'r', summary: '   \n ' }, 'summary')
  assert.ok(s.includes('【本次任务：概括】'))
})

test('resolvePersonaPaths 三个路径都解析（未配置时指向 persona/ 默认文件名）', () => {
  const dir = join(tmpdir(), 'nori-persona-' + process.pid + '-d')
  mkdirSync(join(dir, 'persona'), { recursive: true })
  for (const f of ['prompt.txt', 'reframe.txt', 'summary.txt']) writeFileSync(join(dir, 'persona', f), 'x', 'utf8')
  const p = resolvePersonaPaths(dir)
  assert.ok(p.promptPath.endsWith(join('persona', 'prompt.txt')), p.promptPath)
  assert.ok(p.reframePath.endsWith(join('persona', 'reframe.txt')), p.reframePath)
  assert.ok(p.summaryPath.endsWith(join('persona', 'summary.txt')), p.summaryPath)
  rmSync(dir, { recursive: true, force: true })
})

test('loadPersona：summary.txt 缺失不算人设缺失（返回空串，链路照走）', () => {
  const dir = join(tmpdir(), 'nori-persona-' + process.pid + '-a')
  mkdirSync(join(dir, 'persona'), { recursive: true })
  writeFileSync(join(dir, 'persona', 'prompt.txt'), '人设', 'utf8')
  writeFileSync(join(dir, 'persona', 'reframe.txt'), '改写', 'utf8')
  const p = loadPersona(dir)
  assert.ok(p, '人设不该被判缺失')
  assert.equal(p.summary, '')
  rmSync(dir, { recursive: true, force: true })
})

test('loadPersona：三个文件齐全时都能读到（含 BOM 剥离）', () => {
  const dir = join(tmpdir(), 'nori-persona-' + process.pid + '-b')
  mkdirSync(join(dir, 'persona'), { recursive: true })
  writeFileSync(join(dir, 'persona', 'prompt.txt'), '人设', 'utf8')
  writeFileSync(join(dir, 'persona', 'reframe.txt'), '改写', 'utf8')
  writeFileSync(join(dir, 'persona', 'summary.txt'), '\ufeff概括规则', 'utf8')
  const p = loadPersona(dir)
  assert.equal(p.summary, '概括规则')
  rmSync(dir, { recursive: true, force: true })
})

test('readSummaryHot：改了文件立刻生效；读不到则退回缓存', () => {
  const dir = join(tmpdir(), 'nori-persona-' + process.pid + '-c')
  mkdirSync(dir, { recursive: true })
  const f = join(dir, 'summary.txt')
  writeFileSync(f, '第一版', 'utf8')
  assert.equal(readSummaryHot(f, '缓存').trim(), '第一版')
  writeFileSync(f, '第二版', 'utf8')
  assert.equal(readSummaryHot(f, '缓存').trim(), '第二版', '热读：改完下一次请求即生效')
  assert.equal(readSummaryHot(join(dir, 'nope.txt'), '缓存'), '缓存')
  assert.equal(readSummaryHot('', '缓存'), '缓存')
  rmSync(dir, { recursive: true, force: true })
})

test('persona/summary.txt 与内置默认规则保持一致（改一处忘另一处会红）', () => {
  const file = rf(join(process.cwd(), 'persona', 'summary.txt'), 'utf8').replace(/\r\n/g, '\n').trim()
  assert.equal(file, DEFAULT_SUMMARY_RULES.trim())
})

test('prompt 里不写工程叙事：实测/以前/曾经/被截断 这类项目历史不该进 system prompt', () => {
  const bad = ['实测', '以前', '曾经', '被截断', '踩过', '老版本']
  for (const w of bad) assert.ok(!DEFAULT_SUMMARY_RULES.includes(w), '概括规则里出现了工程叙事：' + w)
})
