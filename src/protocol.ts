/**
 * 宿主 ↔ widget 共用的协议常量（**唯一真相**）。
 *
 * 为什么需要这个文件：`PREFIX` 曾同时硬编码在 index.ts、client/widget.ts、scripts/smoke-test.mjs、
 * package.json 的 name、cordis.patch.yml 的 entry id —— 改包名要动五处，漏一处就是"面板连不上宿主"。
 * 宿主在 hello 帧里已经下发了 prefix，widget 却没用；这里统一到一处，widget 侧以 hello 为准。
 *
 * 消息类型字符串同样收口在这里：宿主 18 处、widget 9 处手写字符串时，改名只能靠全局替换
 * 猜（`turn-end` 与 `turnEnd` 这种拼写差异不会被类型系统拦住）。
 */

/** 本插件的路由前缀（= package.json name） */
export const PREFIX = '/@bubblesalt/dsh-nori-pet'

/** 宿主 → widget 的消息类型 */
export const OUT = {
  /** 逐句朗读文本（可带【情绪】标签） */
  assistant: 'assistant',
  /** 权限申请提醒（原文播报，优先级最高） */
  approval: 'approval',
  /** 用户发言（widget 用来切"思考"表情） */
  user: 'user',
  /** 工具调用完成（思考态） */
  tool: 'tool',
  /** 一轮结束（widget 据此回收思考态、启动入睡计时） */
  turnEnd: 'turn-end',
  /** 手动触发情绪（/api/emote 调试用） */
  emote: 'emote',
  /** 连接建立（携带 prefix / tts / model / version） */
  hello: 'hello',
} as const

/** widget → 宿主的消息类型 */
export const IN = {
  /** 绑定会话（'' = 不过滤，收全部） */
  hello: 'hello',
  /** 收到消息的确认（宿主持久化前只有计数用途） */
  ack: 'ack',
} as const

export type OutType = (typeof OUT)[keyof typeof OUT]
export type InType = (typeof IN)[keyof typeof IN]
