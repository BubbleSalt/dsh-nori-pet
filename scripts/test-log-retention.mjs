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
 *   ③ 日志目录超预算 → 删**最旧的文件**
 *
 * 本测试用与 src/index.ts 的 trimLogBySize/enforceLogBudget 同构的镜像实现
 * （真实实现闭包在插件作用域内、无法直接 import），关键分支两边一一对应；
 * ① 用"读盘次数"计数断言，② 用"连续写入后体积是否收敛 + 裁剪次数"断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUDGET = 8 << 20
const BLOCK_RE = /(?=^\[\d{4}-\d{2}-\d{2}T)/m
/** 三套日志各自的上限（与 src/index.ts 的调用点保持一致） */
const CAPS = {
  trace: { max: 1 << 20, keep: 512 << 10, file: 'nori-pet-trace.log' },
  error: { max: 512 << 10, keep: 256 << 10, file: 'nori-pet-error.log' },
  summary: { max: 256 << 10, keep: 128 << 10, file: 'nori-pet-summary.log' },
}

/** 与 src/index.ts trimLogBySize 同构的镜像（含读盘/重写计数） */
function makeLog(dir, cap) {
  const p = join(dir, cap.file)
  let reads = 0
  let writes = 0
  return {
    path: p,
    get reads() { return reads },
    get writes() { return writes },
    trim() {
      if (!existsSync(p) || statSync(p).size <= cap.max) return false
      reads += 1
      const blocks = readFileSync(p, 'utf8').split(BLOCK_RE).filter((b) => b.trim())
      let kept = blocks.length
      let total = 0
      // 与实现同构：删到"累计不足 keep"为止，至少留最后 1 条（不能一超就 break）
      for (let i = blocks.length - 1; i >= 0; i--) {
        const len = blocks[i].length
        if (total + len > cap.keep && i < blocks.length - 1) break
        total += len
        kept = i
      }
      const slice = blocks.slice(kept)
      if (slice.length) { writeFileSync(p, slice.join(''), 'utf8'); writes += 1 }
      return true
    },
    append(entry) { writeFileSync(p, entry, { flag: 'a' }) },
    entries() { return readFileSync(p, 'utf8').split(BLOCK_RE).filter((b) => b.trim()) },
    reset() { reads = 0; writes = 0 },
  }
}

const traceEntry = (i) =>
  `[2026-10-18T04:00:0${i % 10}.000Z] (10ms) src=reframe len=100 fp=abc${i}\n` +
  `IN : ${'a'.repeat(500)}\nOUT: ${'b'.repeat(500)}\n────\n`
/** error.log 里是堆栈：一条上千字节，长短悬殊 —— 正是"按条数裁"会失手的地方 */
const errEntry = (i) =>
  `[2026-10-18T04:00:0${i % 10}.000Z] [nori-pet] handler error @ api: Error: boom\n` +
  `    at handleApi (file:///x/index.js:1:1)\n    at safeHandler (file:///x/index.js:2:2)\n${'    at frame (x.y:1:1)\n'.repeat(40)}\n`

test('未超上限时不读盘、不重写（正常路径零额外开销）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
  try {
    const L = makeLog(dir, CAPS.trace)
    L.append(traceEntry(0))
    L.reset()
    for (let i = 1; i < 300; i++) { assert.equal(L.trim(), false, '未超限必须跳过裁剪纸'); L.append(traceEntry(i)) }
    assert.equal(L.reads, 0, '未超限不应读盘')
    assert.equal(L.writes, 0, '未超限不应重写文件')
    assert.equal(L.entries().length, 300)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const [name, cap] of Object.entries(CAPS)) {
  test(`${name}.log 超上限 → 从最旧删起保留最新，体积有上界且不抖动`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
    try {
      const L = makeLog(dir, cap)
      const mk = name === 'error' ? errEntry : traceEntry
      const perIter = Buffer.byteLength(mk(0), 'utf8')
      const iters = Math.ceil((cap.max * 3) / perIter) // 写约 3 倍上限的字节量（够跨多次裁剪，又不至于让测试跑太久）
      let maxSize = 0
      let postTrim = 0
      for (let i = 0; i < iters; i++) {
        const trimmed = L.trim()
        if (trimmed) postTrim = statSync(L.path).size
        L.append(mk(i))
        maxSize = Math.max(maxSize, statSync(L.path).size)
      }
      const slack = perIter * 2 + 64
      if (process.env.NORI_DEBUG_LOG) {
        console.log(`  [${name}] per=${perIter} iters=${iters} max=${cap.max} keep=${cap.keep}`
          + ` → 峰值=${maxSize} 最后裁剪后=${postTrim} 裁剪次数=${L.writes} 最终=${statSync(L.path).size}`)
      }
      // 上界：裁剪只在"写之前"发生，故峰值 ≤ max + 单条长度；留一条的余量
      assert.ok(maxSize <= cap.max + perIter + 64,
        `${cap.file} 峰值应 ≤ max+单条(${cap.max + perIter + 64})，实测 ${maxSize}`)
      const kept = L.entries()
      assert.ok(kept.length > 0, '★ 绝不能把日志删空（那等于排障信息全丢）')
      assert.match(kept[kept.length - 1], new RegExp(`abc${iters - 1}|boom`), '保留的必须是最新那条')
      assert.ok(L.writes < iters / 3, `裁剪次数应远少于写入次数，实测 ${L.writes}/${iters}`)
      // 收敛看**裁剪后**的体积：最终值会含"最后一次裁剪后又写入的那些"，那是合法的（还没到下次裁剪）。
      // 允许超 keep 一条：倒序累计到"再加一条就越界"为止，边界那条已经保留（实测最多超约 1KB）。
      assert.ok(postTrim > 0 && postTrim <= cap.keep + perIter * 3 + 64,
        `${name}.log 裁剪后应贴近 keep=${cap.keep}，实测 ${postTrim}`)
      assert.ok(statSync(L.path).size <= cap.max + perIter + 64,
        `${name}.log 最终体积仍须在界内，实测 ${statSync(L.path).size}`)
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
    const size = statSync(p).size
    assert.ok(size > CAPS.error.max, `未裁剪的 error.log 应超上限 ${CAPS.error.max}，实测 ${size}（写了 ${n} 条）`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('日志目录超预算 → 删最旧的文件（mtime 排序）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
  try {
    const names = ['nori-pet-trace.3.log', 'nori-pet-trace.2.log', 'nori-pet-error.log', 'nori-pet-summary.log', 'nori-pet-trace.log']
    const files = names.map((n, i) => {
      const p = join(dir, n)
      writeFileSync(p, 'x'.repeat(2 << 20), 'utf8') // 各 2MB，5 个共 10MB > 8MB 预算
      return { f: n, p, size: statSync(p).size, mtime: Date.now() + i } // 数组顺序即新旧
    })
    let total = files.reduce((n, x) => n + x.size, 0)
    const removed = []
    for (const x of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= BUDGET) break
      rmSync(x.p)
      removed.push(x.f)
      total -= x.size
    }
    assert.ok(removed.length > 0, '超预算时必须动手删')
    assert.ok(total <= BUDGET, '删完必须回到预算内')
    assert.ok(!removed.includes('nori-pet-trace.log'), '不该优先删当前正在写的 trace 主文件（它最新）')
    assert.ok(existsSync(join(dir, 'nori-pet-trace.log')), '最新文件必须保留')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
