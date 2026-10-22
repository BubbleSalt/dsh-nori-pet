/**
 * Nori 人设 Prompt 加载器（资产化版）。
 *
 * 人设 system prompt 与改写任务文本已从代码中拆出：
 *   - persona/prompt.txt   → 人设 system prompt（原 NORI_PROMPT 内容：I_NORI 授权文本，源出人设原文档，不入库）
 *   - persona/reframe.txt  → 改写任务补充指令（原 NORI_REFRAME_TASK 内容；无版权问题，随仓库提供）
 * 文件缺失/为空时返回 null，由宿主决定降级策略（改写层关闭、朗读原始输出）。
 * 路径可被配置 personaPrompt / personaReframe 覆盖（绝对路径或相对仓库根）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'

/** 剥 BOM：PowerShell 5.1 写出的 UTF-8 常带 BOM，留着会让首行指令失效 */
const stripBom = (t: string): string => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t)

/** 解析一个人设资产路径：配置覆盖优先（绝对路径或相对仓库根），否则回退到默认文件名 */
function locate(repoRoot: string, v: string | undefined, fallback: string): string {
  if (v) return isAbsolute(v) ? v : resolve(repoRoot, v)
  const p = join(repoRoot, fallback)
  return existsSync(p) ? p : ''
}

export interface Persona {
  /** 人设 system prompt（persona/prompt.txt 内容） */
  prompt: string
  /** 改写任务补充指令（persona/reframe.txt 内容） */
  reframe: string
  /** 概括任务规则（persona/summary.txt 内容；文件缺失时为空串，由 buildSystemPrompt 兜底默认规则） */
  summary: string
}

export interface PersonaConfig {
  personaPrompt?: string
  personaReframe?: string
  personaSummary?: string
}

/**
 * 概括模式的默认规则：只在 persona/summary.txt 缺失时兜底（老安装升级上来不至于没规则）。
 * 正常情况请改 persona/summary.txt —— 它是热读的，改完下一次概括就生效。
 *
 * 写作口径（两条，别再往 prompt 里塞工程叙事）：
 *  - prompt 里只写"模型能照做的事"：给数字、给动作、给判据。不写"实测容易超""以前被截断过"
 *    这类**项目历史**——模型没法据此做决定，反而把失败模式当成了已知行为。
 *  - 为什么定这个数、不达标时会发生什么，写在代码注释里（就是这里），给维护者看。
 * 另：这里的 3 句 / 140 字是**给模型的目标值**；capSpeech 的 4 句 / 150 字是**兜底阈值**，
 *    故意比目标宽一档，避免把刚好合规的输出也截掉。
 */
export const DEFAULT_SUMMARY_RULES = [
  '【本次任务：概括】上面是 dsh 一轮输出的全文。请把它概括成我会朗读的一段话。',
  '规则：',
  '1. 长度：以 3 句、140 字为目标，尽量短。要点实在压不进去时可以说长一点（最多 5 句、约 200 字）——宁可多说一句，也不要为了凑短删掉事实或结论。',
  '2. 必须保留：文件名/路径、数字（端口、行号、耗时、数量）、命令、结论（成功/失败/待办）、阻塞原因、需要我确认或授权的事。',
  '3. 可以丢：中间过程、重复叙述、"我接下来要……"这类预告、无信息量的过渡句。',
  '4. 不复述开头：开头几句可能已经逐句读过了，直接讲"结论 + 要你做的事"。',
  '5. 不编造：不确定的部分就说"细节在屏幕上"。',
  '6. 只输出要朗读的话：不要前缀、编号、标题、markdown 标记。',
].join('\n')

/**
 * 解析两个人设文件的实际路径（空串 = 未找到）。
 * 供"启动加载 + 请求时热读"两处共用：规则改一句就能听出来，不必重载插件。
 */
export function resolvePersonaPaths(repoRoot: string, cfg: PersonaConfig = {}): { promptPath: string; reframePath: string; summaryPath: string } {
  return {
    promptPath: locate(repoRoot, cfg.personaPrompt, join('persona', 'prompt.txt')),
    reframePath: locate(repoRoot, cfg.personaReframe, join('persona', 'reframe.txt')),
    summaryPath: locate(repoRoot, cfg.personaSummary, join('persona', 'summary.txt')),
  }
}

/**
 * 热读改写任务指令（persona/reframe.txt）。
 *
 * 为什么单独热读这一个文件：它是**调风格的旋钮**——嫌啰嗦、嫌太短、语气不对，改的都是它。
 * 启动只读一次的话，每次调风格都要重载插件，试错成本高到没人愿意调。
 * 文件很小（几 KB），每个改写请求读一次可忽略；读失败就退回启动时的副本，不影响链路。
 * 人设 system prompt（prompt.txt）较大且不常改，仍然只在启动时读。
 */
export function readReframeHot(reframePath: string, cached: string): string {
  if (!reframePath) return cached
  try {
    const s = readFileSync(reframePath, 'utf8')
    const t = stripBom(s)
    return t.trim() ? t : cached
  } catch { // 读失败 → 退回启动时缓存的副本（见上方注释）
    return cached
  }
}

/** 热读概括规则（persona/summary.txt）：和 reframe.txt 一样是调参旋钮，改完下次概括即生效 */
export function readSummaryHot(summaryPath: string, cached: string): string {
  if (!summaryPath) return cached
  try {
    const s = readFileSync(summaryPath, 'utf8')
    const t = stripBom(s)
    return t.trim() ? t : cached
  } catch { // 读失败 → 退回启动时缓存的副本
    return cached
  }
}

/**
 * 组装 system prompt：人设 + 改写规则（+ 概括规则，仅 summary 模式）。
 * 抽成纯函数是为了能断言"两种模式的 system 拼接差异"——以前这段拼在 reframe.ts 的请求路径里，
 * 概括规则以代码常量存在，改一句话要改代码 + 重装。
 */
export function buildSystemPrompt(parts: { prompt: string; reframe: string; summary?: string }, mode: 'reframe' | 'summary'): string {
  let s = parts.prompt + '\n\n' + parts.reframe
  if (mode === 'summary') s += '\n\n' + (parts.summary && parts.summary.trim() ? parts.summary : DEFAULT_SUMMARY_RULES)
  return s
}

export function loadPersona(repoRoot: string, cfg: PersonaConfig = {}): Persona | null {
  const promptPath = locate(repoRoot, cfg.personaPrompt, join('persona', 'prompt.txt'))
  const reframePath = locate(repoRoot, cfg.personaReframe, join('persona', 'reframe.txt'))
  if (!promptPath || !reframePath) return null
  try {
    const prompt = stripBom(readFileSync(promptPath, 'utf8'))
    const reframe = stripBom(readFileSync(reframePath, 'utf8'))
    if (!prompt.trim() || !reframe.trim()) return null
    // 概括规则**可选**：老安装没有这个文件也能跑（buildSystemPrompt 会兜底默认规则）
    const summaryPath = locate(repoRoot, cfg.personaSummary, join('persona', 'summary.txt'))
    const summary = summaryPath ? stripBom(readFileSync(summaryPath, 'utf8')) : ''
    return { prompt, reframe, summary: summary.trim() ? summary : '' }
  } catch { // 读取/权限失败 → 当作人设缺失：改写层降级为原文朗读
    return null
  }
}