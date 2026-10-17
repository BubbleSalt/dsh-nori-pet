/**
 * 断句 / 切分：宿主与 widget 共用的唯一实现。
 *
 * 策略（不自己发明断句规则）：
 *  1) **句级边界来自 ICU**（`Intl.Segmenter`，Node 与浏览器内置、零依赖）：`。！？` 等句末标点
 *     在 UAX #29 规则里天然成界，`sh.exe` 这类缩写也不会被误断。
 *  2) **句内切点 = "安全边界"**：空白、全角标点、或 CJK 与拉丁的交界处。拉丁复合词/路径
 *     （`danger-full-access`、`C:/a/b/c`、`sh.exe`、`Win32`）**内部一律不可切**——宁可整段超长。
 *     这一条同时覆盖了 `danger|full|access` 被 ICU 拆成词段后误切 `danger-full-`+`access` 的坑。
 *  3) **长度只是偏好**：在 [min, max+OVERRUN] 内取**最贴近 `max`**（次级：贴近理想值）的安全边界；
 *     只有"整段没有任何安全边界"（超长原子串 / 纯中文无标点）才允许硬切，硬切也绝不切开拉丁词。
 *  4) 收尾把 `min` 以下的碎片并入相邻单元（并入会超上限时只把左邻"剪到上限"）。
 *
 * 行为由 scripts/test-segmentation.mjs 锁定（含 "access 被切成 acces+s" 等真实踩坑用例）。
 */

/** CJK 表意文字（含扩展区） */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const isCjk = (ch: string): boolean => CJK.test(ch)
/** 全角标点：本身即句读边界 */
const FULLWIDTH = /[，。！？；：、（）【】《》“”‘’…—～]/
/** 仅由标点/空白构成（不承载语音）→ 并入相邻单元 */
const PUNCT_ONLY = /^[\s。！？!?…；;，,、：:.\-—~～"'“”‘’()（）\[\]【】]+$/
/**
 * 情绪标签括号：`【` 之前与 `】` 之后都不允许切。
 * 这样标签整体吸附到后文——既不切在 `【…】` 内部（会留下 `【` 残骸），也不会悬在句末
 * （朗读前按"行首标签"剥离，悬在句末时前缀对不上，会被当正文念出来）。
 */
const TAG_BRACKET = /[【】]/
/** 允许的溢出字数 */
const OVERRUN = 4

const trimAscii = (s: string): string =>
  s.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '')

/** 句级切分（ICU）；不可用时返回原文本。
 *  后处理：句界紧跟情绪标签时把标签并入上一句——`…啦！【think】接下来…` 若在 `！` 处断开，
 *  标签会悬在句末。（残留标签由 cleanSpeech 兜底清除，这里只避免制造悬空标签。） */
function sentences(text: string): string[] {
  try {
    const seg = new Intl.Segmenter('zh-CN', { granularity: 'sentence' })
    const raw = [...seg.segment(text)].map((s) => s.segment).filter((s) => s.trim().length > 0)
    if (!raw.length) return [text]
    const out: string[] = []
    for (const s of raw) {
      const m = s.match(/^(\s*【[^】]{0,12}】)/)
      if (m && out.length) {
        out[out.length - 1] += m[1]!
        const rest = s.slice(m[1]!.length)
        if (rest.trim().length > 0) out.push(rest)
      } else out.push(s)
    }
    return out
  } catch { return [text] }
}

/**
 * 朗读前清理：剥掉情绪标签及其**被切断的残骸**。
 *
 * 为什么必须在朗读文本层兜底：`Intl.Segmenter` 的 sentence 粒度**会切在标签内部**——
 * 实测 `…这样最稳。【serious】拉起前…` 被 ICU 从 `【` 与 `serious` 之间断开，于是产生
 * `…【` 与 `serious】拉起…` 两个单元，朗读时 `【` 被当标点、`serious】` 被当正文**念出来**。
 * 任何"只保护切点"的做法都管不到 ICU 的句级边界，所以统一在这里清干净。
 *
 * 清理顺序（后者兜前者，容忍任意切断方式）：
 *  1) 完整标签 `【emo】`；
 *  2) 带括号的残骸：`【`+词、词+`】`（`serious】`）、只剩括号；
 *  3) 归一化：把"标签词"从词首剔除——ICU 可能正好切在 `】` 后，留下一段中文开头的裸标签词，
 *     此时已无从判断它是标签而非正文，只能按词表剔除（词表在 chat 场景里不会出现在正文开头）。
 */
const EMO_WORDS = new Set(['default', 'happy', 'excited', 'angry', 'refuse', 'sad', 'doubt', 'troubled', 'shy', 'surprised', 'dizzy', 'serious', 'speechless', 'think'])
export function cleanSpeech(text: string): string {
  let t = String(text)
    .replace(/【[^】]{0,12}】/g, '') // 1) 完整标签
    .replace(/【[A-Za-z]{0,12}/g, '') // 2a) 【+词
    .replace(/[A-Za-z]{0,12}】/g, '') // 2b) 词+】 / 裸括号
    .replace(/[【】]/g, '') // 2c) 括号残骸
  // 3) 裸标签词（只在词首剔除，避免误伤正文中的普通英文）
  const seg = t.match(/^[A-Za-z]{3,12}/)
  if (seg && EMO_WORDS.has(seg[0].toLowerCase())) t = t.slice(seg[0].length)
  return t.replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * 该位置能否作为切点：空白 / 全角标点 / CJK 与拉丁交界处可以，
 * 拉丁复合词（`danger-full-access`、`C:/a/b`、`sh.exe`、`Win32`）内部不可以。
 */
function isSafeCut(s: string, i: number): boolean {
  if (i <= 0 || i >= s.length) return true
  // 0) 情绪标签括号两侧不可切：标签整体吸附后文（详见 TAG_BRACKET 注释）
  if (TAG_BRACKET.test(s[i - 1]!) || TAG_BRACKET.test(s[i]!)) return false
  const prev = s[i - 1]!
  const next = s[i]!
  // 1) 空白归后一段：切点在空白**之后**（这样 trim 不会吞掉空格、中文也不会与后句粘连）
  if (/\s/.test(prev)) return true
  // 2) 全角标点之后：中文句读天然成界（后面不接空白时）
  if (FULLWIDTH.test(prev) && !/\s/.test(next)) return true
  // 3) 中文与拉丁交界：仅当后一个字符是拉丁词首且其后不是空白时（否则会把"沙箱 里"的
  //    空格吞掉；"(C:/a/b) 里放配置" 这类必须切成"路径"+"(空格)里放配置"）
  if (isCjk(prev) && !isCjk(next) && !/\s/.test(next) && /[A-Za-z0-9_]/.test(next)) return true
  // 4) 中文逐字可断（无"词"的断字风险），但不可切在空白之后的位置之外
  if (isCjk(prev) && isCjk(next) && !/\s/.test(next)) return true
  return false
}

/** 所有可选切点（升序，含末尾） */
function cutPoints(s: string): number[] {
  const pts: number[] = []
  for (let i = 1; i <= s.length; i++) if (isSafeCut(s, i)) pts.push(i)
  return pts
}

/** 从候选里挑"最贴近 preferred、且在 [min, max] 内"的切点 */
function pickCut(s: string, preferred: number, min: number, max: number): number {
  let best = 0
  let bestScore = -Infinity
  for (const p of cutPoints(s)) {
    if (p > max) break
    if (p < min) continue
    const score = -Math.abs(preferred - p)
    if (score > bestScore) { best = p; bestScore = score }
  }
  return best
}

/** 把一个句子切成不超过 max 的若干单元 */
function splitSentence(sent: string, max: number, min: number): string[] {
  const out: string[] = []
  let start = 0
  while (start < sent.length) {
    const rest = sent.slice(start)
    if (rest.length <= max) { const t = trimAscii(rest); if (t) out.push(t); break }
    const preferred = Math.floor(max * 0.9)
    let cut = pickCut(rest, preferred, min, max)
    if (cut <= 0) cut = pickCut(rest, max, min, max + OVERRUN) // 放宽上限
    if (cut <= 0) {
      // 没有任何安全切点：超长原子串（整体保留，宁可超长）或纯中文长串（逐字硬切）
      const asciiOnly = /^[\x20-\x7e]+$/.test(rest.slice(0, Math.floor(max * 1.6)))
      if (!asciiOnly) {
        for (let i = Math.min(max, rest.length); i > 0; i--) {
          if (isSafeCut(rest, i)) { cut = i; break }
        }
        if (cut <= 0) {
          for (let i = Math.min(max, rest.length - 1); i > 0; i--) {
            if (!/[A-Za-z0-9_]/.test(rest[i - 1]!) || !/[A-Za-z0-9_]/.test(rest[i]!)) { cut = i; break }
          }
        }
      }
      if (cut <= 0) { const whole = trimAscii(rest); if (whole) out.push(whole); break }
    }
    const head = trimAscii(rest.slice(0, cut).replace(/ $/, ''))
    if (head && !PUNCT_ONLY.test(head)) out.push(head)
    else if (head && out.length) out[out.length - 1] += head
    start += cut
  }
  return out
}

/**
 * 把文本切成"可朗读单元"：每个单元是一句自然的话，长度尽量落在 `[min, max+OVERRUN]`。
 */
export function spokenUnits(text: string, max = 34, min = 10): string[] {
  const raw = String(text).replace(/\r/g, '').trim()
  if (!raw) return []
  const units: string[] = []
  for (const sent of sentences(raw)) {
    if (sent.length <= max) { const t = trimAscii(sent); if (t) units.push(t); continue }
    for (const u of splitSentence(sent, max, min)) units.push(u)
  }
  // 收尾 1：悬空标点（"有权限申请："）并入下一句作前缀
  for (let k = 0; k + 1 < units.length; k++) {
    const u = units[k]!
    if (!/[：:，,、]$/.test(u)) continue
    units[k] = u.slice(0, -1)
    units[k + 1] = u.slice(-1) + units[k + 1]!
  }
  // 收尾 1b：标签被留在上一句末尾（如"…啦！【think】"）→ 后移作下一句前缀。
  //   句级已经按 `sentences()` 合并处理，这里兜住句内切分可能造出的残留。
  for (let k = 0; k + 1 < units.length; k++) {
    const u = units[k]!
    const m = u.match(/【[^】]{0,12}】\s*$/)
    if (!m || u.length <= m[0].length) continue // 整单元就是标签时保留原样（下一个收尾会合并）
    units[k] = u.slice(0, u.length - m[0].length).trimEnd()
    units[k + 1] = m[0].trim() + units[k + 1]!
  }
  // 收尾 2：碎片合并（先向右、再向左）；并入会超上限时只把左邻"剪到上限"
  const out: string[] = []
  for (let k = 0; k < units.length; k++) {
    const u = units[k]!
    if (!u) continue
    if (u.length >= min) { out.push(u); continue }
    const next = units[k + 1]
    if (next !== undefined && u.length + next.length <= max) { units[k + 1] = u + next; continue }
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.length + u.length <= max) { out[out.length - 1] = prev + u; continue }
    if (prev !== undefined && prev.length >= min * 2) {
      const merged = prev + u
      let cut = -1
      for (const p of cutPoints(merged)) {
        if (p <= max && p >= Math.max(min, merged.length - max)) { cut = p; break }
      }
      if (cut > 0) { out[out.length - 1] = trimAscii(merged.slice(0, cut)); units[k] = trimAscii(merged.slice(cut)) }
    }
    out.push(units[k]!)
  }
  return out.filter((s) => s.length > 0)
}

/**
 * 找一个"贴近 target、允许 ≤OVERRUN 溢出"的安全切点（供批次上限使用）。
 * @returns 切点位置；0 表示窗口内没有安全切点
 */
export function findCut(s: string, target: number, min = 0): number {
  if (target >= s.length) return s.length
  return pickCut(s, target, min, target + OVERRUN)
}

/**
 * "必须切到 `target` 以内"的场合取切点（流式批次上限）：优先安全切点，退而求其次取
 * "非词内部"位置，最后才用 target。与 `findCut` 的区别是把 target 当**上限**。
 */
export function softCut(rest: string, target: number): number {
  if (target >= rest.length) return rest.length
  const cut = pickCut(rest, target, Math.floor(target * 0.6), target)
  if (cut > 0) return cut
  for (let i = target; i > 0; i--) {
    if (!/[A-Za-z0-9_]/.test(rest[i - 1]!) || !/[A-Za-z0-9_]/.test(rest[i] ?? '')) return i
  }
  return target
}
