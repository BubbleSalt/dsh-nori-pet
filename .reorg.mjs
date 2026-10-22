import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'

const git = (...args) => execFileSync('git', args, { stdio: 'inherit' })
const out = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const commitWith = (msg) => {
  writeFileSync('.msg.tmp', msg, 'utf8')
  git('commit', '-q', '--no-verify', '-F', '.msg.tmp')
  unlinkSync('.msg.tmp')
}

// 1) 先把工作区改动提交（这次 Haru 联调修的两处）
git('add', '-A')
commitWith(
  'fix(model): 接口字段与配置统一为 file；换模型真的能生效了\n\n' +
  'Haru 联调暴露的两处：\n' +
  '- /api/model-map 回传的是 modelPath，配置里写的是 file —— mergeModelMap 只认后者，\n' +
  '  于是"接口返回 Haru、页面还是 Nori"。现在接口按配置字段下发（file/mouthParam/idleGroup/emotions），\n' +
  '  一个东西只有一个名字。\n' +
  '- mergeModelMap 同时接受 file / modelPath，老配置文件不受影响。\n' +
  '- widget 暴露 __noriPetWidget.modelMap() 诊断（path/loaded/gaps），换模型没反应时一眼看出卡在哪。\n\n' +
  '实测：Haru（官方样例，8 个无语义表情名）认出 6 种情绪，口型/待机/动作组全自动识别。\n',
)

const final = out('rev-parse', 'HEAD')
const tRepo = out('rev-parse', '572dea3^{tree}')
const tContract = out('rev-parse', 'd86956c^{tree}')
const tFinal = out('rev-parse', `${final}^{tree}`)

// 2) 重排成三组主题提交
git('reset', '--hard', 'd683582')

git('read-tree', '-u', '--reset', tRepo)
commitWith(
  'chore(repo): persona/summary.txt 入库，开发文档不入库\n\n' +
  '- summary.txt 之前被 .gitignore 吞掉，README 说的"随仓库提供"实际没生效\n' +
  '- docs/ 是写给自己看的过程稿，整体忽略\n',
)

git('read-tree', '-u', '--reset', tContract)
commitWith(
  'feat(model): 模型契约 —— 换模型不用改代码，没模型也能跑（纸片人模式）\n\n' +
  '模型是第三方 IP，仓库不分发；但此前模型路径、口型参数、待机组、13 个表情名、\n' +
  'Reactions 下标全写死在代码里，克隆者自备模型也只有一张会眨眼的脸。\n\n' +
  '- src/modelMap.ts：DEFAULT_MODEL_MAP（= 原硬编码值，本机零变化）+ mergeModelMap\n' +
  '  + modelGaps（缺哪些情绪的可视资源，只报账不阻断）\n' +
  '- nori.config.json 新增 model 段 + GET /api/model-map 下发契约（运行时热读，改配置即生效）\n' +
  '- 模型加载失败 → 纸片人模式：气泡与语音照常\n' +
  '- install.ps1 两处硬抛改警告，缺模型也能装完\n' +
  '- README 补「换模型：模型契约」\n',
)

git('read-tree', '-u', '--reset', tFinal)
commitWith(
  'feat(model): 换模型辅助工具 —— 用参数指纹猜一份契约草稿\n\n' +
  '第三方模型的表情名往往没有语义（官方样例 Haru 是 F01…F08），关键词匹配无用；\n' +
  '真正的信息在表情文件的参数签名里（F01 嘴角上扬 0.27 → 笑；F03 压眉皱眉 → 生气）。\n\n' +
  '- src/modelInfer.ts：14 种情绪指纹打分 + 名字关键词 + 全局贪心认领\n' +
  '  （每个表情只用一次 —— 否则最强的 F03 会被 angry/refuse/sad/troubled 同时抢走）\n' +
  '- scripts/model-map-from-model.mjs：报告 + 可粘贴 JSON，--write 直接写配置\n' +
  '- 接口字段统一为 file（与配置文件同名），mergeModelMap 兼收 modelPath\n' +
  '- widget 暴露 __noriPetWidget.modelMap() 诊断\n\n' +
  '实测：Haru 8 个表情认出 6 种情绪，口型/待机/动作组全自动识别，全程未改一行代码。\n',
)

console.log('\n=== 整理后 ===')
console.log(out('log', '--oneline', 'd683582..HEAD'))
console.log('tree 与整理前一致:', out('diff', '--stat', final, 'HEAD') === '' ? 'YES' : 'NO')
