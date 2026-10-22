/**
 * 播报截断：超预算时必须**保住结尾**。
 * 真机事故（turn=15）：196 字被截成 99 字，最后两句整行消失 —— 气泡不显示也不朗读。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { capSpeech, capSpeechInfo, RUNAWAY_MAX_CHARS, RUNAWAY_MAX_SENTENCES } from '../lib/capSpeech.js'

const L = (n) => '句'.repeat(n) + '。'

test('没超预算 → 原样返回，不动一个字', () => {
  const t = '【happy】第一句。第二句。'
  assert.equal(capSpeech(t, 4, 150), t)
  assert.equal(capSpeechInfo(t, 4, 150).dropped, 0)
})

test('超字数 → 保住第一句和最后一句，丢中间（结尾常有结论/提问）', () => {
  const t = L(40) + L(40) + L(40) + L(40)   // 4 句 × 41 字
  const r = capSpeechInfo(t, 4, 150)
  assert.equal(r.total, 4)
  assert.ok(r.text.startsWith(L(40)), '开头要保住')
  assert.ok(r.text.endsWith(L(40)), '结尾要保住 —— 这是原实现丢掉的那句')
  assert.ok(r.text.length <= 150)
  assert.equal(r.dropped, 1, '只丢中间那句（123 字仍在预算内）')
})

test('超句数 → 句数不超上限', () => {
  const t = L(5) + L(5) + L(5) + L(5) + L(5) + L(5)
  const r = capSpeechInfo(t, 4, 1000)
  assert.ok(r.text.split('。').filter(Boolean).length <= 4)
  assert.ok(r.text.endsWith(L(5)))
})

test('单句本身超预算 → 原样返回（切不动，也不能返回空）', () => {
  const t = L(500)
  assert.equal(capSpeech(t, 4, 150), t)
})

test('情绪标签不会被切断（标签跟着所在句走）', () => {
  const t = '【think】' + L(30) + '【doubt】' + L(30)
  const r = capSpeech(t, 4, 40)
  assert.ok(!/【[a-z]*$/.test(r.text), '不能停在半个标签上：' + r.text)
})

test('空输入 / 纯空白 → 空串，不抛', () => {
  assert.equal(capSpeech('', 4, 150), '')
  assert.equal(capSpeech('   \n  ', 4, 150), '')
})

test('正常超目标不动手：196 字/4 句的概括原样播报（略超 140 字没关系，删结论才是损失）', () => {
  const t = '【default】2D装载已经跑了169行，现在能盯着画面，拆那三块的风险降下来了。'
    + '【serious】加固这块我打算把check-swallow接进guard.yml的CI，防止以后又冒出裸吞异常。'
    + '【think】再给test:reframe这类真实LLM脚本加个--offline桩，让CI不依赖模型能不能用。'
    + '【doubt】你想让我做哪个，还是都先放着？'
  const r = capSpeechInfo(t, RUNAWAY_MAX_SENTENCES, RUNAWAY_MAX_CHARS)
  assert.equal(r.dropped, 0, '这条以前被截成 99 字，现在不该动')
  assert.equal(r.text, t.trim())
})

test('只有跑飞（>6 句 / >400 字）才截断，且保住结尾', () => {
  const long = Array.from({ length: 12 }, (_, i) => '第' + i + '句' + '啰'.repeat(50) + '。').join('')
  const r = capSpeechInfo(long, RUNAWAY_MAX_SENTENCES, RUNAWAY_MAX_CHARS)
  assert.ok(r.dropped > 0, '跑飞要截')
  assert.ok(r.text.startsWith('第0句'), '开头保住')
  assert.ok(r.text.includes('第11句'), '结尾保住')
  assert.ok(r.text.length <= RUNAWAY_MAX_CHARS)
})
