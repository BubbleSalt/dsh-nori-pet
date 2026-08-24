// dsh-nori-pet：modelPreset 运行时配置生成单测（build 后跑：node scripts/test-model-preset.mjs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeTtsConfig } from '../lib/modelPreset.js'

const YAML = [
  'custom:',
  '  device: cuda',
  '  t2s_weights_path: C:/abs/nori_s1.ckpt',
  '  vits_weights_path: C:/abs/nori_s2.pth',
  'v1:',
  '  device: cpu',
  '  t2s_weights_path: pretrained/p1.ckpt',
  '  vits_weights_path: pretrained/p1.pth',
  'v2:',
  '  device: cpu',
  '  t2s_weights_path: pretrained/p2.ckpt',
  '  vits_weights_path: pretrained/p2.pth',
  '',
].join('\n')

test('t2sWeights+vitsWeights → custom 模板 + 两条路径覆盖', () => {
  const { out, result } = buildRuntimeTtsConfig(YAML, {
    t2sWeights: 'C:/nori/s1-nori-e20.ckpt',
    vitsWeights: 'C:/nori/s2-nori.pth',
  })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.match(result.message, /s1 权重/s)
  assert.ok(out.includes('t2s_weights_path: C:/nori/s1-nori-e20.ckpt'))
  assert.ok(out.includes('vits_weights_path: C:/nori/s2-nori.pth'))
  assert.ok(out.includes('device: cuda'))                 // custom 模板基础参数保留
  assert.ok(!out.includes('C:/abs/nori_s1.ckpt'))         // 原 custom 权重被覆盖
})

test('只给 vitsWeights → 只覆盖 s2，s1 保持模板', () => {
  const { out } = buildRuntimeTtsConfig(YAML, { vitsWeights: 'C:/nori/s2-only.pth' })
  assert.ok(out.includes('vits_weights_path: C:/nori/s2-only.pth'))
  assert.ok(out.includes('t2s_weights_path: C:/abs/nori_s1.ckpt'))
})

test('无权重 → 不动（空 out、changed=false）', () => {
  const { out, result } = buildRuntimeTtsConfig(YAML, {})
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(out, '')
})

test('无 custom 键的 yaml → 回退 v2 模板', () => {
  const y = 'base:\n  a: 1\nv2:\n  device: cpu\n  t2s_weights_path: p2.ckpt\n  vits_weights_path: p2.pth\n'
  const { out, result } = buildRuntimeTtsConfig(y, { t2sWeights: 'C:/nori/s1-x.ckpt' })
  assert.equal(result.ok, true)
  assert.ok(out.startsWith('custom:\n'))
  assert.ok(out.includes('t2s_weights_path: C:/nori/s1-x.ckpt'))
  assert.ok(out.includes('vits_weights_path: p2.pth'))
  assert.ok(!out.includes('base:'))
})

test('YAML 注释/空行保留在块体内', () => {
  const y = 'custom:\n  a: 1\n  # 微调权重\n  t2s_weights_path: old.ckpt\nv1:\n  b: 2\n'
  const { out } = buildRuntimeTtsConfig(y, { t2sWeights: 'new.ckpt' })
  assert.ok(out.includes('# 微调权重'))
  assert.ok(out.includes('t2s_weights_path: new.ckpt'))
})

test('CRLF 输入输出为 LF（行内容一致）', () => {
  const y = 'custom:\r\n  t2s_weights_path: a.ckpt\r\n  vits_weights_path: a.pth\r\nv1:\r\n  b: 2\r\n'
  const { out } = buildRuntimeTtsConfig(y, { t2sWeights: 'b.ckpt' })
  assert.match(out, /^custom:\n  t2s_weights_path: b\.ckpt/)
})