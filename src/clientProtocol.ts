/**
 * 客户端协议解析：把宿主推来的原始帧解成一个判别联合（discriminated union）。
 *
 * 从 src/client/widget.ts 的 handleWsMessage 里搬出。搬的理由不是"太长"，是**字段校验
 * 决定了行为**，而这些行为出过一次事故：
 *  - `turn` 有两种形态：改写路径给数字 `12`，概括路径给字符串 `12-sum`。这里只做原样透传，
 *    归一化交给 turns.ts 的 planAssistantRoute —— 早先 widget 里直接 `typeof turn === 'number'`
 *    判断，概括那批拿到 null，于是被当成"新 turn"打断了自己，正在读的句子被腰斩；
 *  - `emote` 的情绪名可能来自 URL query，必须按 EMOTION_TABLE 白名单校验，否则会拿脏字符串
 *    去调 Live2D 表情；
 *  - 空文本 / 非字符串字段一律当无效帧，不能进入朗读链路（否则会合成一段空音频）。
 *
 * 纯函数、零 DOM，可以在 node 里直接断言协议契约。
 */
import { EMOTION_TABLE } from './emotionDriver.js'
import type { Emotion } from './emotions.js'

export type ClientEvent =
  | { kind: 'approval'; text: string }
  | { kind: 'assistant'; text: string; turn: number | string | null }
  | { kind: 'user' }
  | { kind: 'tool' }
  | { kind: 'turn-end' }
  | { kind: 'emote'; emotion: Emotion | null; text: string | null }
  | { kind: 'unknown'; type: string; text: string | null }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 解析一帧；无法解析（非法 JSON / 非对象）返回 null */
export function parseClientEvent(raw: string): ClientEvent | null {
  let msg: unknown
  try { msg = JSON.parse(raw) } catch { return null } // 非法 JSON：不是协议帧，直接丢（上层本来也不该收到）
  if (!isObj(msg)) return null
  const type = typeof msg.type === 'string' ? msg.type : ''
  const text = typeof msg.text === 'string' && msg.text ? msg.text : null

  switch (type) {
    case 'approval':
      // 权限提醒必须带正文才有意义
      return text ? { kind: 'approval', text } : { kind: 'unknown', type, text: null }
    case 'assistant': {
      if (!text) return { kind: 'unknown', type, text: null }
      const turn = typeof msg.turn === 'number' || typeof msg.turn === 'string' ? msg.turn : null
      return { kind: 'assistant', text, turn }
    }
    case 'user': return { kind: 'user' }
    case 'tool': return { kind: 'tool' }
    case 'turn-end': return { kind: 'turn-end' }
    case 'emote': {
      const e = typeof msg.e === 'string' ? msg.e : ''
      const emotion = e && e in EMOTION_TABLE ? e as Emotion : null
      return { kind: 'emote', emotion, text }
    }
    default:
      return { kind: 'unknown', type, text }
  }
}
