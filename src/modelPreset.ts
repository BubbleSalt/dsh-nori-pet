/**
 * GPT-SoVITS 模型权重指定（sovits.t2sWeights / sovits.vitsWeights）。
 *
 * tts_infer.yaml 顶层是「命名配置块」结构（custom: / v1: / v2: / ...），
 * 每个块是一组完整推理配置（bert/cnhuhbert/device/is_half/version + t2s_weights_path + vits_weights_path）；
 * api_v2.py 用 TTS_Config 读 yaml 时默认只取 custom 块（缺省回退 v2 块）。
 *
 * 用户通过 nori.config.json 的 sovits 段直接给推理权重路径：
 *   - t2sWeights：GPT 模型（t2s_weights_path），绝对或相对仓库根；
 *   - vitsWeights：SoVITS 模型（vits_weights_path），绝对或相对仓库根。
 * 这里以 custom 块（缺 v2）为模板，把对应路径覆盖后重包成 `custom:` 键的完整 yaml 文本，
 * 由 ttsWatch 以独立运行时配置文件（tts_infer.runtime.yaml）拉起 api_v2 ——
 * **不修改、不覆盖原 tts_infer.yaml**，改回空配置即恢复原样。
 */

export interface RuntimeOverrides {
  /** GPT 模型（t2s_weights_path），绝对或相对仓库根；给值则覆盖模板 */
  t2sWeights?: string
  /** SoVITS 模型（vits_weights_path），绝对或相对仓库根；给值则覆盖模板 */
  vitsWeights?: string
}

export interface SyncResult {
  ok: boolean
  changed: boolean
  message: string
}

export function buildRuntimeTtsConfig(yaml: string, o: RuntimeOverrides): { out: string; result: SyncResult } {
  const lines = yaml.split(/\r?\n/)
  // 顶层块起始行：行首无缩进 + `键:` 结尾（YAML 顶层映射键）
  const heads: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l && !/^\s/.test(l) && /^[A-Za-z0-9_.\-]+:\s*$/.test(l)) heads.push(i)
  }
  const nameOf = (i: number) => lines[i].trim().replace(/:.*$/, '').trim()

  if (!o.t2sWeights && !o.vitsWeights) {
    return { out: '', result: { ok: true, changed: false, message: '未配置权重：使用原 tts_infer.yaml（不动）' } }
  }

  // 模板块：custom → v2（TTS_Config 的缺省回退链一致）
  let tIdx = heads.findIndex((h) => nameOf(h) === 'custom')
  if (tIdx < 0) tIdx = heads.findIndex((h) => nameOf(h) === 'v2')
  if (tIdx < 0) return { out: '', result: { ok: false, changed: false, message: 'tts_infer.yaml 无可用模板块（custom/v2）' } }
  const tStart = heads[tIdx]
  const tEnd = tIdx + 1 < heads.length ? heads[tIdx + 1] : lines.length
  let body = lines.slice(tStart + 1, tEnd)

  const overridden: string[] = []
  if (o.t2sWeights) {
    body = body.map((l) => (/^\s+t2s_weights_path:/.test(l) ? (overridden.push('s1'), `  t2s_weights_path: ${o.t2sWeights}`) : l))
  }
  if (o.vitsWeights) {
    body = body.map((l) => (/^\s+vits_weights_path:/.test(l) ? (overridden.push('s2'), `  vits_weights_path: ${o.vitsWeights}`) : l))
  }

  const out = ['custom:', ...body].join('\n') + (yaml.endsWith('\n') ? '\n' : '')
  return {
    out,
    result: { ok: true, changed: true, message: 'custom ← ' + overridden.map((r) => `${r} 权重→配置路径`).join('，') },
  }
}