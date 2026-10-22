/**
 * 从任意 Cubism3/4 模型推断「模型契约」草稿。
 *
 * 为什么需要它：第三方模型的表情名往往毫无语义 —— 官方样例 Haru 是 `F01`…`F08`，
 * 光看名字既猜不出 happy 还是 sad，也谈不上关键词匹配。真正有信息的是**表情文件里的参数签名**：
 *   F01 → ParamMouthForm +0.27        （嘴角上扬 → 笑）
 *   F03 → ParamBrowLY/RY -1, BrowX -1 （压眉、皱眉 → 生气）
 * 所以这里走"参数指纹打分"，名字关键词只作为附加信号（中文/英文都有）。
 *
 * 输出是**草稿**，不保证正确：14 种情绪里能认几个算几个，认不出的留给人工补（并在 gaps 里点名）。
 * 纯函数，不碰文件系统 —— 读文件、解析 JSON 在脚本侧做，这样规则可以在 node 里断言。
 */
import { EMOTIONS, type Emotion } from './emotions.js'
import type { EmotionSlot } from './modelMap.js'

/** 一条表情：name = model3.json 里的 Expressions[].Name；params = 该 exp3 文件里的参数值 */
export interface ExpressionSample {
  name: string
  params: Record<string, number>
}

/** 推断所需的模型事实（都从 model3.json 读） */
export interface ModelFacts {
  /** 表达式样本（读不到参数时给空对象） */
  expressions: ExpressionSample[]
  /** 动作组名 → 该组动作数量 */
  motionGroups: Record<string, number>
  /** LipSync 组声明的第一个参数 id（没有则 undefined） */
  lipSyncId?: string
  /** model3.json 相对路径（写进配置） */
  file: string
}

export interface InferResult {
  /** 可粘进 nori.config.json 的 model 段 */
  model: { file: string; mouthParam: string; idleGroup: string; emotions: Partial<Record<Emotion, EmotionSlot>> }
  /** 每个情绪命中了哪个表情（便于人工核对/改） */
  hits: Partial<Record<Emotion, { expr: string; score: number; why: string }>>
  /** 没认出来的情绪 */
  gaps: Emotion[]
  /** 非致命提示（例如没有 Reactions 组，用 TapBody 代替） */
  notes: string[]
}

/** 取参数值（缺失视为 0，符合 Cubism 默认值语义） */
const p = (params: Record<string, number>, ...ids: string[]): number => {
  for (const id of ids) {
    const v = params[id]
    if (typeof v === 'number') return v
  }
  return 0
}

/** 左右取最大（有的模型只改单侧） */
const pmax = (params: Record<string, number>, ...ids: string[]): number => Math.max(...ids.map((id) => p(params, id)))

/**
 * 情绪指纹。数值区间参照 Cubism 标准参数（-1..1），按"表情典型写法"给分，
 * 只依赖标准参数名；非标准命名（如某些模型用 ParamMouthForm2）不在覆盖范围内。
 */
function signature(params: Record<string, number>): Record<Emotion, number> {
  const mf = p(params, 'ParamMouthForm') // 嘴角：+ 上扬（笑）/ − 下垂（难过、不满）
  const mo = p(params, 'ParamMouthOpenY') // 嘴张
  const eo = pmax(params, 'ParamEyeLOpen', 'ParamEyeROpen') // 眼睁
  const es = pmax(params, 'ParamEyeLSmile', 'ParamEyeRSmile') // 眼弯（笑眼）
  const by = (p(params, 'ParamBrowLY') + p(params, 'ParamBrowRY')) / 2 // 眉高：− 压眉
  const bx = (p(params, 'ParamBrowLX') + p(params, 'ParamBrowRX')) / 2 // 眉内收：− 皱眉
  const bf = (p(params, 'ParamBrowLForm') + p(params, 'ParamBrowRForm')) / 2
  const ba = p(params, 'ParamBrowLAngle') + p(params, 'ParamBrowRAngle')
  const ebx = Math.abs(p(params, 'ParamEyeBallX'))
  const eby = Math.abs(p(params, 'ParamEyeBallY'))
  const cheek = p(params, 'ParamCheek')

  return {
    default: 0,
    happy: (mf > 0.15 ? 2 : 0) + (es > 0.15 ? 2 : 0) + (cheek > 0.1 ? 1 : 0) + (mf > 0 && mo > 0.2 ? 0.5 : 0),
    excited: (es > 0.15 && eo > 0.3 ? 2 : 0) + (mf > 0.1 && mo > 0.4 ? 1.5 : 0) + (by > 0.3 ? 0.5 : 0),
    angry: (by < -0.3 ? 1.5 : 0) + (bx < -0.3 ? 1 : 0) + (ba !== 0 ? 1 : 0) + (mf < -0.2 ? 1 : 0) + (bf !== 0 ? 0.5 : 0),
    refuse: (mf < -0.4 ? 1.5 : 0) + (eo < -0.2 || es < -0.2 ? 1 : 0) + (bx < -0.2 ? 1 : 0) + (bf !== 0 ? 0.5 : 0),
    sad: (eo < -0.2 ? 2 : 0) + (mf < -0.15 ? 1.5 : 0) + (by < -0.2 ? 1 : 0) + (es < -0.2 ? 0.5 : 0),
    doubt: (ebx > 0.4 ? 2 : 0) + (by > 0.2 && Math.abs(p(params, 'ParamBrowLY') - p(params, 'ParamBrowRY')) > 0.3 ? 1 : 0) + (mf < 0 ? 0.5 : 0),
    troubled: (bf !== 0 ? 1.5 : 0) + (mf < -0.1 ? 1 : 0) + (by < -0.1 ? 0.5 : 0),
    shy: (cheek > 0.2 ? 2 : 0) + (es > 0.1 ? 1 : 0) + (by < 0 && eo < 0.5 ? 1 : 0) + (mf > 0 && mf < 0.3 ? 0.5 : 0),
    surprised: (eo > 0.4 ? 2 : 0) + (mo > 0.4 ? 1.5 : 0) + (by > 0.3 ? 1 : 0),
    dizzy: (ebx > 0.6 && eby > 0.3 ? 2 : 0) + (Math.abs(p(params, 'ParamAngleZ')) > 5 ? 1 : 0),
    serious: (by < -0.1 && bx > -0.1 && ba === 0 ? 1.5 : 0) + (mf < -0.05 && mo < 0.2 ? 1 : 0) + (eo > 0 && eo < 0.6 ? 0.5 : 0),
    speechless: (mf < -0.3 && mo < 0.1 ? 1.5 : 0) + (eo < -0.1 ? 0.5 : 0) + (by < 0 && bf === 0 ? 0.5 : 0),
    think: (eby > 0.3 ? 1.5 : 0) + (ebx > 0.2 ? 1 : 0) + (mf < 0 ? 0.5 : 0) + (bf !== 0 ? 0.5 : 0),
  }
}

/** 名字里的关键词（有语义命名的模型，如 Nori 的 13_Happy、常见模型的 smile/tears） */
const NAME_HINTS: Array<[Emotion, RegExp]> = [
  ['happy', /happy|smile|joy|笑|开心|喜/i],
  ['excited', /excited|kira|star|兴奋|星星/i],
  ['angry', /angry|anger|mad|怒|生气/i],
  ['refuse', /disgust|refuse|reject|厌恶|拒绝/i],
  ['sad', /sad|tear|cry|sorrow|难过|哭|泪/i],
  ['doubt', /doubt|confus|question|疑|疑惑/i],
  ['troubled', /trouble|worry|anxious|困扰|为难/i],
  ['shy', /shy|blush|embarrass|羞|脸红/i],
  ['surprised', /surpris|shock|wow|惊讶|惊/i],
  ['dizzy', /dizzy|spin|晕/i],
  ['serious', /serious|calm|严肃|认真/i],
  ['speechless', /speechless|deadpan|无语/i],
  ['think', /think|ponder|思考/i],
]

/** 挑选动作组：优先 Reactions，其次 TapBody；都没有则空 */
function pickReactionGroup(groups: Record<string, number>): string | null {
  for (const want of ['Reactions', 'TapBody', 'Tap', 'Flick']) {
    if (groups[want] > 0) return want
  }
  return null
}

/**
 * 从模型事实推断契约草稿。
 * @param facts 模型事实
 * @param minScore 认一条情绪所需的最低分（调高更保守，调低会乱猜）
 */
export function inferModelMap(facts: ModelFacts, minScore = 2): InferResult {
  const notes: string[] = []
  const hits: InferResult['hits'] = {}
  const emotions: Partial<Record<Emotion, EmotionSlot>> = {}

  // 1) 全局贪心认领：每个**表情最多用一次**（否则最强的那条会被 happy/sad/angry 全抢走，
  //    真机 Haru 实测就是这样：F03 同时被 angry/refuse/sad/troubled 认领）。
  const scored = facts.expressions.map((e) => ({ name: e.name, sig: signature(e.params) }))
  const cands: Array<{ emo: Emotion; expr: string; score: number; why: string }> = []
  for (const emo of EMOTIONS) {
    if (emo === 'default') continue // default 是"无表情在位"，无需资源
    const hint = NAME_HINTS.find(([k]) => k === emo)
    for (const e of scored) {
      const byName = !!hint && hint[1].test(e.name)
      const score = e.sig[emo] + (byName ? 2 : 0)
      if (score >= minScore) cands.push({ emo, expr: e.name, score, why: byName ? '名字+参数' : '参数' })
    }
  }
  cands.sort((a, b) => b.score - a.score)
  const usedExpr = new Set<string>()
  for (const c of cands) {
    if (emotions[c.emo]?.expr || usedExpr.has(c.expr)) continue
    emotions[c.emo] = { expr: c.expr }
    usedExpr.add(c.expr)
    hits[c.emo] = { expr: c.expr, score: c.score, why: c.why }
  }

  // 2) 动作：Reactions 组优先，按情绪顺序依次分配下标（越靠后越可能超出组长度）
  const grp = pickReactionGroup(facts.motionGroups)
  const grpCount = grp ? facts.motionGroups[grp] : 0
  if (!grp) {
    notes.push('没找到 Reactions/TapBody 动作组：只会有表情，没有小动作（不影响朗读）')
  } else {
    if (grp !== 'Reactions') notes.push(`没有 Reactions 组，小动作改用 ${grp} 组（${grpCount} 个）`)
    const order: Emotion[] = ['happy', 'excited', 'angry', 'refuse', 'doubt', 'troubled', 'shy', 'surprised', 'dizzy', 'speechless', 'think']
    order.forEach((emo, i) => {
      if (i >= grpCount) return
      emotions[emo] = { ...(emotions[emo] ?? {}), reaction: i }
    })
  }

  // 3) 口型与待机组
  const mouthParam = facts.lipSyncId && facts.lipSyncId.trim() ? facts.lipSyncId : 'ParamMouthOpenY'
  if (!facts.lipSyncId) notes.push('model3.json 未声明 LipSync 组：口型参数按标准名 ParamMouthOpenY 处理')
  const idleNames = Object.keys(facts.motionGroups).filter((g) => /^idle$/i.test(g))
  const idleGroup = idleNames[0] ?? Object.keys(facts.motionGroups)[0] ?? 'Idle'
  if (!idleNames.length) notes.push(`没有 Idle 动作组：待机动作改用 ${idleGroup}（可能不存在，仅告警）`)

  const gaps = EMOTIONS.filter((e) => e !== 'default' && !emotions[e]?.expr)
  return {
    model: { file: facts.file, mouthParam, idleGroup, emotions },
    hits,
    gaps,
    notes,
  }
}
