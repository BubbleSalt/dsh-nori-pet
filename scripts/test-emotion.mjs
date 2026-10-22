/**
 * 情绪分类器单测：classifyEmotion 从 widget.ts 搬到 src/emotions.ts 之后才第一次可测。
 * 它决定"广播文本没有显式【标签】时桌宠摆什么脸"，属于纯规则 —— 必须能被断言钉住，
 * 而不是只能靠肉眼看表情对不对。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EMOTIONS, EMOTION_KEYWORDS, classifyEmotion, VALID_EMO_TAGS } from '../lib/emotions.js'
import { parseTaggedSentences } from '../lib/speakText.js'
import { hashText } from '../lib/util.js'

test('关键词表只使用词表内的情绪（拼错一个词就永远匹配不到）', () => {
  for (const [e] of EMOTION_KEYWORDS) {
    assert.equal(VALID_EMO_TAGS.has(e), true, `未在 EMOTIONS 中定义: ${e}`)
  }
  assert.equal(new Set(EMOTION_KEYWORDS.map(([e]) => e)).size, EMOTION_KEYWORDS.length, '同一情绪不该重复出现')
})

test('classifyEmotion：命中即返回，返回值必属词表', () => {
  const cases = [
    ['太好了，这次终于过了', 'happy'],
    ['哇，居然是这个', 'excited'], // excited 优先于 happy（顺序即优先级）
    ['我有点难过', 'sad'],
    ['这样不行，太过分了', 'angry'],
    ['不要不要，算了吧', 'refuse'],
    // 「麻烦你了」这句礼貌话会被 troubled 的 `麻烦` 抢先命中 —— 是**既有行为**（顺序即优先级），
    // 单测按现状锁定；要改成害羞脸就得先把 `麻烦你了` 从 troubled 词表里摘出来。
    ['麻烦你了，谢谢', 'troubled'],
    ['为什么会出现这个奇怪的问题？', 'doubt'],
    ['我晕，眼花', 'dizzy'],
    ['必须记住这一点', 'serious'],
    ['我无语了', 'speechless'],
  ]
  for (const [text, want] of cases) {
    const got = classifyEmotion(text)
    assert.equal(got, want, `「${text}」→ ${got}，期望 ${want}`)
    assert.equal(VALID_EMO_TAGS.has(got), true)
  }
})

test('classifyEmotion：无关键词 → default（纯待机，不乱换表情）', () => {
  assert.equal(classifyEmotion('今天天气不错'), 'default')
  assert.equal(classifyEmotion(''), 'default')
})

test('顺序即优先级：同一句里 excited 压过 happy', () => {
  assert.equal(classifyEmotion('好厉害，太棒了，真开心'), 'excited')
})

test('词表本身没有重复项（重复会让优先级变得不可读）', () => {
  assert.equal(new Set(EMOTIONS).size, EMOTIONS.length)
})

test('parseTaggedSentences：行首合法标签 → emo 分离，正文不含标签', () => {
  const out = parseTaggedSentences('【happy】太好了\n【serious】但是要注意\n普通一行')
  assert.deepEqual(out, [
    { text: '太好了', emo: 'happy' },
    { text: '但是要注意', emo: 'serious' },
    { text: '普通一行', emo: null },
  ])
  for (const s of out) assert.equal(/【|】/.test(s.text), false, '标签绝不能进合成文本')
})

test('parseTaggedSentences：非法标签不当情绪（但仍要剥掉括号残骸）', () => {
  const out = parseTaggedSentences('【anger】这话不该摆表情')
  assert.equal(out.length, 1)
  assert.equal(out[0].emo, null)
  assert.equal(/【|】/.test(out[0].text), false)
})

test('parseTaggedSentences：空行/纯空白行被丢弃', () => {
  assert.deepEqual(parseTaggedSentences('\n\n  \n'), [])
})

test('hashText：同文本同指纹，异文本不同（djb2 base36，宿主与 widget 共用一份实现）', () => {
  assert.equal(hashText('同一段话'), hashText('同一段话'))
  assert.notEqual(hashText('同一段话'), hashText('同一段话。'))
  assert.equal(/^[0-9a-z]+$/.test(hashText('abc')), true)
})
