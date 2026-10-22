/**
 * turn 路由：一条 assistant 文本该**排队**还是**打断**。
 *
 * 改写路径下发的是数字 turn `12`，概括路径下发的是字符串 `12-sum`；早先这里只认数字，
 * 概括那批拿到 null → 落到打断分支 → 正在读的句子被腰斩、队列里剩下的句子作废
 * （实测："第一句读了一半，第二句气泡出现并打断朗读"，最后一句凭空消失）。
 * 现在统一按字符串比较，并把 `N-sum` 归一到同一个逻辑 turn `N`：同一轮回答的话应当排队。
 */

export type TurnRoute = {
  /** 归一后的逻辑 turn（`12` 与 `12-sum` → `12`）；null = 没有 turn 身份 */
  base: string | null
  action: 'append' | 'interrupt' | 'replace'
}

export function planAssistantRoute(current: string | null, turn: number | string | null | undefined): TurnRoute {
  const raw = turn === undefined || turn === null ? null : String(turn)
  const base = raw === null ? null : raw.replace(/-sum$/, '')
  if (base === null) return { base: null, action: 'interrupt' }
  const cur = current === null ? null : current.replace(/-sum$/, '') // 入参也归一：调用方存的是 base 也好、原始 turn 也好，判定都一致
  // 概括帧（N-sum）同轮到达 → 替换掉尚未开播的细粒度内容，别让同一段话被讲两遍
  // 概括帧与细节帧同 turn：不覆盖，接在后面播（设计是「先读两句，剩下概括」） { base, action: 'replace' }
  if (cur === null || base === cur) return { base, action: 'append' }
  return { base, action: 'interrupt' }
}
