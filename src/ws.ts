/**
 * 迷你 WebSocket 帧编解码（纯函数）。
 *
 * 只服务本插件的用途：客户端过来的都是小 JSON 帧（hello / ack），服务端只推送。
 * 不用 `ws` 包是有意的——省一个运行时依赖，而握手 + 帧解析的总量不到 60 行。
 *
 * 从 index.ts 搬出：这里曾是全仓唯一"纯逻辑但无法单测"的代码（活在宿主闭包里）。
 * 行为由 scripts/test-wav-ws.mjs 锁定（含 125/126/127 三种长度形态与 masking）。
 */
import { createHash } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** `Sec-WebSocket-Accept` = base64(sha1(key + GUID))（RFC 6455 §4.2.2） */
export const acceptKey = (key: string): string => createHash('sha1').update(key + WS_GUID).digest('base64')

/** 编码一个服务端帧（FIN=1，无 masking） */
export function encodeFrame(payload: Buffer | string, opcode = 1): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  let head: Buffer
  if (data.length < 126) {
    head = Buffer.from([0x80 | opcode, data.length])
  } else if (data.length < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(data.length, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeUInt32BE(Math.floor(data.length / 0x100000000), 2)
    head.writeUInt32BE(data.length & 0xffffffff, 6)
  }
  return Buffer.concat([head, data])
}

export interface ParsedFrame {
  opcode: number
  payload: Buffer
  /** 本帧占用的字节数（调用方据此从缓冲区切除） */
  consumed: number
}

/** 解析缓冲区头部的一个帧；数据不完整返回 null（等更多字节） */
export function parseFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < 2) return null
  const b0 = buf[0]!
  const b1 = buf[1]!
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f
  let off = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    off = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    const hi = buf.readUInt32BE(2)
    const lo = buf.readUInt32BE(6)
    len = hi * 0x100000000 + lo
    off = 10
  }
  let maskKey: Buffer | null = null
  if (masked) {
    if (buf.length < off + 4) return null
    maskKey = buf.subarray(off, off + 4)
    off += 4
  }
  if (buf.length < off + len) return null
  let payload = buf.subarray(off, off + len)
  if (masked && maskKey) {
    payload = Buffer.from(payload)
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!
  }
  return { opcode, payload, consumed: off + len }
}
