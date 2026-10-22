/**
 * 模型契约：让"任何 Cubism4 模型"都能接上，而不是只有 Nori 那一套资源能用。
 *
 * 背景：仓库不分发模型（第三方 IP），克隆者必须自备。但此前表情名 `13_Happy`、
 * 动作下标 `Reactions[5]`、口型参数 `ParamMouthOpenY`、模型路径 `assets/Nori.model3.json`
 * 全是硬编码 —— 换个模型就只有一张会眨眼的脸，13 种情绪全部对不上。
 *
 * 现在这些从 nori.config.json 的 `model` 段读，缺省值就是 Nori 原值（本机零改动）：
 *   "model": {
 *     "file": "assets/my.model3.json",
 *     "mouthParam": "ParamMouthOpenY",
 *     "idleGroup": "Idle",
 *     "emotions": { "happy": { "expr": "Smile", "reaction": 0 } }
 *   }
 *
 * 设计原则：**缺项不是错误**。某个情绪没有对应表情 → 跳过表情、气泡和声音照常；
 * 契约不全也要能跑，只是那张脸不会变。所以 merge 只做"能认就认"，gaps 只做"报账"。
 */
import { EMOTION_TABLE } from './emotionDriver.js'
import { EMOTIONS, type Emotion } from './emotions.js'

export interface EmotionSlot {
  /** model3.json 里 Expressions 的 Name */
  expr?: string
  /** Motions 里 Reactions 组的下标 */
  reaction?: number
  /** 该情绪专用驻留时长（毫秒） */
  holdMs?: number
}

export interface ModelMap {
  /** 模型文件路径，相对插件根；加载时拼成 PREFIX + '/' + modelPath */
  modelPath: string
  /** 口型参数 id（Cubism 标准是 ParamMouthOpenY） */
  mouthParam: string
  /** 待机动作组名 */
  idleGroup: string
  /** 情绪 → 表现；缺项表示该情绪无资源 */
  emotions: Record<Emotion, EmotionSlot>
}

/** Nori 原版资源（缺省值）：不配置 model 段时行为与本重构前完全一致 */
export const DEFAULT_MODEL_MAP: ModelMap = {
  modelPath: 'assets/Nori.model3.json',
  mouthParam: 'ParamMouthOpenY',
  idleGroup: 'Idle',
  emotions: EMOTION_TABLE,
}

const isEmotion = (k: string): k is Emotion => (EMOTIONS as readonly string[]).includes(k)

/** 宽松校验一段情绪表现：字段类型不对就丢该字段，不整体报错 */
function sanitizeSlot(v: unknown): EmotionSlot | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const slot: EmotionSlot = {}
  if (typeof o.expr === 'string' && o.expr.trim()) slot.expr = o.expr.trim()
  if (typeof o.reaction === 'number' && Number.isInteger(o.reaction) && o.reaction >= 0) slot.reaction = o.reaction
  if (typeof o.holdMs === 'number' && o.holdMs > 0) slot.holdMs = o.holdMs
  return slot
}

/**
 * 把配置里的 model 段合并到默认映射上。
 * 语义：**逐字段覆盖**（配置里写了的用配置，没写的保留默认），未知情绪键忽略。
 * 空对象/undefined → 直接返回默认值。
 */
export function mergeModelMap(raw: unknown, base: ModelMap = DEFAULT_MODEL_MAP): ModelMap {
  if (!raw || typeof raw !== 'object') return base
  const o = raw as Record<string, unknown>
  const out: ModelMap = { ...base, emotions: { ...base.emotions } }
  // 兼容两种来源：配置文件写 `file`，宿主 /api/model-map 回传的是解析后的 `modelPath`
  const file = typeof o.file === 'string' ? o.file : typeof o.modelPath === 'string' ? o.modelPath : ''
  if (file.trim()) out.modelPath = file.trim()
  if (typeof o.mouthParam === 'string' && o.mouthParam.trim()) out.mouthParam = o.mouthParam.trim()
  if (typeof o.idleGroup === 'string' && o.idleGroup.trim()) out.idleGroup = o.idleGroup.trim()
  if (o.emotions && typeof o.emotions === 'object') {
    for (const [k, v] of Object.entries(o.emotions as Record<string, unknown>)) {
      if (!isEmotion(k)) continue
      const slot = sanitizeSlot(v)
      if (slot) out.emotions[k] = slot
    }
  }
  return out
}

/**
 * 资源缺口清单：哪些情绪完全没有可视表现（没表情也没动作）。
 * 只用于启动/诊断时告知，**不影响运行**（气泡和声音与模型无关）。
 */
export function modelGaps(map: ModelMap): Emotion[] {
  return EMOTIONS.filter((e) => {
    if (e === 'default') return false // default 本来就是"无表情在位"
    const s = map.emotions[e]
    return !s || (!s.expr && s.reaction === undefined)
  })
}
