#!/usr/bin/env node
/**
 * 发布守卫：commit/CI 前扫描，防止人设文本 / 机器路径 / 密钥 / 资产文件误入仓库。
 *
 * 用法：
 *   node scripts/guard-release.mjs            # 扫全部已跟踪文件（发布前 / CI）
 *   node scripts/guard-release.mjs --staged   # 只扫暂存区（pre-commit 钩子）
 *
 * 设计要点：
 *   - 人设比对采用「本机 persona/prompt.txt 的 64 字 shingle」机制：守卫脚本本身不携带任何授权文本内容，
 *     只有本机放入了 persona/prompt.txt（授权人设文本）时才启用该项检查（缺失则跳过并提示）。
 *     reframe.txt 是随仓库提供的改写任务指令（已入库），不作比对源。
 *   - 机器路径只拦「家目录形态」（Windows 盘位、macOS/Linux 家目录前缀），README / nori.config.example.json
 *     中面向用户的示例盘位路径（如 D:\models\…）不含家目录前缀，不会误报。
 *   - 密钥模式与家目录形态度故意拆字拼接（不在源码中出现连续字面量），避免守卫自身触发扫描。
 *   - 资产文件（模型/语音/图片）只允许占位（.gitkeep 已单独放行），任何真实资产入树即失败。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildHomePath } from './lib/home-path.mjs'

const STAGED = process.argv.includes('--staged')
// 仓库根：git 定位不可用（如受限环境）时回退到当前工作目录
const root = (() => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim() }
  catch { return process.cwd() }
})()

function list(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }
  catch (e) { console.error('guard: git 调用失败 ' + String(e.message)); process.exit(2) }
}

// 文件清单：环境变量 GUARD_FILES 优先（分号/换行分隔），否则走 git（--staged 暂存区 / 全树）
const files = process.env.GUARD_FILES
  ? process.env.GUARD_FILES.split(/[;\n\r]+/).map((s) => s.trim()).filter(Boolean)
  : STAGED
    ? list('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'])
    : list('git', ['ls-files'])

// ── 人设 shingle（本机授权文件 prompt.txt → 64 字窗口集合；守卫源码不含文本内容） ──
const S = 64
function shingles(text, n) {
  const set = new Set()
  if (!text) return set
  if (text.length <= n) { set.add(text); return set }
  for (let i = 0; i + n <= text.length; i++) set.add(text.slice(i, i + n))
  return set
}
let personaShingles = null
const p1 = existsSync(join(root, 'persona', 'prompt.txt')) ? readFileSync(join(root, 'persona', 'prompt.txt'), 'utf8') : ''
// 注意：只以 prompt.txt（授权人设文本）做 shingle 源；reframe.txt 是随仓库提供的改写任务指令
//（自身已入库，不能拿来做比对源——否则扫描到它自己必然命中）。
if (p1) {
  personaShingles = shingles(p1, S)
  console.log('guard: 人设 shingle 比对已启用（' + personaShingles.size + ' 个窗口）')
} else {
  console.log('guard: 本机 persona/prompt.txt 缺失，人设比对跳过（放入授权文件后自动生效）')
}

// ── 规则 ──
const HOME_PATH = buildHomePath()
const KEY_PATTERNS = [
  new RegExp('s' + 'k' + '-[A-Za-z0-9_-]{16,}'),
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----/,
]
const ASSET_EXT = /\.(png|jpe?g|webp|gif|bmp|wav|mp3|m4a|ogg|flac|moc3|motion3\.json|model3\.json|cdf|moc)$/i

const findings = []
function scan(file, label) { findings.push(label + '  ' + file) }

for (const f of files) {
  if (ASSET_EXT.test(f)) { scan(f, '资产文件入树'); continue }
  let text
  try { text = readFileSync(join(root, f), 'utf8') } catch { continue }
  if (HOME_PATH.test(text)) scan(f, '家目录/机器路径')
  for (const re of KEY_PATTERNS) { if (re.test(text)) { scan(f, '疑似密钥'); break } }
  if (personaShingles) {
    for (let i = 0; i + S <= text.length; i++) {
      if (personaShingles.has(text.slice(i, i + S))) { scan(f, '人设文本片段'); break }
    }
  }
}

if (findings.length) {
  console.error('guard: FAIL —— ' + findings.length + ' 项命中，禁止提交/发布：')
  for (const f of findings) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('guard: PASS（' + files.length + ' 个文件 · ' + (STAGED ? '暂存区' : '已跟踪树') + '）')