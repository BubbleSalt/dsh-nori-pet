/**
 * 宿主 WebSocket 客户端：连接、握手、重连、自愈。
 *
 * 从 src/client/widget.ts 搬出。这里的每条规则都对应一次线上故障：
 *  1) **后台标签页不重连**（`document.hidden` 时不排重连）—— 否则后台开着十几个标签会反复撞宿主；
 *  2) 回到前台必须 `ensure()`：hidden 期间断掉的连接不会自己接回来，
 *     表现是"新消息收不到、Nori 永远醒不来"；
 *  3) 宿主重启/长连接被服务端回收时靠**周期 ensure** 兜底；
 *  4) 重连退避 1s×次数，最高 10s，最多 10 次 —— 避免狂刷。
 *
 * 传输细节（WebSocket 构造、定时器）全部注入，可在 node 里用假连接单测。
 */
export interface WsLike {
  readyState: number
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  send: (data: string) => void
  close: () => void
}

export const WS_CONNECTING = 0
export const WS_OPEN = 1

export interface WsClientDeps {
  url: () => string
  /** 构造连接（测试里注入假的） */
  create: (url: string) => WsLike
  /** 连上后要发的握手帧（默认 hello） */
  hello: () => string
  /** 收到消息：raw 是原始字符串；reply 回发一帧（默认 ack） */
  onMessage: (raw: string, reply: (data: string) => void) => void
  /** 当前是否处于后台标签页 */
  isHidden: () => boolean
  /** 连不上/构造失败（给用户一句提示） */
  onConnectError: () => void
  maxRetries?: number
  /** 退避基数（ms）：第 n 次重连等 base×n，封顶 maxDelayMs */
  baseDelayMs?: number
  maxDelayMs?: number
  /** 连不上的诊断输出（必填：这条路径必须留下痕迹） */
  log: (msg: string) => void
}

export interface WsClient {
  connect: () => void
  /** 自愈：连接不存在就重连（前台恢复/周期兜底时调用） */
  ensure: () => void
  /** 连接健康（OPEN 或 CONNECTING） */
  healthy: () => boolean
  retries: () => number
  /** 主动断开（卸载时用） */
  stop: () => void
}

export function createWsClient(deps: WsClientDeps): WsClient {
  const maxRetries = deps.maxRetries ?? 10
  const baseDelay = deps.baseDelayMs ?? 1000
  const maxDelay = deps.maxDelayMs ?? 10000

  let ws: WsLike | null = null
  let retries = 0
  let stopped = false

  function connect(): void {
    if (stopped) return
    try {
      ws = deps.create(deps.url())
    } catch (e: any) {
      ws = null
      deps.log('[nori-pet] ws create failed: ' + String(e?.message ?? e))
    }
    if (!ws) { deps.onConnectError(); return }
    const self = ws
    self.onopen = (): void => {
      retries = 0
      self.send(deps.hello())
    }
    self.onmessage = (ev): void => {
      deps.onMessage(String(ev.data), (data) => {
        try { self.send(data) } catch { /* 连接已断：下一条消息前 ensure 会重连 */ }
      })
    }
    self.onclose = (): void => {
      if (ws === self) ws = null
      // 后台标签页不重连（省得一堆后台页反复撞宿主）；回到前台由 ensure 补
      if (deps.isHidden() || retries >= maxRetries || stopped) return
      retries += 1
      setTimeout(connect, Math.min(maxDelay, baseDelay * retries))
    }
    self.onerror = (): void => {
      try { self.close() } catch { /* 已经断了，close 抛错无意义 */ }
    }
  }

  return {
    connect,
    ensure: (): void => {
      if (ws && (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING)) return
      if (!ws) connect()
    },
    healthy: (): boolean => !!ws && (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING),
    retries: () => retries,
    stop: (): void => {
      stopped = true
      try { ws?.close() } catch { /* 关闭失败不影响停用 */ }
      ws = null
    },
  }
}
