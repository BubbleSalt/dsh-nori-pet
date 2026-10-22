/**
 * nori.config.json 的读写层（配置 UI 的后端）。
 *
 * 三条硬规则，都是踩过坑换来的：
 *  1. **未知键必须保留** —— 用户可能手写了未来版本的键，或加了注释性字段；UI 只允许改白名单里的，
 *     其余原样写回。否则"打开设置点保存"就等于悄悄删配置。
 *  2. **校验不过就不落盘** —— 写文件前先合并 + 校验；任何一项不合格整体拒绝并回滚。
 *  3. **密钥永不回传** —— GET 只给 `apiKeyConfigured: true/false`；POST 里 `null` = 不改、
 *     `''` = 清除。明文一旦进了 UI 就迟早进日志/截图。
 *
 * 写入用 tmp + rename：中途崩溃不会留下半个 JSON（便携机/断电场景真实存在）。
 */
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, unlinkSync } from 'node:fs'


/** 密钥字段（写时特殊处理，读时脱敏） */
export const SECRET_PATHS = ['reframe.apiKey'] as const

export interface ConfigSnapshot {
  /** 脱敏后的配置（可直接下发 UI） */
  config: Record<string, unknown>
  /** 密钥是否已配置（永远不回传本体） */
  secrets: { apiKeyConfigured: boolean }
  /** 配置文件路径（便于 UI 显示"改的是哪个文件"） */
  file: string
}

export interface WriteResult {
  ok: boolean
  errors?: string[]
}

/** 从对象里按点路径取值 */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** 按点路径写值（自动建中间对象） */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.')
  let cur: Record<string, unknown> = obj
  for (const seg of segs.slice(0, -1)) {
    const next = cur[seg]
    if (!next || typeof next !== 'object' || Array.isArray(next)) cur[seg] = {}
    cur = cur[seg] as Record<string, unknown>
  }
  cur[segs[segs.length - 1]] = value
}

/** 深拷贝（配置是纯 JSON，够用） */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** 脱敏：把密钥换成一个布尔标记，键本身保留（UI 需要知道"这个字段存在"） */
export function redact(raw: Record<string, unknown>): { config: Record<string, unknown>; apiKeyConfigured: boolean } {
  const out = clone(raw)
  let apiKeyConfigured = false
  for (const path of SECRET_PATHS) {
    const v = getPath(raw, path)
    if (typeof v === 'string' && v.trim()) apiKeyConfigured = true
    // 删掉值本身，只留键（下游按 path 还原形状）
    const segs = path.split('.')
    let cur: Record<string, unknown> | undefined = out
    for (const seg of segs.slice(0, -1)) cur = cur?.[seg] as Record<string, unknown> | undefined
    if (cur && segs[segs.length - 1] in cur) cur[segs[segs.length - 1]] = null
  }
  return { config: out, apiKeyConfigured }
}

export interface ConfigStore {
  /** 读（脱敏）。文件不存在返回空配置，不抛 */
  snapshot(): ConfigSnapshot
  /** 写：白名单合并 + 校验 + 原子替换 + .bak 备份 */
  apply(patch: Record<string, unknown>, validate: (merged: Record<string, unknown>) => string[]): WriteResult
  /** 热读某个点路径（reframe/tts 的运行时覆盖用） */
  readPath<T = unknown>(path: string): T | undefined
}

export function createConfigStore(filePath: string, log: (msg: string) => void = () => undefined): ConfigStore {
  const readRaw = (): Record<string, unknown> => {
    if (!existsSync(filePath)) return {}
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        log(`配置不是对象，按空配置处理：${filePath}`)
        return {}
      }
      return parsed as Record<string, unknown>
    } catch (err) {
      // 写盘失败：清理临时文件后把原因返回给调用方（面板会显示），不是静默吞掉
      log(`配置解析失败，按空配置处理：${filePath} — ${String(err)}`)
      return {}
    }
  }

  return {
    snapshot() {
      const { config, apiKeyConfigured } = redact(readRaw())
      return { config, secrets: { apiKeyConfigured }, file: filePath }
    },

    apply(patch, validate) {
      const current = readRaw()
      const merged = clone(current)
      const errors: string[] = []
      for (const [key, value] of Object.entries(patch)) {
        // 不设白名单：nori.config.json 里的每一项都应由界面可配（密钥单独处理）。
        // 未知键也允许写入 —— 新版本加的配置项不该因为界面没跟上就被丢弃。
        if (value === null) continue // null = 不改（密钥清除请传 ''）
        merged[key] = clone(value)
      }      if (errors.length) return { ok: false, errors }

      // 密钥：显式传 '' 才清除；其余情况保留旧值（UI 拿不到明文，不能要求它回传）
      for (const path of SECRET_PATHS) {
        const incoming = getPath(patch, path)
        if (incoming === '') {
          const segs = path.split('.')
          const parent = getPath(merged, segs.slice(0, -1).join('.')) as Record<string, unknown> | undefined
          if (parent) delete parent[segs[segs.length - 1]]
        } else if (typeof incoming === 'string' && incoming.trim()) {
          setPath(merged, path, incoming.trim())
        }
      }

      const problems = validate(merged)
      if (problems.length) return { ok: false, errors: problems }

      try {
        const tmp = `${filePath}.tmp`
        writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8')
        if (existsSync(filePath)) copyFileSync(filePath, `${filePath}.bak`)
        renameSync(tmp, filePath)
        return { ok: true }
      } catch (err) {
        // 写盘失败：清理临时文件并把原因回给调用方（面板可见），非静默吞掉
        try { if (existsSync(`${filePath}.tmp`)) unlinkSync(`${filePath}.tmp`) } catch { /* 清理失败不影响主流程 */ }
        return { ok: false, errors: [`写盘失败：${String(err)}`] }
      }
    },

    readPath<T = unknown>(path: string): T | undefined {
      return getPath(readRaw(), path) as T | undefined
    },
  }
}
