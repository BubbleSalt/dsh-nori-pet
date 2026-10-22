/**
 * 情绪表现：情绪 → 表情 + 小动作 + 驻留回落。
 *
 * 从 src/client/widget.ts 搬出。规则都是从"表情看着不对"里长出来的：
 *  1) **同一表情不重复应用**（门控 lastExprApplied）：逐句推流时重复 expression() 会打断过渡、
 *     连口型都被重置；但应用失败**不能**记门控，否则这个表情以后永远不生效；
 *  2) 情绪**变化**时才附带播一次小动作，且**朗读中不抢**（currentSrc 非空时跳过）；
 *  3) `forceReaction` 允许朗读中也给反馈（摸头），`noReaction` 则完全禁动作（揉头时头部曲线
 *     会盖掉跟随）；揉头中一律不播 reaction；
 *  4) `default` 是"无表情在位"：resetExpression + 回 Idle 0，并清门控（下一个表情无条件生效）；
 *  5) 驻留超时回落 default（防表情冻住），思考态由 setThinking 独立管理、不被回落清掉。
 *
 * 模型操作全部注入，因此可以在 node 里断言这套规则（此前只能盯着桌宠看）。
 */
import type { Emotion } from './emotions.js'

/** 情绪 → Live2D 表现：expr = model3.json Expressions 的 Name；reaction = Motions.Reactions 下标 */
export const EMOTION_TABLE: Record<Emotion, { expr?: string; reaction?: number; holdMs?: number }> = {
  default:    { }, // 无表情：回待机动作
  happy:      { expr: '13_Happy',   reaction: 5 }, // 开心笑 + WakuWaku_in
  excited:    { expr: '01_KiraKira', reaction: 6 }, // 星星眼 + Wakuwaku_loop
  angry:      { expr: '03_Angry',   reaction: 7 },
  refuse:     { expr: '11_Disgust', reaction: 12 }, // 拒绝：厌恶脸 + NoNoNo
  sad:        { expr: '08_Tears' },
  doubt:      { expr: '10_Doubt',   reaction: 8 },
  troubled:   { expr: '09_Troubled', reaction: 9 },
  shy:        { expr: '04_Shy',   reaction: 0 }, // Nod
  surprised:  { expr: '01_KiraKira', reaction: 2 }, // 星光眼 + Stare_loop
  dizzy:      { expr: '02_Dizzy',   reaction: 10 },
  serious:    { expr: '12_Serious' },
  speechless: { expr: '06_Speechless', reaction: 1 }, // ShakeHead
  think:      { expr: '10_Doubt',   reaction: 3, holdMs: 15000 }, // 思考：Doubt + Stare_in
}

export const DEFAULT_HOLD_MS = 8000

export interface EmotionDriverDeps {
  /** 模型是否已加载（没加载就什么都不做） */
  ready: () => boolean
  /** 睡觉时不动表情（闭眼归睡觉逻辑管） */
  sleeping: () => boolean
  /** 正在揉头（此时不播 reaction，头部曲线会盖掉跟随） */
  patActive: () => boolean
  /** 正在朗读（情绪变化的小动作不抢） */
  speaking: () => boolean
  applyExpression: (expr: string) => void
  playMotion: (group: string, index: number) => void
  resetExpression: () => void
  /** 回待机动作（00_Idle）；揉头中不调用 */
  playIdle: () => void
  /** 诊断输出（必填：表情应用失败必须留下痕迹） */
  log: (msg: string, err?: unknown) => void
  /** 情绪→表现映射（模型契约）；不传则用 Nori 默认表。每次调用时取，便于配置热更新 */
  table?: () => Record<Emotion, { expr?: string; reaction?: number; holdMs?: number }>
}

export interface EmotionOptions {
  force?: boolean
  forceReaction?: boolean
  noReaction?: boolean
}

export interface EmotionDriver {
  set: (e: Emotion, opts?: EmotionOptions) => void
  /** 思考态开关：结束时不覆盖朗读中的真实情绪 */
  setThinking: (on: boolean) => void
  current: () => Emotion
  isThinking: () => boolean
  /** 清掉驻留计时（卸载用） */
  stop: () => void
}

export function createEmotionDriver(deps: EmotionDriverDeps): EmotionDriver {
  let currentEmotion: Emotion = 'default'
  let lastExprApplied = ''
  let thinking = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function scheduleReset(ms: number): void {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      if (!thinking && currentEmotion !== 'default') set('default')
    }, ms)
  }

  function set(e: Emotion, opts?: EmotionOptions): void {
    if (!deps.ready()) return
    if (deps.sleeping()) return
    if (e === 'default') {
      currentEmotion = 'default'
      lastExprApplied = '' // 清门控："无表情在位"语义
      if (timer !== null) { clearTimeout(timer); timer = null }
      deps.resetExpression()
      if (!deps.patActive()) deps.playIdle()
      return
    }
    const changed = currentEmotion !== e
    currentEmotion = e
    const cfg = (deps.table ? deps.table() : EMOTION_TABLE)[e]
    const expr = cfg.expr
    if (!expr) { deps.log('[nori-pet] emotion has no expression: ' + e); return }
    // 仅在实际变化（或 force 重申）时才应用，避免逐句推流反复打断过渡/口型
    if (opts?.force || expr !== lastExprApplied) {
      try {
        deps.applyExpression(expr)
        lastExprApplied = expr // 仅成功才记门控：失败则下次继续重试
      } catch (err) {
        deps.log('[nori-pet] expression fail: ' + expr, err)
      }
    }
    if (typeof cfg.reaction === 'number' && !deps.patActive() && !opts?.noReaction
      && (opts?.forceReaction || (changed && !deps.speaking()))) {
      deps.playMotion('Reactions', cfg.reaction)
    }
    scheduleReset(cfg.holdMs ?? DEFAULT_HOLD_MS)
  }

  return {
    set,
    setThinking: (on: boolean): void => {
      if (on) { thinking = true; set('think'); return }
      if (!thinking) return
      thinking = false
      if (currentEmotion === 'think') set('default')
    },
    current: () => currentEmotion,
    isThinking: () => thinking,
    stop: (): void => { if (timer !== null) { clearTimeout(timer); timer = null } },
  }
}
