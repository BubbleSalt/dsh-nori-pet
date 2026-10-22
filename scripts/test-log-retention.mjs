#!/usr/bin/env node
/**
 * 日志上限测试：node scripts/test-log-retention.mjs
 *
 * 背景（两次真实踩坑，"看着有上限、其实没有"）：
 *   ① trace 曾是 5 个 slot 轮转、按**条数**裁、总量无上限，且 slot 指针是模块级变量、
 *      热重载即重置回 0 → 同一文件被反复续写，实测涨到 1MB 还在涨。
 *   ② error/summary 用的是"满 100 条裁到 50 条"，计数器同样活不过一次热重载 →
 *      实测 error.log 涨到 **677 条**仍无人裁。
 * 结论：上限判定**不能依赖任何跨实例状态**。现在三套日志统一按**字节**判：
 * 每次 stat 一下即可，超 maxBytes 就从最旧删到 keepBytes 附近。
 *
 * 契约（缺一条都算坏）：
 *   ① 未超上限 → 不读盘、不重写（正常路径零额外开销）
 *   ② 超上限 → 从**最旧**删起、保留最新；不得删空；体积有上界，且裁剪次数很少（不抖动）
 *   ③ 日志目录超预算 → 删**最旧的文件**，且不删正在写的最新文件
 *
 * ⚠ 本测试以前只能引用一份"与实现同构的镜像"（真实实现闭包在插件作用域里，
 *   import 不到）。现在实现搬到 src/logs.ts 并通过 lib/logs.js 导出，这里直接测**真身**：
 *   镜像与实现各自漂移的问题就此消失（上限数值也改成从实现 import，不再抄一遍）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  trimLogBySize, enforceLogBudget,
  TRACE_MAX_BYTES, TRACE_KEEP_BYTES, ERROR_MAX_BYTES, ERROR_KEEP_BYTES,
  SUMMARY_MAX_BYTES, SUMMARY_KEEP_BYTES, LOG_BUDGET,
} from '../lib/logs.js'

const BUDGET = LOG_BUDGET
const BLOCK_RE = /(?=^\[\d{4}-\d{2}-\d{2}T)/m
/** 三套日志各自的上限（**数值来自实现**，不在此重复抄写） */
const CAPS = {
  trace: { max: TRACE_MAX_BYTES, keep: TRACE_KEEP_BYTES, file: 'nori-pet-trace.log' },
  error: { max: ERROR_MAX_BYTES, keep: ERROR_KEEP_BYTES, file: 'nori-pet-error.log' },
  summary: { max: SUMMARY_MAX_BYTES, keep: SUMMARY_KEEP_BYTES, file: 'nori-pet-summary.log' },
}

const traceEntry = (i) =>
  `[2026-10-18T04:00:0${i % 10}.000Z] (10ms) src=reframe len=100 fp=abc${i}\n` +
  `IN : ${'a'.repeat(500)}\nOUT: ${'b'.repeat(500)}\n────\n`
/** error.log 里是堆栈：一条上千字节，长短悬殊 —— 正是"按条数裁"会失手的地方 */
const errEntry = (i) =>
  `[2026-10-18T04:00:0${i % 10}.000Z] [nori-pet] handler error @ api: Error: boom\n` +
  `    at handleApi (file:///x/index.js:1:1)\n    at safeHandler (file:///x/index.js:2:2)\n${'    at frame (x.y:1:1)\n'.repeat(40)}\n`

const readOpts = { bigint: false }

test('未超上限时不重写文件（正常路径零额外开销）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
  try {
    const p = join(dir, CAPS.trace.file)
    writeFileSync(p, traceEntry(0), 'utf8')
    for (let i = 1; i < 300; i++) writeFileSync(p, traceEntry(i), { flag: 'a' })
    const before = statSync(p, readOpts)
    for (let i = 0; i < 200; i++) trimLogBySize(p, CAPS.trace.max, CAPS.trace.keep)
    const after = statSync(p, readOpts)
    assert.equal(after.size, before.size, '未超限不应改动文件体积')
    assert.equal(after.mtimeMs, before.mtimeMs, '未超限不应重写文件（mtime 必须不变）')
    assert.equal(readFileSync(p, 'utf8').split(BLOCK_RE).filter((b) => b.trim()).length, 300)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const [name, cap] of Object.entries(CAPS)) {
  test(`${name}.log 超上限 → 从最旧删起保留最新，体积有上界且不抖动`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
    try {
      const p = join(dir, cap.file)
      const mk = name === 'error' ? errEntry : traceEntry
      const perIter = Buffer.byteLength(mk(0), 'utf8')
      const iters = Math.ceil((cap.max * 3) / perIter) // 写约 3 倍上限（够跨多次裁剪，又不至于跑太久）
      let maxSize = 0
      let postTrim = 0
      let trimCount = 0
      for (let i = 0; i < iters; i++) {
        const sizeBefore = existsSync(p) ? statSync(p, readOpts).size : 0
        trimLogBySize(p, cap.max, cap.keep)
        const sizeAfter = existsSync(p) ? statSync(p, readOpts).size : 0
        if (sizeAfter < sizeBefore) { trimCount += 1; postTrim = sizeAfter }
        writeFileSync(p, mk(i), { flag: 'a' })
        maxSize = Math.max(maxSize, statSync(p, readOpts).size)
      }
      if (process.env.NORI_DEBUG_LOG) {
        console.log(`  [${name}] per=${perIter} iters=${iters} max=${cap.max} keep=${cap.keep}`
          + ` → 峰值=${maxSize} 最后裁剪后=${postTrim} 裁剪次数=${trimCount}`)
      }
      // 上界：裁剪只在"写之前"发生，故峰值 ≤ max + 单条长度
      assert.ok(maxSize <= cap.max + perIter + 64,
        `${cap.file} 峰值应 ≤ max+单条(${cap.max + perIter + 64})，实测 ${maxSize}`)
      const kept = readFileSync(p, 'utf8').split(BLOCK_RE).filter((b) => b.trim())
      assert.ok(kept.length > 0, '★ 绝不能把日志删空（那等于排障信息全丢）')
      assert.match(kept[kept.length - 1], new RegExp(`abc${iters - 1}|boom`), '保留的必须是最新那条')
      assert.ok(trimCount < iters / 3, `裁剪次数应远少于写入次数，实测 ${trimCount}/${iters}`)
      assert.ok(postTrim > 0 && postTrim <= cap.keep + perIter * 3 + 64,
        `${name}.log 裁剪后应贴近 keep=${cap.keep}，实测 ${postTrim}`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

test('反向验证：不做裁剪时确实会一直涨（证明上面的断言有效）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
  try {
    const p = join(dir, 'nori-pet-error.log')
    // 必须真写超上限才叫反向验证：error 上限 512KB，一条约 1KB → 至少 600 条
    const n = Math.ceil((CAPS.error.max * 1.5) / Buffer.byteLength(errEntry(0), 'utf8'))
    writeFileSync(p, Array.from({ length: n }, (_, i) => errEntry(i)).join(''), 'utf8')
    const size = statSync(p, readOpts).size
    assert.ok(size > CAPS.error.max, `未裁剪的 error.log 应超上限 ${CAPS.error.max}，实测 ${size}（写了 ${n} 条）`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('日志目录超预算 → 删最旧的文件，且不动最新那份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
  try {
    // 5 个 2MB 文件 = 10MB > 8MB 预算；文件名顺序即新旧（mtime 显式设置，避免同毫秒写入导致排序不确定）
    const names = ['nori-pet-trace.3.log', 'nori-pet-trace.2.log', 'nori-pet-error.log', 'nori-pet-summary.log', 'nori-pet-trace.log']
    const base = Date.now() - 100000
    names.forEach((n, i) => {
      const p = join(dir, n)
      writeFileSync(p, 'x'.repeat(2 << 20), 'utf8')
      const t = (base + i * 1000) / 1000
      utimesSync(p, t, t)
    })
    const removed = enforceLogBudget(dir)
    assert.ok(removed.length > 0, '超预算时必须动手删')
    assert.equal(removed[0], names[0], `应先删最旧的（期望 ${names[0]}，实际 ${removed[0]}）`)
    assert.ok(!removed.includes('nori-pet-trace.log'), '不该优先删当前正在写的 trace 主文件（它最新）')
    const left = names.filter((n) => existsSync(join(dir, n)))
    const total = left.reduce((n, f) => n + statSync(join(dir, f), readOpts).size, 0)
    assert.ok(total <= BUDGET, `删完必须回到预算内，实测 ${total}`)
    assert.ok(existsSync(join(dir, 'nori-pet-trace.log')), '最新文件必须保留')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('预算内不删任何文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
  try {
    writeFileSync(join(dir, 'nori-pet-trace.log'), 'x'.repeat(1024), 'utf8')
    assert.deepEqual(enforceLogBudget(dir), [])
    assert.ok(existsSync(join(dir, 'nori-pet-trace.log')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
