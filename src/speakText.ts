/**
 * 朗读文本清理：把"不该念/念不出来"的内容换成**可朗读形态**。
 *
 * 为什么必须做在插件侧（不是让 GPT-SoVITS 自己处理）——实测证据（2026-10-18）：
 * GPT-SoVITS v2 的中文前端 `chinese2.text_normalize` = PaddleSpeech NSW 归一化 + 正则
 * `[^\u4e00-\u9fa5 + !?…,.-]` 把**其它字符整段删掉**。于是：
 *   `https://github.com/BubbleSalt/dsh-nori-pet`
 *     → 冒号/斜杠/点/连字符**被当成音素**、字母被删 → `秒每每.米每每毫秒减减`
 *     → 合成后 ASR 回转成「想尽太刺激哈,坎坷不受DSHNORI PATCH的抵制」（相似度 0.20）
 *   `C:[盘符]/<用户目录>/AppData/Roaming/npm` → 「路径是CU325update 互联攀片这里」（0.33）
 *   `npm run build`                       → 「施行三批耳门斗都行啦」（0.12）
 *   `嗯……唔……那个……`                     → 「嗯~~~n-n-n-n-n-n-n-n」（0.11，AR 在鼻音上循环）
 * 即：**符号/拉丁串被剥掉后，残句太短，AR 开始自由发挥**——这就是"外星文"。
 *
 * 策略（与工业级 TTS 文本前端同思路：先替换非标准词，再决定哪些内容读、怎么读）：
 *  1) 会**毁掉上下文**的整串内容（URL/文件路径/命令行）→ 换成可朗读说法（"某个链接"），
 *     或按配置直接删（`readUrls=false`）；
 *  2) **标点/符号**按读音替换（`→` 变成 "变成"、`≥` → "大于等于"），而不是留给前端当音素念；
 *  3) **Markdown 修饰符**（`**` `#` `>` `|` 反引号）剥掉——它们只是格式，不是内容；
 *  4) 剥完若**剩下不足底线**（默认 2 字），判定"没有可读内容"，由调用方**放弃合成**——
 *     宁可不出声，也不要吐怪音；
 *  5) emoji / 不可读符号统一剥除（前端会删，但先删能避免标点相邻产生的怪停顿）。
 *
 * ⚠ 数字、单位、百分号交给前端（PaddleSpeech NSW）处理，实测这两条都正确：
 *   `90%` → `百分之九十`；`0.9` → `零点九`；`3~5` → `三到五`。**不要**在插件侧重复转换。
 */

import { cleanSpeech } from './segmentation.js'

import { CJK_ALNUM, codeFence } from './textPatterns.js'

export interface SpeakTextOptions {
  /** 是否朗读 URL（false = 直接删掉；默认 true，读作"某个链接"） */
  readUrls?: boolean
  /** 是否朗读文件路径（默认 true，读作"某个路径"） */
  readPaths?: boolean
}

/** 可朗读的最低字数：低于它就没什么可念的，交给调用方放弃合成 */
export const MIN_SPEAKABLE_CHARS = 2

/** 统计"真正会被念出来的字数"（汉字/字母/数字） */
export function speakableLength(text: string): number {
  let n = 0
  for (const ch of text) if (CJK_ALNUM.test(ch)) n++
  return n
}

/**
 * URL：**必须最先处理**——先剥别的会把 URL 打散，之后再也认不出来。
 * 覆盖 http(s)://、www.、裸域名（含端口/路径/查询）。
 */
const RE_URL = /(?:https?:\/\/|www\.)[^\s，。！？；、）】」》"'…]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s，。！？；、）】」》"'…]*/gi

/** 去掉行号/锚点后缀：`a.json:416`、`x.ts#L24-L30` */
const stripLineRef = (s: string): string => s.replace(/(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/i, '')

/**
 * 路径只保留**文件名**，目录部分整段去掉（用户口径：把路径去掉、只剩文件名就可以接受）。
 *
 * 为什么**不**硬换成"那个文件"/"某个路径"这类中文词（那一版被否掉了）：语音里没有先行词，
 * "那个文件"等于什么都没说，反而莫名其妙。而文件名是拉丁串，GPT-SoVITS v2 前端本来就
 * 会丢掉非汉字部分——所以"路径不读"在听感上自然成立，不需要也不该塞中文占位词。
 *
 * ⚠ 必须**整串连目录一起**匹配：只认文件名时 `~\.dsh\storages\workspace.json` 会剩下
 * `~\.dsh\storages\` 这半截路径，被逐字符念成"波浪号 反斜杠 dsh 反斜杠…"——这才是
 * 用户说的"莫名其妙"。所以要先把整条路径吃掉，再只把文件名放回去。
 * ⚠ 尾串**排除中文**：`C:/a/b里的内容` 不能把"里的内容"一起吞掉（会吃掉正文）。
 */
const RE_PATH = /(?:[A-Za-z]:[\\/]|~[\\/]|\\\\)[^\s，。！？；、）】」》"…\u4e00-\u9fff\u3000-\u303f]*|(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g
/** 行内代码 `` `…` ``：agent 的路径几乎都在里面，按代码跨识别才能吃掉**带空格的路径** */
const RE_CODE_SPAN = /`([^`\n]{1,200})`/g

/**
 * 取路径的文件名部分：`C:\a\b\x.ts` → `x.ts`；`~/a/b.json` → `b.json`；`/a/b/` → `b`。
 * 返回空串表示这串里没有任何段（调用方按"整段删掉"处理）。
 */
const basenameOf = (p: string): string => {
  const s = stripLineRef(String(p).trim().replace(/^[`'"]+|[`'"]+$/g, ''))
  const segs = s.split(/[\\/]+/).filter((x) => x.length > 0)
  return segs.length ? segs[segs.length - 1]! : ''
}
/** 这串是不是路径（带分隔符、含 ASCII 字母数字、且不是 `1/2` 这类分数） */
const looksLikePath = (raw: string): boolean => {
  const s = stripLineRef(String(raw).trim())
  return /[\\/]/.test(s) && /[A-Za-z0-9]/.test(s) && !/^[\d.]+[\\/][\d.]+$/.test(s)
}

/** 命令行形态：`npm run build`、`git commit -m`、带 .exe/.ps1 的文件名 */
const RE_COMMAND = /\b(?:npm|npx|pnpm|yarn|node|git|pip|python|cargo|go|docker)\b(?:\s+(?:run|install|add|commit|push|pull|clone|build|test|-{1,2}[a-z-]+|[A-Za-z0-9_.-]+))+/gi
/** 符号读音（前端会把这些当音素念成怪音） */
const SYMBOL_READ: Array<[RegExp, string]> = [
  [/→|->|=>/g, '变成'],
  [/←|<-/g, '来自'],
  [/≥|>=/g, '大于等于'],
  [/≤|<=/g, '小于等于'],
  [/≠|!=/g, '不等于'],
  [/≈/g, '约等于'],
  [/[÷]/g, '除以'],
  [/[±]/g, '正负'],
  [/[&＆]/g, '和'],
  [/[|｜]/g, '或'],
  [/[@＠]/g, '艾特'],
  // 连续等号（`==`/`===`）读作"等于"，否则会念成"等于等于"
  [/={2,}|＝{2,}/g, '等于'],
  [/[=＝]/g, '等于'],
]
// ⚠ 两处**故意不做**的转换（实测数据支持的结论）：
//  · 数字/单位/百分号——前端 PaddleSpeech NSW 更准：`90%`→`百分之九十`、`0.9`→`零点九`、`3~5`→`三到五`。
//    （我曾给 `%` 加替换，结果变成 `90百分之`。）同理 `~` 交给前端比手动转"到"更准。
//  · `×`/`+`——模型本来就念对（A/B 实测 `3×4` → "三乘四"，相似度 0.50 只因 ASR 把阿拉伯数字写成汉字，
//    属度量噪声）；改成"乘"反而丢掉数字形态，相似度更低（0.60）。**只修真正念错的符号**。
/** Markdown / 排版修饰符：只是格式，不是内容。
 *  ⚠ 不含 `_`：标识符里合法（`api_v2`），剥掉会变成 `apiv2` 连读；Markdown 斜体下划线很罕见。 */
const RE_MD_MARKS = /[`*^#>\\]/g
/**
 * 列表标记（`1. ` / `- ` / `• `）：只是排版，念出来会变成"一、""二、"这种怪读法。
 * 实测 `1. 列表项一，2. 列表项二。` 现状念成「一,列表箱一,二列表箱二」（0.60），剥掉序号后内容才干净。
 *
 * ⚠ 判据里必须带**序号后的空白**：`2. ` 是列表，而 `0.2.4`、`3.5 秒` 是数字/小数**不能动**
 *（前端要拿它们做 NSW：`0.2.4` → "零点二点四"）。不带空白会把版本号吃成 `2.4`。
 */
const RE_LIST_MARK = /(^|[\n。！？；，,、])\s*(?:[0-9１-９]{1,2}[.．、)）]\s+|[-•·*+]\s+)/g
/** 代码块围栏整段丢弃 */
const RE_CODE_FENCE = codeFence()
/**
 * 纯语气词/顿挫文本（"嗯……唔……那个……"这类）：剥掉标点后基本不剩内容。
 * 实测这类文本会被 AR 唱成「嗯~~~n-n-n-n-n-n-n-n」——**宁可不出声**。
 */
const RE_FILLER = /[嗯唔呃哦噢唉啊哦唔诶嘿哈呃]|那个|就是|然后呢/g
/**
 * 装饰性符号串：`****----====` 这种"分隔线/气氛符号"。
 * 剥掉 Markdown 修饰符后可能还剩 `----====`，再被符号读音规则变成"等于等于"——听起来像内容，
 * 其实是噪声（实测合成出 98KB 音频）。判据：剥除后剩下的字符里**近半是符号**即视为无内容。
 */
const RE_SYMBOL_CH = /[!-/:-@[-`{-~！-／：-＠［-｀｛-～、。，；：？！…—～·※★☆]/g

/**
 * 把文本整理成"安全可朗读"的形态。
 * 返回 { text, dropped }：dropped=true 表示内容被判定为不可朗读（调用方应放弃合成）。
 */
export function toSpeakable(text: string, opts: SpeakTextOptions = {}): { text: string; dropped: boolean } {
  const readUrls = opts.readUrls !== false
  const readPaths = opts.readPaths !== false
  let t = String(text ?? '').replace(/\r/g, '')

  // 0) 代码块整段丢弃（代码逐字符念出来必然怪音，且内容价值低）
  t = t.replace(RE_CODE_FENCE, ' ')
  // 1) 行内代码里的路径**先整体识别**：agent 的路径几乎都在反引号里，按代码跨处理才能
  //    连"带空格的路径"一起吃掉（裸正则会在空格处断开，留下半截路径被逐字符念出来）
  t = t.replace(RE_CODE_SPAN, (m: string, inner: string) => {
    if (!looksLikePath(inner)) return m // 不是路径 → 原样返回，后面照常剥反引号
    return readPaths ? basenameOf(inner) : ' '
  })
  // 2) 整串替换/删除（顺序：URL → 命令行 → 路径只留文件名）
  t = t.replace(RE_URL, readUrls ? '某个链接' : ' ')
  t = t.replace(RE_COMMAND, '那句命令')
  t = t.replace(RE_PATH, (m: string) => (readPaths ? basenameOf(m) : ' '))
  // 2) 情绪标签与其残骸（`【happy】` / 被 ICU 切开的 `【`、`serious】`）——控制标记不是正文。
  //    放在"整串替换"之后：标签里一般不含 URL/路径，顺序不影响正确性，但先剥标签能让后面
  //    的符号规则少走弯路。实机教训：`serious】` 曾被当成正文念出来过。
  t = cleanSpeech(t)
  // 3) 符号 → 读音
  for (const [re, rep] of SYMBOL_READ) t = t.replace(re, rep)
  // 4) Markdown 修饰符与残留控制符
  t = t.replace(RE_LIST_MARK, '$1')
  t = t.replace(RE_MD_MARKS, '')
  // 波浪号只在**非数字间**才剥：`3~5` 要留给前端读作"三到五"，句尾的 `~` 是语气符号
  t = t.replace(/(?<![0-9０-９])[~～]+(?![0-9０-９])/g, '')
  t = t.replace(/\u200b|\ufeff/g, '')
  // 4) 不可读符号（emoji、方框、私有区）与**排版括号**剥除。
  //    `【】` 是情绪标签括号：cleanSpeech 已在管线前段剥过完整标签，但**只带一侧**的残骸
  //    （`【happy`、`happy】`）会留到这里——括号本身不发音，剥掉让标签词回到裸词状态。
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{E000}-\u{F8FF}]/gu, '')
  t = t.replace(/[【】\[\]<>《》「」『』〔〕]/g, '')
  // 5) 整理空白与标点：连续句读折叠（前端遇重复标点会制造怪停顿）
  t = t.replace(/[ \t]{2,}/g, ' ')
  t = t.replace(/\s+([，。！？；：、）】》」])/g, '$1') // 标点前的空白
  t = t.replace(/([（【《「])\s+/g, '$1') // 开括号后的空白
  t = t.replace(/([，。！？；：、])\s+/g, '$1') // 标点后的空白（中文标点自带间隔，空格会被念成停顿）
  t = t.replace(/[ \t]+$/gm, '') // 行尾空白（代码块被丢弃后会留下空行带空格）
  t = t.replace(/\n{3,}/g, '\n\n')
  t = t.replace(/([，。！？；：、])\1+/g, '$1')
  t = t.trim()

  // 6) 纯语气词判定：剥掉标点与语气词后若几乎不剩内容，判为不可朗读
  const fillers = (t.match(RE_FILLER) ?? []).join('').length
  const kept = speakableLength(t)
  const mostlyFiller = kept > 0 && fillers >= Math.max(2, Math.ceil(kept * 0.6))
  // 7) 装饰性符号串：剩余内容里符号占比过高 → 也不是内容（"****----====" 这类）
  const syms = (t.match(RE_SYMBOL_CH) ?? []).length
  const mostlySymbols = kept + syms > 0 && syms >= Math.max(2, Math.ceil((kept + syms) * 0.4))

  const dropped = kept < MIN_SPEAKABLE_CHARS || mostlyFiller || (syms > 0 && mostlySymbols && kept <= syms)
  return { text: t, dropped }
}

/**
 * 保证一句话以**唯一的**句末标点结尾。
 *
 * 为什么需要（真实踩坑，用户在气泡里看到"结尾两个句号"）：宿主会**拼接**文案——
 * 权限提醒 = `'有权限申请：' + tool + '。原因：' + reason + '。'`，无条件补的那个句号
 * 撞上 reason 自带的句号就变成 `。。`。朗读侧 `toSpeakable` 会把重复标点折叠掉，
 * 所以**只有界面文字露馅**（声音反而正常）——这类坑不跑到视图层根本看不见。
 *
 * 规则：
 *  - 连续相同的中文标点压成一个（`。。` `，，` `；；`）；`……`、`！？` 这类**有意**的组合原样保留；
 *  - 结尾没有任何句末标点时补一个 `。`；已有则不再追加。
 */
export function endWithPeriod(input: string): string {
  const t = String(input).trim().replace(/([。．.，,；;、：:])\1+/g, '$1')
  if (!t) return ''
  if (/[。．.！!？?…；;]$/.test(t)) return t
  // 悬空的逗号/顿号/冒号（截断、拼接没接上）→ 换成句号，绝不拼出"，。"这种鬼东西
  if (/[，,、：:]$/.test(t)) return t.slice(0, -1) + '。'
  return t + '。'
}

/**
 * 把 DSH 的技术文案翻成人话（只匹配已知模式；不认识的原样返回，绝不猜）。
 *
 * dsh-sandbox 的 `reason` 形如 `escalate sandbox to danger-full-access: <理由>`——
 * 英文技术前缀念出来又长又怪，在气泡里对用户也没有意义。
 */
export function friendlyApprovalReason(reason: string): string {
  const raw = String(reason ?? '').trim()
  if (!raw) return ''
  const m = raw.match(/^escalate sandbox to (\S+?):\s*([\s\S]*)$/)
  if (m) return `允许本次操作使用 ${m[1]} 权限：${m[2]}`
  return raw
}
