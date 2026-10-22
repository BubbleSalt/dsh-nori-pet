/**
 * 摸头（按住 + 拖动摩擦）：触发判定 + 台词表。
 *
 * 从 src/client/widget.ts 搬出。三条规则以前只写在指针事件回调里：
 *  1) **按住 ≥2000ms 且拖动 ≥20px** 才算摸头 —— 单纯点一下不该让桌宠说话；
 *  2) 同一次按住只触发一次（松手才算结束）；
 *  3) 台词冷却 6s：冷却期内继续揉只保留"头部跟随"反馈，不再说话 —— 否则连续摩擦会
 *     一直刷台词（体感像复读机）。
 * 另外头部跟随量归一化到 -1..1，避免鼠标拖出画布后参数越界。
 */
import type { Emotion } from './emotions.js'

/** 头部区域（画布归一化坐标） */
export const HEAD_ZONE = { x0: 0.2, x1: 0.8, y1: 0.42 } as const

export function inHeadZone(x: number, y: number): boolean {
  return x >= HEAD_ZONE.x0 && x <= HEAD_ZONE.x1 && y <= HEAD_ZONE.y1
}

/** 摸头台词（绑定情绪：说话时同时切对应表情） */
export const PAT_REPLIES: Array<{ text: string; emo: Emotion }> = [
  { text: '头发都被你揉乱啦。', emo: 'shy' },
  { text: '再摸就要收费啦。', emo: 'happy' },
  { text: 'Nori不是小狗啦。', emo: 'speechless' },
  { text: '你是不是把Nori当宠物了？', emo: 'doubt' },
  { text: '为什么摸我的头呀。', emo: 'doubt' },
  { text: '摸完要负责陪我玩游戏哦。', emo: 'happy' },
  { text: '你摸Nori，Nori也不会掉毛的。', emo: 'speechless' },
  { text: '好乖....啊，说反了，是你在摸我。', emo: 'shy' },
  { text: '只有Nori有摸头待遇吗？', emo: 'doubt' },
  { text: '嘿嘿，摸摸头很舒服，感觉芯片都要开心得发热了。', emo: 'happy' },
  { text: '这算是表扬吗？那我记下来了。', emo: 'shy' },
]

export interface PatMove {
  /** 头部跟随目标（-1..1，画布中心为 0） */
  headX: number
  headY: number
  /** 本次移动是否让桌宠开口说话（每次按住最多一次，且受冷却限制） */
  speaks: boolean
}

export interface PatDetector {
  start: (now: number, clientX: number, clientY: number) => void
  move: (normX: number, normY: number, clientX: number, clientY: number, now: number) => PatMove
  end: () => void
  active: () => boolean
}

export interface PatOptions {
  /** 至少按住多久（ms） */
  holdMs?: number
  /** 累计拖动距离（px） */
  distPx?: number
  /** 台词冷却（ms） */
  cooldownMs?: number
}

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v))

export function createPatDetector(opts: PatOptions = {}): PatDetector {
  const holdMs = opts.holdMs ?? 2000
  const distPx = opts.distPx ?? 20
  const cooldownMs = opts.cooldownMs ?? 6000

  let active = false
  let downAt = 0
  let dist = 0
  let lastX = 0
  let lastY = 0
  let triggered = false
  let cooldownUntil = 0

  return {
    start: (now: number, clientX: number, clientY: number): void => {
      active = true
      downAt = now
      dist = 0
      triggered = false
      lastX = clientX
      lastY = clientY
    },
    move: (normX: number, normY: number, clientX: number, clientY: number, now: number): PatMove => {
      const headX = clamp1((normX - 0.5) * 2)
      const headY = clamp1((normY - 0.5) * 2)
      if (!active) return { headX, headY, speaks: false }
      const dx = clientX - lastX
      const dy = clientY - lastY
      dist += Math.sqrt(dx * dx + dy * dy)
      lastX = clientX
      lastY = clientY
      if (triggered || now - downAt <= holdMs || dist <= distPx) return { headX, headY, speaks: false }
      triggered = true
      if (now < cooldownUntil) return { headX, headY, speaks: false } // 冷却中：只跟随不说话
      cooldownUntil = now + cooldownMs
      return { headX, headY, speaks: true }
    },
    end: (): void => { active = false; triggered = false },
    active: () => active,
  }
}
