#!/usr/bin/env node
/**
 * 换模型辅助：读一个 model3.json，推断出可用的 model 段草稿。
 *
 *   node scripts/model-map-from-model.mjs <model3.json>            # 人看的报告 + 可粘贴 JSON
 *   node scripts/model-map-from-model.mjs <model3.json> --json     # 只输出 JSON（便于管道）
 *   node scripts/model-map-from-model.mjs <model3.json> --write    # 直接写进 nori.config.json 的 model 段
 *
 * 推断依据是**表情文件的参数指纹**（第三方模型的表情名常是 F01/F02，名字本身没信息），
 * 名字关键词只作为附加信号。认不出的情绪会列在 gaps 里，留给人工补。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { inferModelMap } from '../lib/modelInfer.js'

const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--'))
const wantJson = args.includes('--json')
const wantWrite = args.includes('--write')
if (!target) {
  console.error('用法: node scripts/model-map-from-model.mjs <path/to/x.model3.json> [--json] [--write]')
  process.exit(2)
}

const filePath = resolve(target)
if (!existsSync(filePath)) {
  console.error('找不到模型文件:', filePath)
  process.exit(2)
}
const spec = JSON.parse(readFileSync(filePath, 'utf8'))
const refs = spec.FileReferences ?? {}
const baseDir = dirname(filePath)

// 表情：读每个 .exp3.json 的参数值（读不到就当没有签名，只靠名字关键词）
const expressions = []
for (const decl of refs.Expressions ?? []) {
  const name = String(decl?.Name ?? '')
  if (!name) continue
  const params = {}
  const rel = decl?.File
  if (typeof rel === 'string') {
    const p = join(baseDir, rel)
    try {
      const exp = JSON.parse(readFileSync(p, 'utf8'))
      for (const prm of exp.Parameters ?? []) {
        if (typeof prm?.Id === 'string' && typeof prm?.Value === 'number') params[prm.Id] = prm.Value
      }
    } catch (err) {
      console.warn(`[warn] 读不到表情参数（只按名字判断）: ${rel} — ${err?.message ?? err}`)
    }
  }
  expressions.push({ name, params })
}

const motionGroups = {}
for (const [group, list] of Object.entries(refs.Motions ?? {})) {
  motionGroups[group] = Array.isArray(list) ? list.length : 0
}
const lipSync = (spec.Groups ?? []).find((g) => String(g?.Name ?? '').toLowerCase() === 'lipsync')
const lipSyncId = lipSync?.Ids?.[0]

// 配置里的路径要相对仓库根（宿主按仓库根解析）；不在仓库内则保留绝对路径
const repoRoot = process.cwd()
const relFromRepo = relative(repoRoot, filePath).replace(/\\/g, '/')
const cfgFile = relFromRepo.startsWith('..') ? filePath.replace(/\\/g, '/') : relFromRepo

const result = inferModelMap({ expressions, motionGroups, lipSyncId, file: cfgFile })

if (wantJson || wantWrite) {
  const json = JSON.stringify(result.model, null, 2)
  if (wantWrite) {
    const cfgPath = join(repoRoot, 'nori.config.json')
    if (!existsSync(cfgPath)) {
      console.error('没有 nori.config.json（先跑一次 install.ps1），或手动把下面这段粘进配置：\n' + json)
      process.exit(1)
    }
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    cfg.model = result.model
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    console.log('已写入 nori.config.json 的 model 段：' + cfgPath)
  } else {
    console.log(json)
  }
} else {
  console.log(`模型：${cfgFile}`)
  console.log(`表情 ${expressions.length} 个，动作组：${Object.entries(motionGroups).map(([k, v]) => `${k}(${v})`).join(', ') || '无'}`)
  console.log(`口型参数：${result.model.mouthParam}    待机组：${result.model.idleGroup}`)
  console.log('\n情绪映射（草稿，请人工核对）：')
  for (const [emo, hit] of Object.entries(result.hits)) {
    console.log(`  ${emo.padEnd(11)} → ${hit.expr.padEnd(16)} 分 ${hit.score}  ${hit.why}`)
  }
  if (result.gaps.length) console.log('\n没认出来（这些情绪只会有气泡和声音，没表情）：' + result.gaps.join(', '))
  for (const n of result.notes) console.log('提示：' + n)
  console.log('\n把下面这段加进 nori.config.json：')
  console.log(JSON.stringify({ model: result.model }, null, 2))
}
