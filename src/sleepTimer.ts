/**
 * 入睡计时器：N 分钟无交互 → 入睡；任何交互/朗读 → 唤醒。
 *
 * 从 src/client/widget.ts 搬出。原版把「是否该睡」和「怎么播睡姿」写在一起，于是这几条规则
 * 只能靠盯着桌宠看才能发现违反了：
 *  1) **turn 未结束不入睡**（user → turn-end 之间）——否则回答还在推流，桌宠先睡了；
 *  2) **朗读中不入睡**（长回复逐句播放可能超过计时阈值），播完再从头计时；
 *  3) 睡眠中**悬停不算唤醒**（只有点击/滚轮/朗读算），否则鼠标路过就睁眼；
 *  4) 唤醒要能治「假醒」：逻辑已醒但动作还卡在睡姿循环（FORCE 循环未被清掉）。
 *
 * 这里只管计时与状态；播什么动作、清什么表情都由 deps 注入，所以可以在 node 里单测。
 */
export interface SleepTimerDeps {
  /** 多久没交互就睡（默认 90s） */
  sleepAfterMs?: number
  /** 现在能不能睡（模型已加载 + 没有正在朗读的内容） */
  canSleep: () => boolean
  /** 该睡了：播睡姿、清表情、说一句 */
  onSleep: () => void
  /** 醒了：wasSleeping 区分「真醒」与「假醒防御」 */
  onWake: (wasSleeping: boolean) => void
}

export interface SleepTimer {
  /** 任何交互/朗读后调用：重新计时（turn 活跃时只清掉计时，不排新的） */
  reset: () => void
  wake: () => void
  setTurnActive: (on: boolean) => void
  isSleeping: () => boolean
  /** 初始就处于睡眠态（模型未加载时的开场），不排入睡计时 */
  markSleeping: () => void
  stop: () => void
}

export const SLEEP_AFTER_MS = 90000

export function createSleepTimer(deps: SleepTimerDeps): SleepTimer {
  const afterMs = deps.sleepAfterMs ?? SLEEP_AFTER_MS
  let sleeping = false
  let turnActive = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear(): void {
    if (timer !== null) { clearTimeout(timer); timer = null }
  }

  function reset(): void {
    // turn 未结束不入睡；但要把已排的计时清掉，等 turn-end 再重新排
    if (turnActive) { clear(); return }
    clear()
    timer = setTimeout(goSleep, afterMs)
  }

  function goSleep(): void {
    timer = null
    if (sleeping) return
    if (!deps.canSleep()) { reset(); return }
    sleeping = true
    deps.onSleep()
  }

  function wake(): void {
    const was = sleeping
    sleeping = false
    deps.onWake(was)
    reset()
  }

  return {
    reset,
    wake,
    setTurnActive: (on: boolean) => {
      turnActive = on
      if (on) clear()
    },
    isSleeping: () => sleeping,
    markSleeping: () => { sleeping = true },
    stop: clear,
  }
}
