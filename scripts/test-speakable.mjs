#!/usr/bin/env node
/**
 * 可播内容抽取单测：node scripts/test-speakable.mjs
 *
 * 覆盖"念出来没意义"的三类结构（用户确认要跳过的）：代码块、JSON/日志、表格/文件清单。
 * 核心约束：只替换这些结构，正文（含中文说明、结论、报错信息）必须原样保留。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractSpeakable } from '../lib/speakable.js'

test('围栏代码块 → 类别短语，正文保留', () => {
  const src = ['我先改这里：', '```ts', 'const a = 1', 'function foo() {}', '```', '改完再跑测试。'].join('\n')
  const out = extractSpeakable(src)
  assert.ok(out.includes('我先改这里'), out)
  assert.ok(out.includes('改完再跑测试'), out)
  assert.ok(out.includes('贴了一段代码'), out)
  assert.ok(!out.includes('const a = 1'), out)
  assert.ok(!out.includes('function foo'), out)
})

test('JSON 行 → 一坨 JSON 数据（连续多行合并为一处）', () => {
  const src = ['接口返回：', '{', '"ok": true,', '"port": 9880,', '}', '端口没被占用。'].join('\n')
  const out = extractSpeakable(src)
  assert.ok(out.includes('一坨 JSON 数据'), out)
  assert.ok(!out.includes('9880'), `数字不该被念出来: ${out}`)
  assert.ok(out.includes('端口没被占用'), out)
  assert.equal(out.match(/一坨 JSON 数据/g).length, 1, `同类行应合并成一句: ${out}`)
})

test('日志行 → 一段日志', () => {
  const src = ['[03:15:30] INFO 启动完成', '2026-10-18T03:15:31 探测器就绪', '然后它开始跑任务。'].join('\n')
  const out = extractSpeakable(src)
  assert.ok(out.includes('一段日志'), out)
  assert.ok(!out.includes('INFO 启动完成'), out)
  assert.ok(out.includes('然后它开始跑任务'), out)
})

test('表格 → 一张表格（表头也一起跳过）', () => {
  const src = ['| 项 | 值 |', '|----|----|', '| 端口 | 9880 |', '总结：都正常。'].join('\n')
  const out = extractSpeakable(src)
  assert.ok(out.includes('一张表格'), out)
  assert.ok(!out.includes('9880'), out)
  assert.ok(out.includes('总结：都正常'), out)
})

test('文件清单 → 一串文件清单（相对路径 / 裸文件名）', () => {
  const src = ['改了这些：', 'src/index.ts', 'src/segmentation.ts', 'README.md', '一共三个文件。'].join('\n')
  const out = extractSpeakable(src)
  assert.ok(out.includes('一串文件清单'), out)
  assert.ok(!out.includes('segmentation.ts'), `文件名不该逐个念: ${out}`)
  assert.ok(out.includes('一共三个文件'), out)
})

test('diff → 一段改动 diff（含 +/- 内容行）', () => {
  const src = ['--- a/src/index.ts', '+++ b/src/index.ts', '@@ -1,3 +1,4 @@', '+const x = 1', '就这一行改动。'].join('\n')
  const out = extractSpeakable(src)
  assert.ok(out.includes('一段改动 diff'), out)
  assert.ok(!out.includes('const x = 1'), `diff 内容不该念: ${out}`)
  assert.ok(!out.includes('@@'), out)
  assert.ok(out.includes('就这一行改动'), out)
})

test('正文不被误伤：中文说明、结论、报错信息原样保留', () => {
  const src = '沙箱里 sh.exe 建不了信号管道，所以 git commit 会被拒：Win32 error 5。解决办法是手动跑守卫。'
  assert.equal(extractSpeakable(src), src)
})

test('空输入与纯空白', () => {
  assert.equal(extractSpeakable(''), '')
  assert.equal(extractSpeakable('   \n  \n'), '')
})

test('代码块未闭合（流式截断）也要跳过', () => {
  const src = ['看一下这段：', '```python', 'def f():', '    return 1'].join('\n')
  const out = extractSpeakable(src)
  assert.ok(out.includes('贴了一段代码'), out)
  assert.ok(!out.includes('def f'), out)
})
