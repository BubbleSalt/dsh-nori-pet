/**
 * 共享文本模式：CJK 字符类 + 代码围栏正则。
 *
 * 为什么要收成一处（审阅时的账）：
 *  - CJK 范围被抄了 4 份（segmentation / speakText 两处行内 / speakText 的路径正则里还嵌了一份），
 *    扩区、补兼容区时改漏一处就是"判定 A 认、判定 B 不认"的诡异不一致；
 *  - 代码围栏被写了 3 份（speakable 的"是否整段就是代码"、segmentation 的清洗、speakText 的朗读清理），
 *    三份的 `~~~`/未闭合围栏处理各不相同，实际效果取决于哪一层先跑。
 *
 * 这里只放**模式**，不放行为：三个调用点的语义差异（要不要连未闭合围栏一起丢）由各自的
 * 函数名表达，避免为了"合一"把它们揉成一个谁也说不清的巨正则。
 */

/** CJK 表意文字：扩展 A + 基本区 + 兼容区（不含全角标点，标点另有 BOUNDARY/全角集合） */
export const CJK_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff'

/** 单个 CJK 字符（无 g，可安全 .test()） */
export const CJK = new RegExp(`[${CJK_CLASS}]`)
/** CJK 或 ASCII 字母数字（判断"这段还有真内容"用） */
export const CJK_ALNUM = new RegExp(`[${CJK_CLASS}A-Za-z0-9]`)

const FENCE = '```'
const TILDE = '~~~'
/** 成对围栏的内部源串（不含标志位） */
const PAIRED = `${FENCE}[\\s\\S]*?${FENCE}|${TILDE}[\\s\\S]*?${TILDE}`

/**
 * 成对围栏（``` 或 ~~~）。
 * 每次调用返回**新实例**：带 `g` 的正则挂在模块级会被 lastIndex 状态串味（.test 不重置）。
 */
export const codeFence = (): RegExp => new RegExp(PAIRED, 'g')

/**
 * 成对围栏 + 行首悬空围栏到文末 + 只剩围栏标记本身。
 * 用于"朗读前清洗"：宁可把未闭合围栏之后的尾巴整段丢掉，也不要把代码当正文念出来。
 */
export const codeFenceAny = (): RegExp =>
  new RegExp(`${PAIRED}|^[ \\t]*(?:${FENCE}|${TILDE})[\\s\\S]*$|(?:${FENCE}|${TILDE})`, 'gm')

/** 行首悬空围栏（未闭合）：用于判定"整段内容其实就是一段掉进正文的代码" */
export const codeFenceOpen = (): RegExp => new RegExp(`^${FENCE}[\\s\\S]*$`, 'm')
