/**
 * textPatterns / emotions 回归：这两处是把"抄了 3~4 份"的正则与词表收成一处，
 * 收的过程最容易把语义收丢 —— 所以把三个调用点原来各自的**关键行为**钉成断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { CJK, CJK_ALNUM, codeFence, codeFenceAny, codeFenceOpen } from '../lib/textPatterns.js'
import { EMOTIONS, VALID_EMO_TAGS } from '../lib/emotions.js'

test('CJK：认汉字（基本区/扩展 A/兼容区），不认拉丁与全角标点', () => {
  assert.equal(CJK.test('好'), true)
  assert.equal(CJK.test('㐀'), true) // 扩展 A
  assert.equal(CJK.test('豈'), true) // 兼容区
  assert.equal(CJK.test('a'), false)
  assert.equal(CJK.test('，'), false) // 全角逗号属标点，不算"有内容"
  assert.equal(CJK_ALNUM.test('7'), true)
  assert.equal(CJK_ALNUM.test('，'), false)
})

test('每次调用返回新正则：带 g 的正则不会因 lastIndex 串味', () => {
  const a = codeFence()
  const b = codeFence()
  assert.notEqual(a, b)
  a.lastIndex = 99
  assert.equal(b.lastIndex, 0)
})

test('codeFence：成对 ``` 与 ~~~ 都整段吃掉，未闭合时不动', () => {
  assert.equal('前```js\nconst a=1\n```后'.replace(codeFence(), ''), '前后')
  assert.equal('前~~~\nx\n~~~后'.replace(codeFence(), ''), '前后')
  const open = '前```js\nconst a=1\n'
  assert.equal(open.replace(codeFence(), ''), open) // 未闭合：codeFence 不负责
})

test('codeFenceAny：未闭合围栏到文末整段丢（宁可丢尾巴也不念代码）', () => {
  assert.equal('正经话。\n```js\nconst a=1\n'.replace(codeFenceAny(), ' ').trim(), '正经话。')
  assert.equal('只剩围栏 ``` 本身'.replace(codeFenceAny(), ' ').replace(/\s+/g, ' ').trim(), '只剩围栏 本身')
})

test('codeFenceOpen：只判"行首未闭合围栏"，用来识别整段掉进正文的代码', () => {
  assert.equal(codeFenceOpen().test('```ts\nconst a=1'), true)
  assert.equal(codeFenceOpen().test('说明文字 ```ts'), false) // 不是行首
  assert.equal(codeFenceOpen().test('```a```'), true) // 行首围栏到行尾（闭合的一行也算，与原 speechable 语义一致）
})

test('情绪词表：唯一真相 + 校验集合一致（曾三处各写一份）', () => {
  assert.equal(EMOTIONS.length, 14)
  assert.deepEqual([...VALID_EMO_TAGS].sort(), [...EMOTIONS].sort())
  for (const e of EMOTIONS) assert.equal(VALID_EMO_TAGS.has(e), true)
  assert.equal(VALID_EMO_TAGS.has('anger'), false) // 拼错的标签不该被放过去
})
