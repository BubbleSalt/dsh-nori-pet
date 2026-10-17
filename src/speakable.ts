/**
 * 可播内容抽取：从 dsh 输出里剔除"念出来没意义"的大块结构，替换成类别短语。
 *
 * 为什么替换而不是删除：保留"这里有一大段代码/输出"这一语义，概括时才不会把它当成缺失的上下文，
 * 也便于概括层知道"作者贴了东西、要你看屏幕"。同时显著缩小概括请求的输入。
 *
 * 只做保守判断（宁可漏替换、不可误伤正文）：
 *  - 围栏代码块（```）：整体替换
 *  - diff（`diff --git` / `@@` / `+++` / `---` / `Index:`）
 *  - JSON（单行对象/数组、`"key": value`）
 *  - 日志（ISO 时间戳 / `[HH:MM` / INFO|WARN|ERROR|DEBUG|TRACE 行首）
 *  - 表格（`| a | b |` 或 `--------` 分隔线）
 *  - 文件清单（纯路径行、`xx.ts` 这类裸文件名行）
 */

const CODE_BLOCK = /```[\s\S]*?```/g
const CODE_BLOCK_OPEN = /^```[\s\S]*$/m
const DIFF = /^(diff --git|@@ |\+\+\+ |--- |Index: )/
const JSON_LINE = /^[[{][\s\S]*[\]}],?$|^"[^"]+":\s/
const LOG_LINE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|^\[\d{2}:\d{2}|^(INFO|WARN|ERROR|DEBUG|TRACE)\b/
const TABLE = /^\|.*\|$|^[-+|]{8,}$/
/** 文件清单行：含扩展名的相对/绝对路径、或裸文件名（`src/index.ts`、`D:\a\b.md`、`README.md`） */
const LISTING = /^[^\s]*[\\/][^\s]*\.[A-Za-z0-9]{1,6}$|^[\w.-]+\.(ts|tsx|js|mjs|cjs|json|md|py|ps1|log|yaml|yml|txt|toml|lock|css|html)$/
/** diff 内容行（`+xxx` / `-xxx`，排除 `+++`/`---` 头） */
const DIFF_BODY = /^[+-]\S/

function kindOf(line: string): string | null {
  if (DIFF.test(line) || DIFF_BODY.test(line)) return '一段改动 diff'
  if (JSON_LINE.test(line)) return '一坨 JSON 数据'
  if (LOG_LINE.test(line)) return '一段日志'
  if (TABLE.test(line)) return '一张表格'
  if (LISTING.test(line)) return '一串文件清单'
  return null
}

/** 抽取适合朗读的内容；连续同类行合并成一句类别短语 */
export function extractSpeakable(text: string): string {
  const s = String(text).replace(CODE_BLOCK, '（贴了一段代码）').replace(CODE_BLOCK_OPEN, '（贴了一段代码）')
  const out: string[] = []
  let bucket: string | null = null
  const flush = (): void => { if (bucket) { out.push(`（${bucket}）`); bucket = null } }
  for (const line of s.split('\n')) {
    const t = line.trim()
    if (!t) { flush(); continue }
    const kind = kindOf(t)
    if (kind) {
      if (bucket !== kind) { flush(); bucket = kind }
      continue
    }
    if (bucket) flush()
    out.push(line)
  }
  flush()
  return out.join('\n').trim()
}
