#!/usr/bin/env node
/**
 * 吞异常审计（可执行规范，不是文档）。
 *
 * 背景：审阅时数出 index.ts 59 处 catch / 36 处静默吞掉 —— 问题不在"吞"本身（socket 写、
 * clearTimeout、可选服务缺失，吞是对的），而在**分不清哪一处是预期内的**，于是没人敢动，
 * 真故障也被静默吞掉。
 *
 * 规范：每个 catch 必须落进下面某一类，宿主（src/**.ts，不含 src/client）不允许 BARE。
 *   LOGGED   块内记了日志（log/appendErr/appendFatal/trace/console.warn|error）
 *   RETHROW  重新抛出（交给上层）
 *   FALLBACK 表达式形式 .catch(() => 兜底值)：兜底值本身就是"明确决定的降级"
 *   REASON   显式写了原因（行内注释 ≥4 字，或块内第一行是注释）
 *   IGNORE   显式 /* ignore *\/ 标记（客户端 DOM/pixi 常用：失败只是少个视觉细节）
 *   BARE     以上都不是 —— 静默吞掉且没有任何交代，**宿主侧禁止**
 *
 * 用法：node scripts/check-swallow.mjs [--all]（--all 连客户端一起列）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src'
const LOG_RE = /\b(log|appendErr|appendFatal|trace|console\.(warn|error|log))\s*\(/

function files(dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (p.endsWith('.ts')) out.push(p.replace(/\\/g, '/'))
  }
  return out
}

/** 取 catch 块体（同行 + 后续，直到花括号配平）；只从 'catch' 之后开始数，避免 try 的 } 抵消 */
function blockOf(L, i) {
  const line = L[i]
  const at = line.indexOf('catch')
  const after = at >= 0 ? line.slice(at) : line
  let depth = (after.match(/\{/g) || []).length - (after.match(/\}/g) || []).length
  let body = after
  let j = i
  while (depth > 0 && j < L.length - 1 && j < i + 15) {
    j += 1
    body += '\n' + L[j]
    depth += (L[j].match(/\{/g) || []).length - (L[j].match(/\}/g) || []).length
  }
  return body
}

function classify(line, body) {
  if (LOG_RE.test(body)) return 'LOGGED'
  if (/\bthrow\b/.test(body)) return 'RETHROW'
  if (/\.catch\s*\(/.test(line)) return 'FALLBACK'
  const inline = line.slice(line.indexOf('catch'))
  const m = inline.match(/\/\*([^*]*)\*\//)
  if (m && m[1].trim().length >= 4) return 'REASON'
  if (/\/\/.{4,}/.test(inline)) return 'REASON' // 行内 // 注释（写在 catch 同一行的原因）
  if (/\/\*\s*ignore\s*\*\//.test(body)) return 'IGNORE'
  const first = body.split('\n').slice(1).map((s) => s.trim()).find(Boolean) ?? ''
  if (first.startsWith('//') && first.length > 4) return 'REASON'
  return 'BARE'
}

const all = process.argv.includes('--all')
const rows = []
for (const f of files(SRC)) {
  const L = readFileSync(f, 'utf8').split(/\r?\n/)
  L.forEach((line, i) => {
    if (!/\bcatch\b/.test(line)) return
    if (/^\s*\*/.test(line)) return // 注释里的 "catch"
    const cls = classify(line, blockOf(L, i))
    rows.push({ f, n: i + 1, cls, text: line.trim().slice(0, 80) })
  })
}

const host = rows.filter((r) => !r.f.startsWith('src/client/'))
const client = rows.filter((r) => r.f.startsWith('src/client/'))
const count = (list) => list.reduce((a, r) => ((a[r.cls] = (a[r.cls] || 0) + 1), a), {})

console.log(`宿主 ${host.length} 处 catch: ${JSON.stringify(count(host))}`)
if (all) console.log(`客户端 ${client.length} 处 catch: ${JSON.stringify(count(client))}`)

const bare = host.filter((r) => r.cls === 'BARE')
if (bare.length) {
  console.log(`\n✖ 宿主侧 BARE（静默吞掉且无交代）：${bare.length} 处`)
  for (const r of bare) console.log(`  ${r.f}:${r.n}  ${r.text}`)
  console.log('\n要求：块内记日志，或行内/块首写一句为什么可以忽略（/* ignore */ 也接受）。')
  process.exit(1)
}
console.log('✔ 宿主侧无 BARE：每处 catch 要么记日志、要么重抛、要么写明原因/兜底')
