/**
 * 模型契约：换模型不改代码。
 * 关键不变量——**缺项不是错误**：配置不全也要能跑，只是那张脸不会变。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MODEL_MAP, mergeModelMap, modelGaps } from '../lib/modelMap.js'

test('不配置 model 段 → 返回 Nori 默认值（本机行为与重构前一致）', () => {
  assert.equal(mergeModelMap(undefined).modelPath, 'assets/Nori.model3.json')
  assert.equal(mergeModelMap({}).emotions.happy.expr, '13_Happy')
  assert.deepEqual(modelGaps(mergeModelMap({})), [], 'Nori 原版资源没有缺口')
})

test('逐字段覆盖：写了的用配置，没写的保留默认', () => {
  const m = mergeModelMap({ file: 'assets/cat.model3.json', mouthParam: 'ParamMouthOpen' })
  assert.equal(m.modelPath, 'assets/cat.model3.json')
  assert.equal(m.mouthParam, 'ParamMouthOpen')
  assert.equal(m.idleGroup, 'Idle', '没写的保持默认')
  assert.equal(m.emotions.happy.expr, '13_Happy')
})

test('情绪逐项覆盖：只改 happy，其余保持默认', () => {
  const m = mergeModelMap({ emotions: { happy: { expr: 'Smile', reaction: 0 } } })
  assert.deepEqual(m.emotions.happy, { expr: 'Smile', reaction: 0 })
  assert.equal(m.emotions.sad.expr, '08_Tears')
})

test('未知情绪键与坏字段被忽略，不抛错（第三方模型的配置文件不一定规整）', () => {
  const m = mergeModelMap({ emotions: { notAnEmotion: { expr: 'X' }, happy: { expr: 42, reaction: -1 } } })
  assert.ok(!('notAnEmotion' in m.emotions))
  // 用户显式配了 happy 就是想覆盖；字段坏了不能猜（拿 Nori 的 13_Happy 套到别人的模型上只会报错）
  assert.deepEqual(m.emotions.happy, {}, '坏字段丢弃 → 该情绪视为无资源')
  assert.ok(modelGaps(m).includes('happy'), '并出现在缺口清单里')
})

test('整段不是对象 → 原样返回默认值（不信任配置内容）', () => {
  for (const bad of [null, 42, 'x', []]) {
    assert.equal(mergeModelMap(bad).modelPath, 'assets/Nori.model3.json')
  }
})

test('缺口清单：没配表情也没配动作的情绪会被点名（只报账，不影响运行）', () => {
  const m = mergeModelMap({ emotions: { happy: {}, sad: { expr: 'Tears2' } } })
  const gaps = modelGaps(m)
  assert.ok(gaps.includes('happy'), 'happy 被清空后应报缺口')
  assert.ok(!gaps.includes('sad'), 'sad 还有表情，不算缺口')
  assert.ok(!gaps.includes('default'), 'default 本来就是无表情在位')
  assert.deepEqual(modelGaps(DEFAULT_MODEL_MAP), [])
})
