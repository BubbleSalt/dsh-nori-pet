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

export interface Persona {
  /** 人设 system prompt（persona/prompt.txt 内容） */
  prompt: string
  /** 改写任务补充指令（persona/reframe.txt 内容） */
  reframe: string
}

export interface PersonaConfig {
  personaPrompt?: string
  personaReframe?: string
}

/**
 * 解析两个人设文件的实际路径（空串 = 未找到）。
 * 供"启动加载 + 请求时热读"两处共用：规则改一句就能听出来，不必重载插件。
 */
export function resolvePersonaPaths(repoRoot: string, cfg: PersonaConfig = {}): { promptPath: string; reframePath: string } {
  const locate = (v: string | undefined, fallback: string): string => {
    if (v) return isAbsolute(v) ? v : resolve(repoRoot, v)
    const p = join(repoRoot, fallback)
    return existsSync(p) ? p : ''
  }
  return {
    promptPath: locate(cfg.personaPrompt, join('persona', 'prompt.txt')),
    reframePath: locate(cfg.personaReframe, join('persona', 'reframe.txt')),
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
    const stripBom = (t: string) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t)
    const t = stripBom(s)
    return t.trim() ? t : cached
  } catch {
    return cached
  }
}

export function loadPersona(repoRoot: string, cfg: PersonaConfig = {}): Persona | null {
  const locate = (v: string | undefined, fallback: string): string => {
    if (v) return isAbsolute(v) ? v : resolve(repoRoot, v)
    const p = join(repoRoot, fallback)
    return existsSync(p) ? p : ''
  }
  const promptPath = locate(cfg.personaPrompt, join('persona', 'prompt.txt'))
  const reframePath = locate(cfg.personaReframe, join('persona', 'reframe.txt'))
  if (!promptPath || !reframePath) return null
  try {
    const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)
    const prompt = stripBom(readFileSync(promptPath, 'utf8'))
    const reframe = stripBom(readFileSync(reframePath, 'utf8'))
    if (!prompt.trim() || !reframe.trim()) return null
    return { prompt, reframe }
  } catch {
    return null
  }
}