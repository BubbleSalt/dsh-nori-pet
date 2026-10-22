/**
 * cordis 事件订阅：把 dsh 的 agent 流与会话事件接到播报管线。
 *
 * 只做"接线"——订阅参数、回放水位、延迟订阅与销毁清理；播报决策在 pipeline.ts。
 * 两个容易踩的点留在这里，别挪走：
 *
 *  1) `agent/assistant-stream` 是 **scope-filtered** 事件（`this: Scoped<Agent>`）。插件在外层
 *     作用域注册，必须显式传 `{ global: true }` 才能收到任何 agent 的帧；漏掉时监听器
 *     永不触发且不报错（旧版因此整条流式播报静默，是"长内容一口气读完"的根因之一）。
 *  2) 回放过滤只能靠 seq 水位：启动时记下各会话当前 seq，之后只处理 seq >= 水位的实时事件。
 *     用"启动后 N 秒内不播报"这类时间窗会把实时事件一起丢掉。
 */
import type { HostStats } from './pipeline.js'

export interface EventsDeps {
  onAgentFrame: (payload: any) => void
  onSessionEvent: (session: any, event: any) => void
  stats: HostStats
  /** 延迟订阅时长（等宿主把历史会话回放完） */
  delayMs?: number
}

export function installEvents(ctx: any, deps: EventsDeps): void {
  const { onAgentFrame, onSessionEvent, stats } = deps
  const delayMs = deps.delayMs ?? 1500

  ctx.on('agent/assistant-stream', (payload: any) => onAgentFrame(payload), { global: true })

  // 会话水位：启动时记录各会话当前 seq，之后仅处理 seq >= 水位的实时事件（精确跳过历史回放）
  const watermark = new Map<string, number>()
  // 会话水位：启动时记录各会话当前 seq，之后仅处理 seq >= 水位的实时事件（精确跳过历史回放）
  try {
    const sessionSvc: any = (ctx as any).sessions
    if (sessionSvc && typeof sessionSvc.list === 'function') {
      for (const s of sessionSvc.list()) {
        if (s && typeof s.id === 'string' && typeof s.seq === 'number') watermark.set(s.id, s.seq)
      }
    }
  } catch { /* ignore */ }

  const delayedSub = setTimeout(() => {
    ctx.on('session/event', (session: any, event: any) => {
      stats.events += 1
      const sid: string = session?.id ?? '?'
      const evSeq = typeof event?.seq === 'number' ? event.seq : -1
      if (evSeq >= 0) {
        const w = watermark.get(sid)
        if (w !== undefined && evSeq < w) return
        watermark.set(sid, evSeq + 1) // 推进水位（新会话首个事件即实时）
      }
      onSessionEvent(session, event)
    })
  }, delayMs)
  // 延迟订阅的清理：宿主销毁时清掉定时器
  ctx.effect(() => () => { try { clearTimeout(delayedSub) } catch { /* ignore */ } }, 'nori-pet-delayed-sub')
}
