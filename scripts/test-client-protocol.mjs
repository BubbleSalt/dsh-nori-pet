/**
 * 客户端协议契约：哪些帧能进朗读链路、turn 的两种形态怎么透传、emote 白名单。
 * 这些字段判断以前散在 widget 的 if 链里，出过一次"概括那批把朗读打断"的事故。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseClientEvent } from '../lib/clientProtocol.js'

const parse = (o) => parseClientEvent(JSON.stringify(o))

test('非法 JSON / 非对象 → null（不能抛，也不能当有效帧）', () => {
  assert.equal(parseClientEvent('not json'), null)
  assert.equal(parseClientEvent('null'), null)
  assert.equal(parseClientEvent('[1,2]'), null)
  assert.equal(parseClientEvent('"str"'), null)
})

test('assistant：文本原样透传，turn 数字/字符串都保留（归一化交给 planAssistantRoute）', () => {
  assert.deepEqual(parse({ type: 'assistant', text: '你好', turn: 12 }), { kind: 'assistant', text: '你好', turn: 12 })
  assert.deepEqual(parse({ type: 'assistant', text: '你好', turn: '12-sum' }), { kind: 'assistant', text: '你好', turn: '12-sum' })
})

test('assistant：空文本/缺文本 → unknown（否则会去合成一段空音频）', () => {
  assert.equal(parse({ type: 'assistant', text: '' }).kind, 'unknown')
  assert.equal(parse({ type: 'assistant' }).kind, 'unknown')
  assert.equal(parse({ type: 'assistant', text: 123 }).kind, 'unknown')
})

test('assistant：turn 缺失或类型不对 → null，交给上层当"新 turn"', () => {
  assert.deepEqual(parse({ type: 'assistant', text: 'x' }), { kind: 'assistant', text: 'x', turn: null })
  assert.deepEqual(parse({ type: 'assistant', text: 'x', turn: {} }), { kind: 'assistant', text: 'x', turn: null })
})

test('approval：必须带正文才算提醒', () => {
  assert.deepEqual(parse({ type: 'approval', text: '需要授权' }), { kind: 'approval', text: '需要授权' })
  assert.equal(parse({ type: 'approval' }).kind, 'unknown')
})

test('emote：情绪名按白名单校验，脏值降级为 null 但仍可带文本播报', () => {
  assert.deepEqual(parse({ type: 'emote', e: 'happy' }), { kind: 'emote', emotion: 'happy', text: null })
  assert.deepEqual(parse({ type: 'emote', e: '<script>', text: '念这句' }), { kind: 'emote', emotion: null, text: '念这句' })
  assert.equal(parse({ type: 'emote' }).emotion, null)
})

test('user / tool / turn-end 三态', () => {
  assert.equal(parse({ type: 'user' }).kind, 'user')
  assert.equal(parse({ type: 'tool' }).kind, 'tool')
  assert.equal(parse({ type: 'turn-end' }).kind, 'turn-end')
})

test('未知类型 → unknown，但保留类型名与文本（便于宿主加新帧时先观察）', () => {
  assert.deepEqual(parse({ type: 'weird', text: 'x' }), { kind: 'unknown', type: 'weird', text: 'x' })
  assert.deepEqual(parse({}), { kind: 'unknown', type: '', text: null })
})
