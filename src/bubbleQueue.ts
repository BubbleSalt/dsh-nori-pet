/**
 * 气泡队列：每条气泡独立计时（20s 后淡出、450ms 后移除），同屏最多 6 条，超了挤掉最旧的。
 *
 * 从 src/client/widget.ts 搬出。原实现里三条规则混在 DOM 操作中间：
 *  1) **每条独立淡出** —— 后一条出现不该重置前一条的计时（否则一直说话时旧气泡永不离场）；
 *  2) 上限 6 条，挤掉的是**最旧**的那条（DOM 第一个）；
 *  3) 淡出动画 450ms 结束后才真正移除 —— 提前移除会看到"闪一下消失"。
 * 另外把"这条气泡实际占了几行"量出来交给上层：断句预算（SPEAK_MAX=34）只能靠这个真机信号核对。
 *
 * DOM 通过 deps 注入，可以在 node 里用假元素单测。
 */
export interface BubbleDeps<T> {
  /** 创建并挂载一个气泡，返回元素句柄 */
  mount: (text: string) => T
  /** 开始淡出（加 class） */
  fade: (el: T) => void
  /** 真正移除 */
  remove: (el: T) => void
  /** 量这条气泡占了几行（拿不到返回 null） */
  measureLines?: (el: T) => number | null
  /** 改写气泡文案（合成失败时补一句"没读出来"，避免看着像正常播报却没有任何声音） */
  retag?: (el: T, text: string) => void
  /** 同屏上限（默认 6） */
  maxBubbles?: number
  /** 停留时长（默认 20s） */
  lifeMs?: number
  /** 淡出动画时长（默认 450ms） */
  fadeMs?: number
  onLines?: (lines: number) => void
}

export interface BubbleQueue<T> {
  /** 显示一条气泡，返回句柄（供后续标记合成失败） */
  show: (text: string) => T
  /** 改写某条气泡的文案（例如补"（没读出来）"） */
  retag: (el: T, text: string) => void
  /** 当前屏上的气泡数 */
  count: () => number
  /** 清掉所有气泡与计时（卸载用） */
  clear: () => void
}

export function createBubbleQueue<T>(deps: BubbleDeps<T>): BubbleQueue<T> {
  const max = deps.maxBubbles ?? 6
  const lifeMs = deps.lifeMs ?? 20000
  const fadeMs = deps.fadeMs ?? 450
  const live: T[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()

  function schedule(fn: () => void, ms: number): void {
    const h = setTimeout(() => { timers.delete(h); fn() }, ms)
    timers.add(h)
  }

  return {
    show: (text: string): T => {
      const el = deps.mount(text)
      live.push(el)
      if (deps.measureLines) {
        const n = deps.measureLines(el)
        if (n !== null && n > 0) deps.onLines?.(n)
      }
      // 超出上限：挤掉最旧的一条（DOM 第一个）
      while (live.length > max) {
        const oldest = live.shift()!
        deps.remove(oldest)
      }
      schedule(() => {
        deps.fade(el)
        schedule(() => {
          const i = live.indexOf(el)
          if (i >= 0) live.splice(i, 1)
          deps.remove(el)
        }, fadeMs)
      }, lifeMs)
      return el
    },
    retag: (el: T, text: string): void => { deps.retag?.(el, text) },
    count: () => live.length,
    clear: (): void => {
      for (const h of timers) clearTimeout(h)
      timers.clear()
      for (const el of live.splice(0)) deps.remove(el)
    },
  }
}
