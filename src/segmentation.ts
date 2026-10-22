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
/** 开/闭引号与括号（切点不得紧贴它们——会把引用语劈开） */
const OPEN_QUOTE = /[“‘「『（(]/
const CLOSE_QUOTE = /[”’」』）)]/
/** 这些字之前不切（助词/语气词，切在它们前面会把上一句的尾巴削掉） */
const NO_CUT_BEFORE = /[的地得着了过吗呢吧啊呀嘛]/
/** 切点落在这些字符**之后**算自然停顿，优先选它（加分，不是罚分） */
const GOOD_BREAK = /[，。、；：！？…,.;:!?]$/
/**
 * 模型偶发吐出的 HTML 片段。实测 447 段改写里有 16 处 `<br>`，夹在情绪标签之间
 * （`…对吧？<br>【think】这次…`）。气泡是 textContent 直出，不处理就会**原样显示** `<br>`，
 * 还会被算进宽度预算（4 个 ASCII ≈ 28px）。只认已知的行内/块级标签，避免误伤 `a<b` 这类正文。
 */
const HTML_TAG = /<\s*(?:br|p|div|span|b|i|em|strong|u|s)\s*\/?\s*>/gi
/**
 * 围栏代码块：**整段丢弃，不念也不进气泡**（用户需求：「代码块内容不读」）。
 * 代码逐字符念出来必然是怪音（`(`/`_`/`=>` 都会被念成词），而且听感毫无意义。
 *
 * 三分支覆盖各种残缺形态：
 *  1) 成对围栏 ```` ``` … ``` ````（也认 `~~~`）
 *  2) 行首悬空围栏 ```` ``` ```` 到文末（模型/截断常留下未闭合围栏）——宁可丢尾巴，
 *     也不要把代码当正文念出来
 *  3) 只剩围栏标记 ```` ``` ```` 本身
 */
const RE_FENCE = /```[\s\S]*?```|~~~[\s\S]*?~~~|^[ \t]*(?:```|~~~)[\s\S]*$|(?:```|~~~)/gm
/** 允许的溢出量（以"汉字宽"为单位） */
const OVERRUN = 4
/**
 * 断句判据的单位是"**长度**"，不是像素——规则由用户给定，简单到能一眼核对：
 *
 *   - 一个汉字（含全角标点）= 1
 *   - 连续英文字母/数字：**每个 0.5，整段向上取整**（3 个字母 = 1.5 → 2）
 *   - 空格 = 0.25，其它非 ASCII（希腊/西里尔/emoji）= 0.8
 *
 * **一行 17 长度**（用户实测：17 个汉字正好一行），两行 = 34。这条规则对拉丁段
 * 是向上取整的，所以只会偏保守——宁可短一点，不会超限。
 */
export const SPEAK_LINE = 17
export const SPEAK_MAX = SPEAK_LINE * 2 // = 34
/** 句读收尾的加分：4 个长度，够把切点拉到最近的自然停顿 */
const GOOD_BREAK_BONUS = 4
/** 落在词边界（ICU 分词）的加分：中文没有空格，不加这个会切出"在受|限沙箱"这种断词 */
const WORD_BREAK_BONUS = 2.5

/**
 * 词边界位置集合（ICU word 分词）。中文没有空格，`受限`/`权限` 这类词只有分词器知道，
 * 断句时优先落在词边界上，避免"在受|限沙箱"、"权|限"这种断词。分词器不可用时返回空集。
 */
function wordBoundaries(s: string): Set<number> {
  const cols = new Set<number>()
  try {
    const seg = new Intl.Segmenter('zh-CN', { granularity: 'word' })
    for (const part of seg.segment(s)) {
      if (part.index > 0) cols.add(part.index)
    }
  } catch { /* 无 ICU：不给加分，退化为纯标点/宽度启发式 */ }
  return cols
}

/** 单字符的长度（连续拉丁段的取整在 widthOf 里统一处理） */
function advanceOf(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (c === 0x20) return 0.25 // 半角空格
  if (c >= 0x2e80 && c <= 0x9fff) return 1 // CJK 汉字
  if (c >= 0xff00 && c <= 0xff60) return 1 // 全角标点
  if (c >= 0x3000 && c <= 0x303f) return 1 // 中文标点
  if (c < 0x80) return 0.5 // ASCII（单字兜底；连续段落见 widthOf）
  return 0.8 // 其它（希腊/西里尔/emoji 等，粗估）
}

const isLatinish = (ch: string): boolean => /[A-Za-z0-9]/.test(ch)

/**
 * 文本的"长度"：汉字按 1 计，**连续的字母/数字整段 0.5×个数向上取整**，
 * 其余逐字累加（空格 0.25）。与一行 17 长度的实测值同口径。
 */
export function widthOf(s: string): number {
  let w = 0
  let run = 0
  const flush = (): void => {
    if (run > 0) { w += Math.ceil(run * 0.5); run = 0 }
  }
  for (const ch of s) {
    if (isLatinish(ch)) { run += 1; continue }
    flush()
    w += advanceOf(ch)
  }
  flush()
  return Math.round(w * 100) / 100 // 去掉 0.25 累加的浮点噪声（50.69999999 → 50.7）
}
/** 前缀长度累加表：cum[i] = 前 i 个字符的长度（切点判定用，避免每次 O(n) 重算） */
function cumWidth(s: string): number[] {
  const a = new Array<number>(s.length + 1)
  a[0] = 0
  let run = 0
  let base = 0 // 当前拉丁段开始前的长度
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (isLatinish(ch)) {
      if (run === 0) base = a[i]!
      run += 1
      a[i + 1] = base + Math.ceil(run * 0.5) // 段内按 0.5 递增、段末不足 1 补成 1
    } else {
      run = 0
      a[i + 1] = a[i]! + advanceOf(ch)
    }
  }
  return a
}

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
    .replace(HTML_TAG, '') // 0) 模型偶发吐出的 HTML 片段（`<br>` 实测 447 段里 16 次）
    .replace(RE_FENCE, ' ') // 0b) 围栏代码块整段丢弃（见 RE_FENCE）
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
  // 0b) 引号/括号紧邻处不可切：实测出现过 `…刚好切在“` | `278px 除以”和…` 这种
  //     切开引用語的刀口（取证环里抓到的真实案例如上）。开引号后面、闭引号前面都别切。
  if (OPEN_QUOTE.test(prev) || CLOSE_QUOTE.test(next)) return false
  // 0c) 助词/语气词前不可切：`…就是 widget 断句切` | `的，只有…` 这种断法很别扭
  if (NO_CUT_BEFORE.test(next)) return false
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

/** 从候选里挑"最贴近 preferred、且在 [min, max] 内"的切点（**按字符位置**，供批次上限用） */
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

/**
 * 同上，但**按估算宽度**挑切点（px）。朗读单元用它——气泡是按宽度换行的，
 * 按字数挑会让混排句子只填半行。
 *
 * 两句读之上再加"自然停顿优先"：切点在句读之后加 `GOOD_BREAK_BONUS`。
 * 这是**加分**而不是罚分——`…就是 widget 断句切的，只有一条完整…` 这种句子，
 * 句读在预算外一点点，纯按"离 0.9×预算最近"会切在"断句切 | 的"中间；
 * 加分后最多可以多走 4 个汉字宽，去贴那个逗号。
 */
function pickCutLen(s: string, cum: number[], preferred: number, minLen: number, maxLen: number): number {
  let best = 0
  let bestScore = -Infinity
  const words = wordBoundaries(s)
  for (const p of cutPoints(s)) {
    const w = cum[p]!
    if (w > maxLen) break
    if (w < minLen) continue
    let bonus = GOOD_BREAK.test(s.slice(0, p).trimEnd()) ? GOOD_BREAK_BONUS : 0
    if (words.has(p)) bonus += WORD_BREAK_BONUS // 词边界优先，避免断词
    const score = -Math.abs(preferred - w) + bonus
    if (score > bestScore) { best = p; bestScore = score }
  }
  return best
}

/** 把一个句子切成"两行以内"的若干单元（`max`/`min` 单位 = 长度，一行 17） */
function splitSentence(sent: string, max: number, min: number): string[] {
  const out: string[] = []
  const maxLen = max
  const minLen = min
  const overrunLen = OVERRUN
  let start = 0
  while (start < sent.length) {
    const rest = sent.slice(start)
    if (widthOf(rest) <= maxLen) { const t = trimAscii(rest); if (t) out.push(t); break }
    const cum = cumWidth(rest)
    const total = cum[cum.length - 1]!
    // 目标：贴着 0.9×上限；但短句（总长不到两倍上限）改成对半分，避免"27 + 14"这种尾巴。
    const preferred = Math.min(maxLen * 0.9, Math.max(minLen, total / 2))
    // 尾巴不能太短：`…修复` | `与 v0.2.9 tag。` 这种收尾会单独占一个气泡，看着像断掉的碎片。
    // 所以切点上限顺带压到"剩余 ≥ 上限的 4 成"，两段宽度尽量均衡。
    const tailMin = Math.max(minLen, maxLen * 0.4)
    const upper = Math.min(maxLen, Math.max(minLen, total - tailMin))
    let cut = pickCutLen(rest, cum, Math.min(preferred, upper), minLen, upper)
    if (cut <= 0) cut = pickCutLen(rest, cum, preferred, minLen, maxLen)
    if (cut <= 0) cut = pickCutLen(rest, cum, maxLen, minLen, maxLen + overrunLen) // 放宽上限
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
 * 把文本切成"可朗读单元"：每个单元是一句自然的话，**估算宽度**尽量落在 `[min, max]`
 * 个汉字宽之间（`max` 默认 = SPEAK_MAX = 两行）。
 *
 * ⚠ `max`/`min` 的单位是"汉字宽"（1 = 13px），不是字符数：混排句子（英文/数字/路径）
 * 单字更窄，所以**字符数会超过 max**，但渲染宽度仍在一行/两行预算内。这是刻意的——
 * 按字符数切会让含英文的句子只填半行（实测填充率 0.51）。
 */
export function spokenUnits(text: string, max = SPEAK_MAX, min = 12): string[] {
  // HTML 片段（`<br>` 实测会出现在情绪标签之间）与**围栏代码块**在**入口**就剥掉：
  // 否则它们会进气泡文本、被算进长度预算，还会被朗读出来（用户需求：代码块内容不读）。
  // 放在这里而不是只放 cleanSpeech，是因为气泡显示走的是本函数。
  const raw = String(text).replace(HTML_TAG, '').replace(RE_FENCE, ' ').replace(/\r/g, '').trim()
  if (!raw) return []
  const units: string[] = []
  const maxLen = max
  const minLen = min
  for (const sent of sentences(raw)) {
    if (widthOf(sent) <= maxLen) { const t = trimAscii(sent); if (t) units.push(t); continue }
    for (const u of splitSentence(sent, max, min)) units.push(u)
  }
  // 收尾 1：悬空句读（"有权限申请："）**向后合并**，而不是把标点推给下一句。
  //   旧做法是 `units[k+1] = 标点 + units[k+1]`，结果下一句以"："开头（气泡里像断掉的句子，
  //   用户实测反馈"切得挺不自然"）。能并进上限就并成一句；并不进去就把句读留在句末——
  //   句子末尾带个冒号，比下一句突然以冒号起头自然得多。
  for (let k = 0; k + 1 < units.length; k++) {
    const u = units[k]!
    if (!/[：:，,、；;]$/.test(u)) continue
    const merged = u + units[k + 1]!
    if (widthOf(merged) <= maxLen + OVERRUN) { units[k] = merged; units.splice(k + 1, 1); k -= 1 }
  }
  // 收尾 1a：任何单元都不许以句读开头（兜住其它路径造出的前置标点）→ 挪回上一句句末
  for (let k = 1; k < units.length; k++) {
    const m = units[k]!.match(/^[：:，,、；;]+/)
    if (!m) continue
    units[k - 1] = units[k - 1]! + m[0]
    const rest = units[k]!.slice(m[0].length).trimStart()
    if (rest) units[k] = rest
    else { units.splice(k, 1); k -= 1 }
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
    if (widthOf(u) >= minLen) { out.push(u); continue }
    const next = units[k + 1]
    if (next !== undefined && widthOf(u + next) <= maxLen) { units[k + 1] = u + next; continue }
    const prev = out[out.length - 1]
    if (prev !== undefined && widthOf(prev + u) <= maxLen) { out[out.length - 1] = prev + u; continue }
    if (prev !== undefined && widthOf(prev) >= minLen * 2) {
      const merged = prev + u
      const cum = cumWidth(merged)
      const total = cum[cum.length - 1]!
      let cut = -1
      for (const p of cutPoints(merged)) {
        if (cum[p]! <= maxLen && cum[p]! >= Math.max(minLen, total - maxLen)) { cut = p; break }
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
