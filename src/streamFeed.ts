/**
 * 流式投喂水位：把"同一块内容被投喂多次"变成幂等操作。
 *
 * 真实踩坑（用户听到同一句被念两遍，trace 实测 2026-10-22）：
 *   `agent/assistant-stream` 的 `block-end` 帧携带的是**整块全文**（不是增量），
 *   而同一个块可能被投喂不止一次——provider 重试、`text-delta` 与 `block-end` 重叠、
 *   或同一帧被重复处理。`pushChunk` 是纯追加（`pending + delta`），于是：
 *
 *   实测 trace（同一 turn）：
 *     IN: 明智的选择。…别推荐半天你买不到。明智的选择。…别推荐半天你买不到。   ← 整块 ×2
 *     IN: 连续改写两次是之前修过的问题（…）。先取证，不猜：连续改写两次是之前修过的问题（…）。
 *     IN: 我来查 DSH 的启动耗时。 ／ 先找它的日志和启动链路。 ／ 我来查 DSH 的启动耗时。先找它的日志和启动链路。
 *                                                            ↑ 第三次把前两句又念一遍
 *
 * 前两次是"一次改写里文字重复"，第三次是两个块各播一次、随后整段又播一次——
 * 听感都是"同一段被连续念两次"。原有的 `enqueueReframe` 指纹去重只能挡住
 * **整段完全相同**的重复投喂；这里的重复发生在更上游（拼批之前），整段并不相同（是 A 与 A+B），
 * 所以必须让投喂本身幂等。
 *
 * 语义约定：
 *  · `text-delta` 是**增量**（协议名即如此）→ 直接累进水位并投喂；
 *  · `block-end` 是**整块全文**（权威快照）→ 与水位比较，只投喂"还没投喂过的那截"。
 *    因为是快照而非增量，所以既兼容"先进增量、后到全文"，也兼容"全文重复投递"，
 *    且**不需要**对中文做任何猜测式去重（不会误伤"哈哈哈""好的好的"这类正常重复）。
 */

/** 块水位：键 = `${sid}/${turn}/${step}#${blockIndex}` → 该块已投喂的文本 */
export type FeedState = Map<string, string>

export const blockKey = (sid: string, turn: number, step: number, index: unknown): string =>
  `${sid}/${turn}/${step}#${typeof index === 'number' && Number.isFinite(index) ? index : 0}`

/**
 * 投喂一条增量（`text-delta`）。返回要投喂的文本（空串=不投喂）。
 * 增量永远是新内容，直接累进水位。
 */
export function applyTextDelta(state: FeedState, key: string, piece: string): string {
  if (!piece) return ''
  state.set(key, (state.get(key) ?? '') + piece)
  return piece
}

export interface BlockEndResult {
  /** 需要投喂的文本（空串 = 这块内容已经投喂过了，不要重复投喂） */
  delta: string
  /** 是否判定为重复投喂（用于观测：真的发生时能知道是哪条路径在重复送） */
  dup: boolean
}

/**
 * 投喂一条整块全文（`block-end`）。只返回"尚未投喂过的那截"。
 *
 * 四种关系：
 *  1. 首次（水位空）            → 全文
 *  2. 全文以水位为前缀          → 只投喂剩余部分；完全相同则 dup
 *  3. 水位以全文为前缀          → 已投喂过更长的内容，dup（重复/回退的快照）
 *  4. 其它（如重试产出了不同文本）→ 关系不明，按新内容整块投喂
 */
export function applyBlockEnd(state: FeedState, key: string, fullText: string): BlockEndResult {
  const prev = state.get(key) ?? ''
  if (!fullText) return { delta: '', dup: false }
  if (!prev) {
    state.set(key, fullText)
    return { delta: fullText, dup: false }
  }
  if (fullText.startsWith(prev)) {
    state.set(key, fullText)
    const rest = fullText.slice(prev.length)
    return rest ? { delta: rest, dup: false } : { delta: '', dup: true }
  }
  if (prev.startsWith(fullText)) return { delta: '', dup: true }
  state.set(key, fullText)
  return { delta: fullText, dup: false }
}

/** 回收某 turn 的全部水位（turn/end 调用，防无界增长）。返回清理条数。 */
export function clearFeedByPrefix(state: FeedState, prefix: string): number {
  let n = 0
  for (const k of [...state.keys()]) if (k.startsWith(prefix)) { state.delete(k); n += 1 }
  return n
}
