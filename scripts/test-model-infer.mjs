/**
 * 模型契约推断：第三方模型的表情名常是 F01/F02（官方样例 Haru 就是），
 * 名字没信息 → 只能靠表情文件的参数指纹。这里用合成指纹钉住规则，不依赖任何授权素材。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { inferModelMap } from '../lib/modelInfer.js'

const facts = (expressions, motionGroups = { Idle: 2, Reactions: 13 }, lipSyncId = 'ParamMouthOpenY') => ({
  expressions,
  motionGroups,
  lipSyncId,
  file: 'assets/test.model3.json',
})

test('参数指纹：嘴角上扬+笑眼 → happy；压眉皱眉 → angry（Haru 实测形态）', () => {
  const r = inferModelMap(facts([
    { name: 'F01', params: { ParamMouthForm: 0.27 } },
    { name: 'F03', params: { ParamBrowLY: -1, ParamBrowRY: -1, ParamBrowLX: -1, ParamBrowRX: -1, ParamBrowRAngle: -1, ParamBrowLForm: -1 } },
  ]))
  assert.equal(r.hits.happy?.expr, 'F01')
  assert.equal(r.hits.angry?.expr, 'F03')
})

test('一个表情只认领一个情绪（否则最强那条会被 happy/sad/angry 全抢走）', () => {
  const angry = { ParamBrowLY: -1, ParamBrowRY: -1, ParamBrowLX: -1, ParamBrowRX: -1, ParamBrowRAngle: -1, ParamBrowLForm: -1 }
  const r = inferModelMap(facts([{ name: 'F03', params: angry }]))
  const claimed = Object.values(r.hits).filter((h) => h.expr === 'F03')
  assert.equal(claimed.length, 1, '同一条表情只能被一个情绪认领')
  assert.equal(r.hits.angry?.expr, 'F03', '分数最高的情绪拿到它')
})

test('名字有语义时名字也算信号（Nori 这种 13_Happy 命名）', () => {
  const r = inferModelMap(facts([{ name: '13_Happy', params: {} }]))
  assert.equal(r.hits.happy?.expr, '13_Happy')
})

test('动作组：没有 Reactions 就用 TapBody，并在 notes 里说明', () => {
  const r = inferModelMap(facts([{ name: 'F01', params: { ParamMouthForm: 0.3 } }], { Idle: 2, TapBody: 4 }))
  assert.equal(r.model.emotions.happy?.reaction, 0)
  assert.ok(r.notes.some((n) => n.includes('TapBody')))
})

test('口型与待机组：优先用 LipSync 组声明的参数，没有则回落到标准名', () => {
  assert.equal(inferModelMap(facts([], { Idle: 1 }, 'ParamMouthOpen')).model.mouthParam, 'ParamMouthOpen')
  const noLip = inferModelMap({ expressions: [], motionGroups: { Idle: 1 }, file: 'x.model3.json' })
  assert.equal(noLip.model.mouthParam, 'ParamMouthOpenY')
  assert.ok(noLip.notes.some((n) => n.includes('LipSync')))
})

test('认不出的情绪进 gaps（只影响表情，不影响朗读）', () => {
  const r = inferModelMap(facts([]))
  assert.ok(r.gaps.includes('happy'))
  assert.ok(!r.gaps.includes('default'), 'default 不需要资源')
})
