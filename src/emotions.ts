/**
 * 情绪词表：**唯一真相**。
 *
 * 三处曾各写一份：宿主侧清洗（segmentation 的 EMO_WORDS）、浏览器端校验（widget 的
 * VALID_EMO_TAGS）、以及 widget 里手写的 `Emotion` 联合类型。加一个情绪要改三处，
 * 漏一处就是"宿主认、前端不认"或反之（表现为标签被当正文念出来，或表情永远不触发）。
 *
 * 本模块不 import 任何东西 —— widget 单独打包（tsdown）时可以直接内联，不会把宿主代码拖进浏览器。
 */

/** 情绪标签词表（新增情绪：这里加一词 + widget 的 EMOTION_TABLE 加一条表现） */
export const EMOTIONS = [
  'default', 'happy', 'excited', 'angry', 'refuse', 'sad', 'doubt',
  'troubled', 'shy', 'surprised', 'dizzy', 'serious', 'speechless', 'think',
] as const

export type Emotion = (typeof EMOTIONS)[number]

/** 校验用集合（宿主清洗标记、前端校验广播来的标签） */
export const VALID_EMO_TAGS: ReadonlySet<string> = new Set<string>(EMOTIONS)
