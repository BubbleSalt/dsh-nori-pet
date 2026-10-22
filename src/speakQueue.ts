/**
 * 朗读队列：**打断 / 追加 / 优先插入**的排队策略。
 *
 * 从 src/client/widget.ts 搬出。这三条策略踩过的坑都留在这里，别挪回渲染代码里：
 *  1) 打断前先预合成新首句再切旧音频 —— 否则切断瞬间静音，还要等 TTS 好几秒（实测："停顿了
 *     一会才说话"）。
 *  2) 打断**不等于丢掉内容** —— 队列里没读的句子声音停掉，但要以气泡补出来，否则用户既听不到
 *     也看不到，只会怀疑"是不是没读出来"。
 *  3) 优先插入（摸头台词）只抢队首，**保留剩余队列** —— 不能截断后面还没读的话。
 *
 * 这里只管排队与决策；播放、合成、DOM 全部通过 deps 注入，所以可以在 node 里直接单测
 * （此前这段逻辑只能靠"盯着桌宠听"验证）。
 */
import { hashText } from './util.js'
import { cleanSpeech, SPEAK_MAX, spokenUnits } from './segmentation.js'
import { parseTaggedSentences } from './speakText.js'

export interface SpeakQueueDeps {
  /** 朗读一段文本（token 用于作废在途播放） */
  speakOne: (text: string, token: number) => Promise<void>
  /** 预合成首句（结果进缓存即可，返回值不看） */
  prewarm: (unit: string, token: number) => Promise<unknown>
  /** 该句是否已在合成缓存里（命中就无需等） */
  hasCached: (unit: string) => boolean
  currentToken: () => number
  /** 作废在途 TTS 与当前句 */
  bumpToken: () => void
  /** 停掉当前正在播的音频 */
  stopCurrent: () => void
  isMuted: () => boolean
  /** 朗读唤醒（睡着的桌宠被叫醒） */
  wake: () => void
  /** 被打断丢弃的句子 → 用气泡补出来（每次最多两句，防刷屏） */
  onDropped: (units: string[]) => void
  /** 静音时仍显示气泡（只显示第一句） */
  onPreview: (unit: string) => void
  log: (msg: string) => void
}

export interface SpeakQueue {
  interrupt: (text: string) => void
  /** 用这段文本**替换**尚未开播的排队内容（概括覆盖细粒度播报用；不打断正在播的那句） */
  replacePending: (text: string) => void
  append: (text: string) => void
  priority: (text: string) => void
  /** 队列里还有活（含正在播）——睡觉计时器等据此让路 */
  busy: () => boolean
  pendingCount: () => number
  /** 被打断丢弃（改气泡）的文本条数，/api/speak 上报用 */
  dropped: () => number
  /** 等待队列排空（测试与关停用） */
  drain: () => Promise<void>
}

const PLAYED_MAX = 30

export function createSpeakQueue(deps: SpeakQueueDeps): SpeakQueue {
  const { speakOne, prewarm, hasCached, currentToken, bumpToken, stopCurrent, isMuted, wake, onDropped, onPreview, log } = deps

  const pending: string[] = []
  let pumping = false
  let hold = 0 // 打断预合成期间挂住队列，避免旧循环把新文本当自己的句子播掉
  let droppedCount = 0
  const played: string[] = []

  /** 取证：重复朗读检测（只 warn，不改行为） */
  function notePlayed(text: string): void {
    const h = hashText(text)
    if (played.includes(h)) log('[nori-pet] REPEAT PLAY detect: hash=' + h + ' text=' + text.slice(0, 40))
    played.push(h)
    if (played.length > PLAYED_MAX) played.shift()
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      while (pending.length && hold === 0) {
        const text = pending.shift()!
        await speakOne(text, currentToken())
      }
    } finally {
      pumping = false
    }
  }

  /** 新 turn：打断当前朗读，重排为最新文本（见文件头 1、2 两条） */
  function interrupt(text: string): void {
    notePlayed(text)
    wake()
    if (pending.length) {
      const lost = pending.splice(0, pending.length)
      droppedCount += lost.length
      const units: string[] = []
      for (const t of lost) {
        const plain = cleanSpeech(t)
        for (const u of spokenUnits(plain, SPEAK_MAX).slice(0, 2)) units.push(u)
      }
      onDropped(units)
      log(`[nori] interrupt: ${lost.length} 条未读文本改以气泡呈现`)
    }
    pending.push(text)
    hold += 1
    const switchNow = (): void => {
      bumpToken()
      stopCurrent()
      hold = Math.max(0, hold - 1)
      void pump()
    }
    const firstUnit = spokenUnits(cleanSpeech(parseTaggedSentences(text)[0]?.text ?? text), SPEAK_MAX)[0]
    if (isMuted() || !firstUnit || hasCached(firstUnit)) {
      switchNow()
      return
    }
    void prewarm(firstUnit, currentToken()).then(switchNow, switchNow)
  }

  /**
   * 概括覆盖：丢掉尚未开播的排队内容，换成这一段。
   * 与 interrupt 的区别——不 bumpToken、不 stopCurrent：正在播的那句照常播完，
   * 也不会把被丢掉的文本再以气泡形式补出来（那些内容本来就会被概括覆盖）。
   */
  function replacePending(text: string): void {
    notePlayed(text)
    wake()
    if (isMuted()) {
      const first = parseTaggedSentences(text)[0]
      if (first && first.text) onPreview(first.text)
      return
    }
    pending.splice(0, pending.length)
    pending.push(text)
    void pump()
  }

  /** 同 turn 追加：加入队列尾部，不打断当前（读完上一段再接） */
  function append(text: string): void {
    notePlayed(text)
    wake()
    if (isMuted()) {
      const first = parseTaggedSentences(text)[0]
      if (first && first.text) onPreview(first.text)
      return
    }
    pending.push(text)
    void pump()
  }

  /** 优先插入（摸头等反馈台词）：抢队首立即说，但保留其余等待文本 */
  function priority(text: string): void {
    notePlayed(text)
    wake()
    bumpToken()
    stopCurrent()
    pending.unshift(text)
    void pump()
  }

  return {
    interrupt,
    replacePending,
    append,
    priority,
    busy: () => pumping || pending.length > 0,
    pendingCount: () => pending.length,
    dropped: () => droppedCount,
    drain: async (): Promise<void> => { await pump() },
  }
}
