/**
 * 插件日志：三份文件（trace / summary / error）+ **字节级**上限 + 目录总预算。
 *
 * 从 index.ts 搬出：原先这套逻辑（约 90 行）活在宿主的 applyInner 闭包里，导致
 * scripts/test-log-retention.mjs 只能**照着实现抄一份镜像**来测（注释里写着"真实实现闭包在
 * 插件作用域内、无法直接 import"）——镜像与实现会各自漂移，这正是"看着有测试其实没锁住"的典型。
 * 现在实现是导出的纯模块，测试直接调用真身。
 *
 * 历史教训（都是"看着有上限、其实没有"）：
 *  1) trace 曾是 5 个 slot 轮转、按条数裁、总量无上限，且 slot 指针是模块级变量、
 *     热重载即重置回 0 → 同一文件被反复续写，实测涨到 1MB。
 *  2) error/summary 用的是"满 100 条裁到 50 条"，计数器同样活不过一次热重载 →
 *     实测 error.log 涨到 677 条仍无人裁。故现在统一按**字节**判（每次 stat 一下即可，
 *     不依赖任何跨实例状态）。字节阈值只保留下限、不做"裁到刚好"，避免在上限附近抖动。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const TRACE_FILE = 'nori-pet-trace.log'
export const TRACE_MAX_BYTES = 1 << 20 // 单文件超 1MB 即裁剪
export const TRACE_KEEP_BYTES = 512 << 10 // 裁到约 512KB（保留最新，按记录块切分）
export const ERROR_MAX_BYTES = 512 << 10
export const ERROR_KEEP_BYTES = 256 << 10
export const SUMMARY_MAX_BYTES = 256 << 10
export const SUMMARY_KEEP_BYTES = 128 << 10
export const LOG_BUDGET = 8 << 20 // 日志目录总预算 8MB：超了就删最旧的文件

/**
 * 日志目录：独立于注入器（`~/.dsh/super-injector` 是 dsh-super-injector 的地盘），
 * 迁到 `~/.dsh/logs/nori-pet/`（DSH_HOME 未设置则用 ~/.dsh）。
 */
export function noriLogDir(): string {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'logs', 'nori-pet')
}

/**
 * 单文件按字节裁剪：超 maxBytes 就从最旧删到 keepBytes 附近（保留最新）。
 * 每次 stat 一下判是否超限，未超即返回（正常路径不读盘）。
 *
 * 为什么不再按"条数"计：条数需要一个跨写入累加的计数器，而计数器活在插件实例里 ——
 * 热重载/重启就归零，于是"满 100 条才裁"几乎永远不触发。字节上限每次 stat 一下就能判，
 * 不依赖任何跨实例状态，也不怕条目长短悬殊（error.log 里是堆栈，一条可能上千字节）。
 */
export function trimLogBySize(p: string, maxBytes: number, keepBytes: number): void {
  try {
    if (!existsSync(p) || statSync(p).size <= maxBytes) return
    const raw = readFileSync(p, 'utf8')
    const blocks = raw.split(/(?=^\[\d{4}-\d{2}-\d{2}T)/m).filter((b) => b.trim())
    let kept = blocks.length
    let total = 0
    // 从后往前累计保留量：一直删到"累计不足 keepBytes"为止，且**至少留最后 1 条**。
    // 注意不能写成"一超就 break"——那样遇到单条大于 keepBytes 的情况会只留极少条数，
    // 体积仍贴着 max，于是下次写入又触发裁剪（既抖动又留不住历史）。实测就是这么翻车的。
    for (let i = blocks.length - 1; i >= 0; i--) {
      const len = blocks[i]!.length
      if (total + len > keepBytes && i < blocks.length - 1) break
      total += len
      kept = i
    }
    const slice = blocks.slice(kept)
    if (slice.length) writeFileSync(p, slice.join(''), 'utf8')
  } catch { /* ignore */ }
}

/**
 * 日志目录总预算：超过 budget 时，从**最旧的文件**开始删。
 * 为什么需要：单文件上限只约束单文件；轮转历史上会攒出多个文件（实测 2.4MB 一整个目录）。
 * 用文件 mtime 排序，删到预算以内为止（只删本插件自己的 trace/error/summary 日志）。
 *
 * @returns 被删掉的文件名（顺序即删除顺序；测试据此断言"删的是最旧的"）
 */
export function enforceLogBudget(dir: string = noriLogDir(), budget: number = LOG_BUDGET): string[] {
  const removed: string[] = []
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('nori-pet-') && f.endsWith('.log'))
      .map((f) => {
        const p = join(dir, f)
        const st = statSync(p)
        return { f, p, size: st.size, mtime: st.mtimeMs }
      })
    let total = files.reduce((n, x) => n + x.size, 0)
    if (total <= budget) return removed
    for (const x of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= budget) break
      try { unlinkSync(x.p) } catch { /* ignore */ }
      removed.push(x.f)
      total -= x.size
    }
  } catch { /* ignore */ }
  return removed
}

/**
 * 插件 apply 失败时的兜底落盘。
 * 此刻插件作用域可能还没建起来（所以不能依赖 createLogs），必须自带目录创建与上限裁剪。
 */
export function appendFatal(e: unknown): void {
  try {
    const dir = noriLogDir()
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    const p = join(dir, 'nori-pet-error.log')
    const stack = e && (e as Error).stack ? (e as Error).stack : String(e)
    appendFileSync(p, '[' + new Date().toISOString() + ']\n' + stack + '\n')
    trimLogBySize(p, ERROR_MAX_BYTES, ERROR_KEEP_BYTES)
  } catch { /* ignore */ }
}

export interface NoriLogs {
  /** 日志目录（调用方偶尔需要拼路径） */
  dir(): string
  /** 错误摘要（含 URL/模型名/堆栈片段），超上限自动裁剪 */
  appendErr(line: string): void
  /**
   * 改写层输入/输出追踪：材料→改写结果两列。
   * ⚠ 写的是**对话原文**（各截 500 字），只在排障时有用；`on` 由 nori.config.json 的
   * `reframe.trace` 热控（每次调用传进来，改配置立即生效无需重装）。
   */
  trace(input: string, output: string, ms: number, on: boolean, src?: string): void
  /** 概括层追踪：原文→概括，用"压缩比"验证是否真的省了朗读时间（与 trace 同开关） */
  traceSummary(raw: string, out: string, ms: number, on: boolean): void
  /** 启动清理 + 目录预算检查 */
  init(): void
}

/** 建一套日志句柄：`log` 由宿主注入（ctx.logger 或 console） */
export function createLogs(opts: { log: (...args: unknown[]) => void }): NoriLogs {
  const { log } = opts
  const tracePath = join(noriLogDir(), TRACE_FILE)
  const traceTrim = (): void => trimLogBySize(tracePath, TRACE_MAX_BYTES, TRACE_KEEP_BYTES)

  return {
    dir: noriLogDir,

    appendErr(line: string): void {
      const p = join(noriLogDir(), 'nori-pet-error.log')
      try {
        appendFileSync(p, '[' + new Date().toISOString() + '] ' + line + '\n')
      } catch { /* ignore */ }
      trimLogBySize(p, ERROR_MAX_BYTES, ERROR_KEEP_BYTES)
    },

    trace(input: string, output: string, ms: number, on: boolean, src = ''): void {
      try {
        if (!on) return
        // 记录来源与长度：出现"同一段被改写两次"时，靠 src/len 一眼判断是投递重复还是模型重复
        const tag = src ? ` src=${src} len=${input.length}` : ` len=${input.length}`
        const fp = createHash('sha1').update(input).digest('hex').slice(0, 8)
        const entry = `[${new Date().toISOString()}] (${ms}ms)${tag} fp=${fp}\nIN : ${input.slice(0, 500)}\nOUT: ${output.slice(0, 500)}\n────\n`
        traceTrim() // 先裁后写：文件始终在上限内
        appendFileSync(tracePath, entry)
      } catch { /* ignore */ }
    },

    traceSummary(raw: string, out: string, ms: number, on: boolean): void {
      try {
        if (!on) return
        const ratio = raw.length ? Math.round((out.length / raw.length) * 100) : 0
        const p = join(noriLogDir(), 'nori-pet-summary.log')
        appendFileSync(p, `[${new Date().toISOString()}] (${ms}ms) 原文${raw.length}字 → 概括${out.length}字（压缩到 ${ratio}%）\nRAW: ${raw.slice(0, 300)}\nSUM: ${out.slice(0, 300)}\n────\n`)
        trimLogBySize(p, SUMMARY_MAX_BYTES, SUMMARY_KEEP_BYTES)
      } catch { /* ignore */ }
    },

    init(): void {
      try {
        const dir = noriLogDir()
        try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
        // 旧版是「nori-pet-trace.1.log ~ .4.log + slot 文件」多文件轮转，总量无上限。
        // 改成单文件后这些旧文件不会再被写入，留着只会让人分不清哪个是当前日志 → 顺手收掉。
        try { unlinkSync(join(dir, 'nori-pet-trace.slot')) } catch { /* 可能不存在 */ }
        for (let s = 1; s < 10; s++) {
          try { unlinkSync(join(dir, `nori-pet-trace.${s}.log`)) } catch { /* 可能不存在 */ }
        }
        // 启动即把"已经超限的历史遗留文件"收进上限内：否则要等到下次写入才裁，
        // 期间用户看到的就是个超标文件（本次就是这么发现 error.log 涨到 677 条的）。
        traceTrim()
        trimLogBySize(join(dir, 'nori-pet-error.log'), ERROR_MAX_BYTES, ERROR_KEEP_BYTES)
        trimLogBySize(join(dir, 'nori-pet-summary.log'), SUMMARY_MAX_BYTES, SUMMARY_KEEP_BYTES)
        for (const f of enforceLogBudget(dir)) log(`[dsh-nori-pet] 日志超出预算，已删除最旧：${f}`)
      } catch { /* ignore */ }
    },
  }
}
