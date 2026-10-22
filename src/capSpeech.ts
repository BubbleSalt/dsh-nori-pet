/**
 * 播报跑飞兜底（不是"格式上限"）：只在输出明显失控时才截断，正常超一点不动。
 *
 * 历史：这里原本是硬上限（4 句 / 150 字），超一个字就截。真机事故（turn=15）：概括 196 字
 * 被截成 99 字，最后两句【think】【doubt】整行消失 —— 气泡不显示也不朗读。
 * 而且"概括略超 140 字"本身**没有危害**：多说两句只是多读几秒，删掉结论才是真损失。
 * 所以这里改成**兜底**语义：目标是 3 句/140 字（写在 persona/summary.txt 里让模型自己压），
 * 只有超过 RUNAWAY_* 这种量级才动手，且动手时保住开头和结尾、只丢中间。
 */

/** 兜底阈值：正常概括（≤200 字）永远碰不到 */
export const RUNAWAY_MAX_SENTENCES = 6
export const RUNAWAY_MAX_CHARS = 400

export interface CapResult {
  text: string
  /** 被丢掉的句数（0 表示没裁） */
  dropped: number
  /** 原句数 */
  total: number
}

/** 只按句末标点切：概括输出很短，且情绪标签【emo】自带全角括号不会被切断，无需 ICU 分词 */
function unitsOf(text: string): string[] {
  return String(text).split(/(?<=[。！？!?…；;\n])/).map((s) => s.trim()).filter((s) => s.length > 0)
}

export function capSpeechInfo(text: string, maxSentences: number, maxChars: number): CapResult {
  const src = String(text)
  const units = unitsOf(src)
  if (units.length === 0) return { text: '', dropped: 0, total: 0 }
  const totalLen = units.reduce((n, u) => n + u.length, 0)
  if (units.length <= maxSentences && totalLen <= maxChars) return { text: src.trim(), dropped: 0, total: units.length }

  const head = units[0]
  const picked: string[] = [head]
  let len = head.length
  const tail: string[] = []
  for (let i = units.length - 1; i >= 1; i--) {
    if (picked.length + tail.length >= maxSentences) break
    const u = units[i]
    if (len + u.length > maxChars) break
    tail.unshift(u)
    len += u.length
  }
  const kept = [...picked, ...tail]
  return { text: kept.join(''), dropped: units.length - kept.length, total: units.length }
}

export function capSpeech(text: string, maxSentences: number, maxChars: number): string {
  return capSpeechInfo(text, maxSentences, maxChars).text
}
