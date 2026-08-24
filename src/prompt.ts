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