/**
 * 播报管线：会话事件 → 断句 → 分批改写 → 广播 的状态机。
 *
 * 从 index.ts 搬出（原本这 400 行和"注册 HTTP 路由"混在同一个闭包里）。这里只做播报决策，
 * 不认识 cordis、不认识 HTTP、也不认识 WebSocket —— 广播通过 deps.broadcast 交出去。
 *
 * 状态全部是**有界**的（每个 Map/Set 都有上限与回收点），这几张表以前是"内存缓慢上涨"的来源：
 *   pending / fedBlocks / stepBand / stepChars / turnBand / turnSummaryText / turnChars /
 *   chunkedSteps / attemptTurn / toolCallNames / restFlushTimers / genTimers。
 */

import type { Config } from './config.js'
import type { NoriLogs } from './logs.js'
import { BOUNDARY, spokenUnits } from './segmentation.js'
import { endWithPeriod, friendlyApprovalReason } from './speakText.js'
import { applyBlockEnd, applyTextDelta, blockKey, clearFeedByPrefix } from './streamFeed.js'
import type { FeedState } from './streamFeed.js'
import { dropByPrefix, evictOldest } from './util.js'

/** 推给 /api/status 的统计（宿主与管线共享同一个可变对象） */
export interface HostStats {
  events: number
  chunks: number
  textDelta: number
  dupFeed: number
  assistant: number
  turnEnd: number
  lastAssistant: string
}

export interface PipelineReframe {
  enqueueReframe(sid: string, turn: number, text: string, mode?: 'reframe' | 'summary'): void
  reframeBlocks(sid: string, turn: number, blocks: string[]): void
  splitBlocks(text: string): string[]
  broadcastSummaryFallback(sid: string, turn: number, reason: string): void
  hasSummarized(turn: number): boolean
  hasQueuedSummary(turn: number): boolean
  dropQueuedReframe(turn: number): number
}

export interface PipelineDeps {
  config: Config
  logs: NoriLogs
  log: (...args: unknown[]) => void
  broadcast: (obj: unknown) => void
  reframe: PipelineReframe
  /** 从消息内容里取纯文本（宿主侧工具函数） */
  extractText: (content: unknown) => string
  /** 朗读长度硬截断（宿主侧工具函数） */
}

export function createPipeline(deps: PipelineDeps): {
  stats: HostStats
  handleAgentFrame: (payload: any) => void
  handleSessionEvent: (session: any, event: any) => void
  summaryCharsOf: (turn: number) => number
  clearBroadcastTimers: () => void
  clearTimers: () => void
} {
  const { config, log, broadcast, reframe, extractText } = deps
  const { broadcastSummaryFallback, dropQueuedReframe, enqueueReframe, hasQueuedSummary, hasSummarized, reframeBlocks, splitBlocks } = reframe

  const stats: HostStats = { events: 0, chunks: 0, textDelta: 0, dupFeed: 0, assistant: 0, turnEnd: 0, lastAssistant: '' }

  const chunkedSteps = new Set<string>() // 已走流式处理的 step（assistant/message 兜底防重复）


  const pending = new Map<string, string>() // `${sid}/${turn}/${step}` -> 未断句文本

  function flushKey(sid: string, key: string): void {
    // reframe 模式：整轮收集，pending 保留到 turn/end 统一合并改写（这里不能清）
    if (config.reframe) return
    const buf = pending.get(key)
    pending.delete(key)
    if (buf && buf.trim()) {
      const t = Number(key.split('/')[1]) || undefined
      stats.assistant += 1
      stats.lastAssistant = buf.trim().slice(0, 60)
      broadcast({ type: 'assistant', session: sid, text: buf.trim(), turn: t })
    }
  }

  // ── 改写合并批（低延迟流式改写）：句子成句即攒批，~150 字或 1.2s 无新句就改写广播，
  //    长 turn 中途即开始播，避免"整轮结束才统一改写"的高延迟 ──
  let batchSid = ''
  let batchTurn = -1
  let batchText = ''
  let batchTimer: ReturnType<typeof setTimeout> | null = null
  // 攒批上限与 detailMaxChars 同量级：攒太大等于把"一整段"塞进一次改写，
// 而超出细节轨的部分反正会被概括覆盖
const BATCH_MAX = 150
  const BATCH_IDLE_MS = 1200

  function flushBatch(): void {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null }
    const text = batchText.trim()
    const sid = batchSid
    const turn = batchTurn
    batchText = ''
    batchSid = ''
    batchTurn = -1
    if (text && sid) scheduleReframe(sid, turn, text)
  }

  function addToBatch(sid: string, turn: number, sentence: string): void {
    if (batchSid && (batchSid !== sid || batchTurn !== turn)) flushBatch() // turn 切换先收尾
    batchSid = sid
    batchTurn = turn
    batchText += sentence
    if (batchText.length >= BATCH_MAX) {
      flushBatch()
    } else {
      if (batchTimer) clearTimeout(batchTimer)
      batchTimer = setTimeout(flushBatch, BATCH_IDLE_MS)
    }
  }

  // 无句失声超时：流式输出停顿且迟迟不出标点（长 URL/代码/省略标点的段落）时，
  // 2s 后把已攒残留"截断并输出"，避免一直静默等待到 turn/end。持续有增量则每块重置计时。
  // ⚠ 碎片保护：agent 流式输出停顿（思考/工具间隙）常产生 <40 字的碎句（"包装""器："），
  //   不足门槛的残留不独立广播——滞留 pending，turn/end 整段拼接后再改写，避免给碎片"配音"。
  const REST_FLUSH_MS = 2000
  const REST_FLUSH_MIN = 40
  // eslint 无关：node/dom 双 types 下 setTimeout 返回类型不一致，统一放宽为 any
  const restFlushTimers = new Map<string, any>()
  function armRestFlush(sid: string, turn: number, key: string): void {
    const old = restFlushTimers.get(key)
    if (old) clearTimeout(old)
    restFlushTimers.set(key, setTimeout(() => {
      restFlushTimers.delete(key)
      const r = pending.get(key)
      if (!r) return
      const trimmed = r.trim()
      if (!trimmed || trimmed.length < REST_FLUSH_MIN) return // 碎片滞留 pending，等 turn/end collectTurnText 拼接
      pending.delete(key)
      // 不再做"超长就截断 + 省略号"：不定长残段只可能是超长原子串（长路径/URL/代码，词感知
      // 切分刻意不肯切），截断会正好切断它——而这正是要保护的东西。dsh 输出约 450 字/秒，
      // 攒到下一个标点只需零点几秒，等待代价远小于截断代价。
      if (config.reframe) addToBatch(sid, turn, trimmed) // 进改写批，正常链路广播
      else {
        stats.assistant += 1
        stats.lastAssistant = trimmed.slice(0, 60)
        broadcast({ type: 'assistant', session: sid, text: trimmed, turn })
      }
    }, REST_FLUSH_MS) as unknown as number)
  }
  function clearRestFlush(prefix: string): void {
    for (const [k, t] of [...restFlushTimers]) if (k.startsWith(prefix)) { clearTimeout(t); restFlushTimers.delete(k) }
  }
  function clearRestFlushOne(key: string): void {
    const t = restFlushTimers.get(key)
    if (t) { clearTimeout(t); restFlushTimers.delete(key) }
  }

  // ── 详读 / 概括 二选一（口径统一，不混用）──
  // 一段连续输出（= 一个 step）≤ detailMaxChars → 全文逐句详读；
  // 超过 → 该段一个字都不详读，整轮只播一次概括。
  // 为什么必须"整段"而非"逐句"判断：逐句判断会出现"前半念得详细、后半突然快进"的口径断层。
  // 输出速度约 300 token/s（≈450 字/秒），400 字约 0.9 秒即判定，长内容判定几乎无等待。
  type Band = 'detail' | 'sum'
  const stepBand = new Map<string, Band>() // key -> 该段轨道
  const stepChars = new Map<string, number>() // key -> 该段累计字数
  const turnBand = new Map<number, Band>()
  // 改写延时：首块立即发（开场不能慢），后续块等 reframeDelayMs —— 积累多时下一块往往直接进概括，
  // 不延时的话请求已经发出去又被取消，白烧一次调用
  const reframeSentOnce = new Set<number>()
  const delayTimers = new Map<number, ReturnType<typeof setTimeout>[]>()
  function cancelDelayedReframe(turn: number): number {
    const list = delayTimers.get(turn)
    if (!list) return 0
    for (const t of list) clearTimeout(t)
    delayTimers.delete(turn)
    return list.length
  }
  function scheduleReframe(sid: string, turn: number, text: string): void {
    const delay = config.reframeDelayMs ?? 0
    if (!reframeSentOnce.has(turn) || delay <= 0) {
      reframeSentOnce.add(turn)
      enqueueReframe(sid, turn, text)
      return
    }
    const timer = setTimeout(() => {
      const list = delayTimers.get(turn)
      if (list) delayTimers.set(turn, list.filter((t) => t !== timer))
      enqueueReframe(sid, turn, text)
    }, delay)
    delayTimers.set(turn, [...(delayTimers.get(turn) ?? []), timer])
  } // turn -> 轨道（sum 优先）
  const turnSummaryText = new Map<number, string>() // turn -> 被抑制的原文（供概括）
  const turnChars = new Map<number, number>() // turn -> 累计输出字数（判断整轮是否够长）

  function noteTurnChar(turn: number, n: number): void {
    const v = (turnChars.get(turn) ?? 0) + n
    turnChars.set(turn, v)
    evictOldest(turnChars, 32, turn)
  }

  /** 锁定某段为"概括轨"：停止一切细粒度播报，丢弃该 turn 尚未播出的琐碎内容。
   *  keepPending=true 时不丢 pending（turn/end 路径要用它收集本段尾巴）。 */
  function lockSummaryBand(sid: string, turn: number, key: string, reason: string, keepPending = false): void {
    if (turnBand.get(turn) === 'sum' && !keepPending) return
    turnBand.set(turn, 'sum')
    // 丢弃已排队的细粒度内容：概括会覆盖整段，避免"念一半 + 概括"重复
    if (!keepPending) {
      clearRestFlush(key)
      const dropped = dropQueuedReframe(turn)
    const cancelled = cancelDelayedReframe(turn)
      const prefix = `${sid}/${turn}/`
      let droppedPending = 0
      for (const [k, v] of [...pending]) {
        if (k.startsWith(prefix)) { droppedPending += v.length; pending.delete(k) }
      }
      log(`[dsh-nori-pet] summary band lock: ${reason} turn=${turn} 丢弃改写${dropped}条/取消未发${cancelled}条/待断句${droppedPending}字`)
    } else {
      log(`[dsh-nori-pet] summary band lock(end): ${reason} turn=${turn}`)
    }
  }


  function pushChunk(sid: string, turn: number, step: number, delta: string): void {
    stats.chunks += 1
    stats.textDelta += 1
    const key = `${sid}/${turn}/${step}`
    chunkedSteps.add(key) // 该 step 走过了流式（assistant/message 兜底应跳过）

    // ── 轨道判定（在播种内容之前）──
    noteTurnChar(turn, delta.length)
    let band: Band = stepBand.get(key) ?? 'detail'
    if (band === 'detail') {
      const acc = (stepChars.get(key) ?? 0) + delta.length
      stepChars.set(key, acc)
      evictOldest(stepChars, 64, key)
      if (config.summaryEnabled && acc > config.detailMaxChars) {
        stepBand.set(key, 'sum')
        evictOldest(stepBand, 64, key)
        lockSummaryBand(sid, turn, key, `本段 ${acc} 字 > ${config.detailMaxChars}`)
        band = 'sum'
      }
    }

    if (band === 'sum') {
      // 概括轨：只累积原文，不做断句/改写/广播（概括会一次覆盖整段）
      turnSummaryText.set(turn, (turnSummaryText.get(turn) ?? '') + delta)
      evictOldest(turnSummaryText, 8, turn)
      return
    }

    if (config.reframe) {
      // 流式断句→分批改写（低延迟）：句子成句即入批，攒 ~150 字或 1.2s 无新句就 flush。
      // 无断句标点的段落（如"先看当前 git 状态……错在哪"）不能一直滞留 pending——turn/end
      // 才 collect 会让它排到批次之后；故无边界且够长（≥maxSentence）时用同一份词感知切分
      // 软切入批，顺序恒等于原文，且绝不切开标识符。
      let rest = (pending.get(key) ?? '') + delta
      for (;;) {
        let idx = -1
        for (let i = 0; i < rest.length; i++) {
          if (BOUNDARY.has(rest[i])) {
            idx = i + 1
            while (idx < rest.length && BOUNDARY.has(rest[idx])) idx++ // 连续标点整组归当前句
            break
          }
        }
        if (idx > 0) {
          const sentence = rest.slice(0, idx).trim()
          rest = rest.slice(idx)
          if (sentence) {
            for (const u of spokenUnits(sentence, config.maxSentence)) addToBatch(sid, turn, u)
          }
          continue
        }
        // 无边界且已够长 → 先让断句模块切出"可朗读单元"（词感知、不切标识符）
        const units = rest.length >= config.maxSentence ? spokenUnits(rest, config.maxSentence) : []
        if (units.length > 1) {
          for (let n = 0; n < units.length - 1; n++) addToBatch(sid, turn, units[n]!)
          rest = units[units.length - 1]!
        }
        break
      }
      if (rest.length > config.maxSentence * 6) {
        // 兜底：极端不定长文本（数百字无标点的代码/路径）超过 6×maxSentence 时先把已攒部分
        // 入批（顺序不变、内容不丢），避免 pending 无界增长。正常情况到不了这里：上面
        // spokenUnits 早已切出多段。
        addToBatch(sid, turn, rest)
        rest = ''
      }
      if (rest) { pending.set(key, rest); armRestFlush(sid, turn, key) }
      else { pending.delete(key); clearRestFlushOne(key) }
      return
    }

    // ── reframe 关闭：实时按句广播原文（同一份 delta 只能走这里，绝不能再进改写批）──
    let buf = (pending.get(key) ?? '') + delta
    for (;;) {
      let idx = -1
      for (let i = 0; i < buf.length; i++) {
        if (BOUNDARY.has(buf[i])) {
          idx = i + 1
          while (idx < buf.length && BOUNDARY.has(buf[idx])) idx++ // 连续标点整组归当前句
          break
        }
      }
      if (idx < 0) break
      const sentence = buf.slice(0, idx).trim()
      buf = buf.slice(idx)
      // 长句再切成短朗读单元（同一份切分逻辑，widget 侧不重复切）
      if (sentence) {
        for (const unit of spokenUnits(sentence, config.maxSentence)) {
          stats.assistant += 1
          stats.lastAssistant = unit.slice(0, 60)
          broadcast({ type: 'assistant', session: sid, text: unit, turn })
        }
      }
    }
    // 超长兜底：防止单 step 无限累积
    if (buf.length > config.maxSentence * 3) {
      const units = spokenUnits(buf, config.maxSentence)
      for (let n = 0; n < units.length - 1; n++) {
        const unit = units[n]!
        stats.assistant += 1
        stats.lastAssistant = unit.slice(0, 60)
        broadcast({ type: 'assistant', session: sid, text: unit, turn })
      }
      // 注意：必须保留切点之后的尾巴——旧代码 buf = '' 会把软切之后的文本整段丢掉
      // （既不广播也不留 pending，长 URL / 无标点长段直接失声且无日志）
      buf = units.length ? units[units.length - 1]! : ''
    }
    if (buf) { pending.set(key, buf); armRestFlush(sid, turn, key) }
    else { pending.delete(key); clearRestFlushOne(key) }
  }

  /** 收集某 turn 的全部残留文本（reframe 模式的整轮文本） */
  function collectTurnText(sid: string, turn: number): string {
    const prefix = `${sid}/${turn}/`
    let buf = ''
    for (const [k, v] of [...pending]) {
      if (k.startsWith(prefix)) { pending.delete(k); if (v) buf += v }
    }
    return buf
  }


  /**

   * 本代一次性定时器登记表：所有"稍后要做事"的 setTimeout 都登记进来，fiber dispose 时统一清。
   *
   * 为什么必须收口（实测踩过）：不清的定时器在热重载后仍会触发，带着**旧代的状态**再投递/再
   * 播报一次（同一段被改写播报两遍）。单个地方各清一次容易漏（概括等待上限这处就漏过），
   * 所以这里提供一个统一入口。
   */
  const genTimers = new Set<any>()

  function later(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      genTimers.delete(id)
      fn()
    }, ms)
    genTimers.add(id)
  }

  const toolCallNames = new Map<string, string>() // callId → 工具名（tool/call 才有名字）
  // ── 实时流：当前 dsh（session format v4）的正文不走 `assistant/chunk`（v0 已移除），而是
  //    `agent/assistant-stream`（进程本地、非持久）：start 帧带 turn/step，chunk 帧带
  //    `frame.chunk`。文本块只在 `block-end` 携带完整内容（{type:'block-end',block:{type:'text',
  //    text}}），部分 provider 还会发 `text-delta` 块内增量，两条都接。──
  //   ⚠ `agent/assistant-stream` 是 **scope-filtered** 事件（`this: Scoped<Agent>`）：
  //     agent 作用域内的监听器只收自己那个 agent。插件在**外层作用域**注册，必须显式
  //     `{ global: true }` 才能收到任何 agent 的帧——漏掉这个参数时监听器永不触发、
  //     且不报错（旧版因此整条流式播报静默，是"长内容一口气读完"的根因之一）。
  const attemptTurn = new Map<string, { turn: number; step: number }>()
  /** 块投喂水位（见 streamFeed.ts）：保证同一块内容被投喂多次时只播一遍 */
  const fedBlocks: FeedState = new Map()
  /** 水位表容量上限：正常靠 turn/end 回收，这里兜底防异常结束的 attempt 让它无界增长 */
  const pruneFeed = (): void => {
    if (fedBlocks.size <= 256) return
    const first = fedBlocks.keys().next().value
    if (first !== undefined) fedBlocks.delete(first)
  }

  /** agent/assistant-stream 的一帧（流式正文） */
  function handleAgentFrame(payload: any): void {
    const frame = payload?.frame
    if (!frame) return
    const sid = String(payload?.agent?.session?.id ?? '')
    if (!sid) return
    if (frame.type === 'start') {
      attemptTurn.set(String(frame.attemptId), { turn: Number(frame.turn ?? 0), step: Number(frame.step ?? 0) })
      evictOldest(attemptTurn, 64) // 防无界增长（异常结束的 attempt 会残留）
      return
    }
    if (frame.type === 'end') { attemptTurn.delete(String(frame.attemptId)); return }
    if (frame.type !== 'chunk') return
    const c = frame.chunk
    if (!c || typeof c.type !== 'string') return
    const ts = attemptTurn.get(String(frame.attemptId))
    const feed = (text: string): void => { if (text) pushChunk(sid, ts?.turn ?? 0, ts?.step ?? 0, text) }
    // 协议（实测当前 DSH）：文本不走 text-delta，而是 `block-end` 携带整块内容：
    //   { type:'block-end', index, block:{ type:'text'|'reasoning'|'tool-call', text } }
    // 旧的 `text-delta` 分支保留兼容（其他 provider/版本可能仍发增量）。
    // ⚠ `block-end` 是**整块全文快照**，不是增量；同一块可能被投喂多次（provider 重试、
    //   与 text-delta 重叠、帧重复处理）。纯追加会让同一段内容念两遍（实测：整段 ×2、
    //   `A` `B` 之后又来一条 `A+B`）。这里用块水位把它变成幂等投喂，只补"还没投喂过的那截"。
    if (c.type === 'text-delta') {
      if (typeof c.text === 'string') {
        const bk = blockKey(sid, ts?.turn ?? 0, ts?.step ?? 0, c.index)
        feed(applyTextDelta(fedBlocks, bk, c.text))
        pruneFeed()
      }
      return
    }
    if (c.type !== 'block-end') return
    const block = c.block
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return // 只播正文：reasoning 规划与 tool-call 参数不朗读
    const bk = blockKey(sid, ts?.turn ?? 0, ts?.step ?? 0, c.index)
    const r = applyBlockEnd(fedBlocks, bk, block.text)
    if (r.delta) feed(r.delta)
    else if (r.dup) {
      stats.dupFeed += 1
      // 只在真正发生重复投喂时记一行（正常情况不该出现；出现即说明上游在重复送同一块，
      // 这条日志 + /api/status 的 dupFeed 就是它的观测口）
      log(`[dsh-nori-pet] dup feed suppressed: ${bk} len=${block.text.length}`)
    }
    pruneFeed()
  }

  /** session/event 的一条事件（回放过滤已在 events.ts 做完） */
  function handleSessionEvent(session: any, event: any): void {
      const sid: string = session?.id ?? '?'
      const data = event?.data
    if (!data) return
    switch (event.type) {
      case 'assistant/message': {
        // 兜底：仅当该 step 从未流式（chunkedSteps 无记录）才收集完整文本，
        // 避免流式已广播后 message 又把整段重复收集（turn/end 二次改写朗读）
        const mkey = `${sid}/${data.turn}/${data.step}`
        if (!chunkedSteps.has(mkey)) {
          const full = extractText((data as any)?.message?.content)
          if (full && !pending.has(mkey)) pending.set(mkey, full)
        }
        flushKey(sid, mkey)
        break
      }
      case 'approval/asked': {
        // 权限申请提醒：原文播报（不走改写，保证准确）
        const tool = String((data as any)?.toolName ?? '')
        // reason 由 dsh 拼接（`escalate sandbox to <mode>: <理由>`），理由通常自带句号；
        // 全程用 endWithPeriod 收口，避免"固定前缀 + 自带句号"拼出 `。。`（曾经的气泡双句号）。
        const reason = friendlyApprovalReason(String((data as any)?.reason ?? ''))
        const text = endWithPeriod('有权限申请' + (tool ? '：' + tool : '') + (reason ? '。原因：' + reason : ''))
        broadcast({ type: 'approval', session: sid, text })
        break
      }
      case 'turn/end': {
        stats.turnEnd += 1
        // 清理该 turn 的流式标记与失声超时器，防无限增长（旧版 reframe 分支关闭时不清
        // chunkedSteps → 该 Set 只增不减，且 turn/step 复用会误跳过 message 兜底）
        const prefix = `${sid}/${data.turn}/`
        dropByPrefix(chunkedSteps, prefix) // Set 只增不减：turn 回收时一并清
        clearRestFlush(prefix)
        if (config.reframe) {
          // 收尾批次（低延迟流式改写的剩余句子），再 collect 未断句残留
          flushBatch()
          const tailText = collectTurnText(sid, data.turn).trim()
          // 概括轨：本段正文不逐句播，整轮只播一次概括（见 lockSummaryBand 注释）
          const band = turnBand.get(data.turn)
          if (band === 'sum' || (tailText.length > 0 && (turnChars.get(data.turn) ?? 0) > config.detailMaxChars * 2)) {
            if (band !== 'sum') lockSummaryBand(sid, data.turn, prefix, `整轮 ${turnChars.get(data.turn)} 字 > ${config.detailMaxChars * 2}`, true)
            const raw = ((turnSummaryText.get(data.turn) ?? '') + tailText).trim()
            turnSummaryText.delete(data.turn)
            if (raw) {
              const turnNo = data.turn
              enqueueReframe(sid, turnNo, raw, 'summary')
              // 等待上限：LLM 慢时不至于让宠物静默到让人以为挂了
              later(() => {
                if (!hasQueuedSummary(turnNo)) return // 已出队处理/已完成
                if (hasSummarized(turnNo)) return
                broadcastSummaryFallback(sid, turnNo, 'wait-timeout')
              }, config.summaryWaitMs)
            }
          } else if (tailText) {
            const blocks = splitBlocks(tailText)
            void reframeBlocks(sid, data.turn, blocks)
          }
          // 轨道状态回收（防无界增长）
          turnBand.delete(data.turn)
          turnChars.delete(data.turn)
          turnSummaryText.delete(data.turn)
          dropByPrefix(stepBand, prefix)
          dropByPrefix(stepChars, prefix)
          clearFeedByPrefix(fedBlocks, prefix) // 块投喂水位随 turn 回收，防无界增长
          broadcast({ type: 'turn-end', session: sid, turn: data.turn, reason: data.reason?.kind })
          break
        }
        // reframe 关闭时的兜底：把该 turn 的未断句残留原文直接播掉
        for (const [k, v] of [...pending]) {
          if (k.startsWith(prefix)) {
            pending.delete(k)
            if (v && v.trim()) { stats.assistant += 1; stats.lastAssistant = v.trim().slice(0, 60); broadcast({ type: 'assistant', session: sid, text: v.trim(), turn: data.turn }) }
          }
        }
        broadcast({ type: 'turn-end', session: sid, turn: data.turn, reason: data.reason?.kind })
        break
      }
      case 'user/message': {
        const t = extractText(data.content)
        if (t) broadcast({ type: 'user', session: sid, text: t.slice(0, 300) })
        break
      }
      case 'tool/call': {
        // 工具名只在这里：tool/result 的 ToolResultMessage 只有 { role, source{kind,callId},
        // toolCallId, content, isError }，既无 name 也无顶层 callId（旧代码取 message.name
        // ?? message.callId 恒得空串，广播出来是 name:""）
        if (data.callId) toolCallNames.set(String(data.callId), String(data.name ?? ''))
        evictOldest(toolCallNames, 200) // 防无界增长：会话异常结束时会残留
        break
      }
      case 'tool/result': {
        const callId = String(data.message?.toolCallId ?? data.message?.source?.callId ?? '')
        const name = toolCallNames.get(callId) ?? ''
        toolCallNames.delete(callId)
        broadcast({ type: 'tool', session: sid, name })
        break
      }
      default:
        break
    }
  }

  return {
    summaryCharsOf: (turn: number): number => (turnSummaryText.get(turn) ?? '').length,
    clearBroadcastTimers: (): void => {
      if (batchTimer) { try { clearTimeout(batchTimer) } catch { /* ignore */ } batchTimer = null }
      for (const t of restFlushTimers.values()) { try { clearTimeout(t) } catch { /* ignore */ } }
      restFlushTimers.clear()
      for (const t of genTimers) { try { clearTimeout(t) } catch { /* ignore */ } }
      genTimers.clear()
    },
    stats,
    handleAgentFrame,
    handleSessionEvent,
    clearTimers: (): void => { for (const t of genTimers) { try { clearTimeout(t) } catch { /* ignore */ } } genTimers.clear() },
  }
}
