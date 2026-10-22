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


/**
 * 关键词 → 情绪（顺序即优先级：先命中先取）。
 *
 * 纯规则、零 LLM 成本：广播文本没有显式【标签】时的兜底表情。放在这里是为了能在 node 里
 * 直接单测（原来埋在 widget.ts 里，只能靠肉眼看桌宠表情验证）。
 */
export const EMOTION_KEYWORDS: Array<[Emotion, RegExp]> = [
  ['excited', /哇|天哪|居然|太棒|好耶|惊喜|没想到|万岁|好厉害|真厉害|吓一跳/],
  ['happy', /开心|高兴|太好了|真好|嘿嘿|哈哈|嘻嘻|喜欢|爱了|棒|好呀|好哇|真不错|有趣|摸摸头|舒服/],
  ['sad', /难过|伤心|遗憾|可惜|哭了|想哭|好痛|失落|寂寞|舍不得/],
  ['angry', /生气|可恶|气死|气人|讨厌|过分|岂有此理|不干了|不行了/],
  ['refuse', /拒绝|我不要|才不要|不要不要|别别别|不愿意|免了|算了|不去|不行不行|NoNo|说no/],
  ['surprised', /竟然|居然|吃惊|惊讶|吓到|突然/],
  ['troubled', /麻烦|难办|纠结|怎么办|头疼|犯难|为难|不知所措/],
  ['doubt', /奇怪|怎么回|为什么|真的吗|是这样吗|疑问|嗯？|？|想不通/],
  ['dizzy', /晕|眼花|天旋地转|昏/],
  ['serious', /认真|严肃|重要|必须|一定|警告|注意|记住/],
  ['speechless', /无语|说不出话|沉默|无言以对/],
  ['shy', /害羞|不好意思|谢谢|麻烦你了|脸红/],
]

export function classifyEmotion(text: string): Emotion {
  for (const [e, re] of EMOTION_KEYWORDS) if (re.test(text)) return e
  return 'default'
}
