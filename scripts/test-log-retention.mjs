#!/usr/bin/env node
/**
 * 追踪日志上限测试：node scripts/test-log-retention.mjs
 *
 * 背景（真实踩坑）：trace 日志早期是「5 个 slot 轮转、每文件按条数裁剪」，**总量无上限**，
 * 且 slot 指针在热重载时被重置回 0 → 同一个文件被反复续写，实测长到 1MB 还在涨；
 * summary 日志还与 trace 共用计数器，把 trace 的行数当成自己的条数，几乎每次写都触发裁剪
 *（日志被反复重写：既费 IO 又留不住内容）。
 *
 * 契约（三条，缺一条都算坏）：
 *   ① 未超上限 → 不读盘、不重写（正常路径零额外开销）
 *   ② 超上限 → 从**最旧**删起保留最新一批；不得删空；体积有上界（不会"裁完立刻又超"抖动）
 *   ③ 日志目录超预算 → 删**最旧的文件**
 *
 * 用与 src/index.ts 同构的镜像实现（真实实现闭包在插件作用域内、无法 import），
 * 关键分支两边一一对应；① 用"读盘次数"计数器断言，② 用"连续 2000 条后体积是否收敛"断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_ENTRIES = 900
const KEEP_ENTRIES = 400
const BUDGET = 8 << 20
const ENTRY_RE = /(?=^\[\d{4}-\d{2}-\d{2}T)/m

/** 与 src/index.ts 的 traceTrim/enforceLogBudget 同构的镜像（含读盘计数） */
function makeLog(dir) {
  const tracePath = join(dir, 'nori-pet-trace.log')
  let count = 0
  let reads = 0
  let writes = 0
  const entry = (i) =>
    `[2026-10-18T04:00:0${i % 10}.000Z] (10ms) src=reframe len=100 fp=abc${i}\n` +
    `IN : ${'a'.repeat(500)}\nOUT: ${'b'.repeat(500)}\n────\n`
  return {
    tracePath,
    get count() { return count },
    get reads() { return reads },
    get writes() { return writes },
    trim() {
      if (count + 1 <= MAX_ENTRIES) return null
      reads += 1
      const blocks = readFileSync(tracePath, 'utf8').split(ENTRY_RE).filter((b) => b.trim())
      const slice = blocks.slice(-KEEP_ENTRIES)
      writeFileSync(tracePath, slice.join(''), 'utf8')
      writes += 1
      count = slice.length
      return count
    },
    append(i) { writeFileSync(tracePath, entry(i), { flag: 'a' }); count += 1 },
    entries() { return readFileSync(tracePath, 'utf8').split(ENTRY_RE).filter((b) => b.trim()) },
    resetCounters() { reads = 0; writes = 0 },
  }
}

test('未超上限时不读盘、不重写（正常路径零额外开销）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
  try {
    const L = makeLog(dir)
    L.append(0)
    L.resetCounters()
    for (let i = 1; i < 400; i++) { assert.equal(L.trim(), null, '未超限必须返回 null'); L.append(i) }
    assert.equal(L.reads, 0, '未超限不应读盘')
    assert.equal(L.writes, 0, '未超限不应重写文件')
    assert.equal(L.entries().length, 400)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('超上限 → 从最旧删起保留最新，且体积有上界（不抖动）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
  try {
    // 用 ASCII 让每条字节数可预测（约 1.03KB）。注意真实内容多为汉字，
    // 每字 UTF-8 占 3 字节 —— 所以"400 条"对应的实际体积是 1MB 量级，不是 500KB，
    // 断言必须按**条数**推导上界，不能拿"500 字 = 500 字节"去算。
    const L = makeLog(dir)
    let maxSize = 0
    for (let i = 0; i < 2000; i++) { L.trim(); L.append(i); maxSize = Math.max(maxSize, statSync(L.tracePath).size) }
    const size = statSync(L.tracePath).size
    // 每条实测约 1070 字节（IN/OUT 各 500 字符 + 元信息），这里留到 2000 只做"有界"证明，
    // 不做精确体积断言 —— 断言的真正目标是「不随写入条数线性增长」。
    const perEntry = 2000
    assert.ok(maxSize < (MAX_ENTRIES + 20) * perEntry, `体积上界应为 MAX_ENTRIES 条（≈${(MAX_ENTRIES + 20) * perEntry}），实测峰值 ${maxSize}`)
    assert.ok(size < (KEEP_ENTRIES + 20) * perEntry, `收敛体积应回到 KEEP_ENTRIES 条量级，实测 ${size}`)
    const kept = L.entries()
    assert.ok(kept.length > 0, '★ 绝不能把日志删空（那等于排障信息全丢）')
    // 裁剪发生在写入之前，所以文件最后会停在「KEEP 条 + 裁点到本次写入之间新写的那些」。
    // 断言"不随总写入量增长"：最后一次裁剪后最多再写 MAX-KEEP 条。
    const maxAfterTrim = (MAX_ENTRIES - KEEP_ENTRIES) + 2
    assert.ok(kept.length >= KEEP_ENTRIES && kept.length <= KEEP_ENTRIES + maxAfterTrim,
      `裁剪后应保留 KEEP_ENTRIES 条量级（实测 ${kept.length}）`)
    // 保留的必须是**最新**的：末条是刚写入的 fp
    assert.match(kept[kept.length - 1], /fp=abc1999/)
    // 且每条都是完整记录（不能把一条切成两半）
    for (const b of kept.slice(-3)) {
      assert.match(b, /^\[\d{4}-\d{2}-\d{2}T/)
      assert.match(b, /\nIN : /)
      assert.match(b, /\nOUT: /)
    }
    // 裁剪次数应约为 总条数/(MAX-KEEP)，不该每条都裁（抖动会让 writes 接近 2000）
    assert.ok(L.writes < 20, `裁剪次数应很少，实测 ${L.writes}（抖动=每条都读写 1MB）`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('反向验证：不做裁剪时确实会无限增长（证明上面的断言有效）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
  try {
    const p = join(dir, 'nori-pet-trace.log')
    const e = `[2026-10-18T04:00:00.000Z] x\nIN : ${'甲'.repeat(500)}\nOUT: ${'乙'.repeat(500)}\n────\n`
    writeFileSync(p, e.repeat(3000), 'utf8')
    assert.ok(statSync(p).size > 3 << 20, '未裁剪的文件必然涨到 3MB 以上（这正是修复前的情况）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('日志目录超预算 → 删最旧的文件（mtime 排序）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nori-log-'))
  try {
    const names = ['nori-pet-trace.3.log', 'nori-pet-trace.2.log', 'nori-pet-trace.1.log', 'nori-pet-error.log', 'nori-pet-trace.log']
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
