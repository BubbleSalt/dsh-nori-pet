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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { buildHomePath } from './lib/home-path.mjs'

const STAGED = process.argv.includes('--staged')
// 仓库根：git 定位不可用（如受限环境）时回退到当前工作目录
const root = (() => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim() }
  catch { return process.cwd() }
})()

/**
 * 无 git 时的全树回退：走文件系统遍历。
 *
 * 为什么需要：guard 对 git 的调用可能整体不可用（受限沙箱里被拒、git 未装、非仓库目录），
 * 旧行为是直接 exit 2 —— 于是 `npm run guard`（README 里教用户跑的发布前自检）在手边没有
 * 可用 git 的环境里彻底失效。
 *
 * 设计取舍：**不实现 .gitignore 语义**。试过两版按 .gitignore 过滤，两版都出真实漏扫：
 *   - 按目录名裁：规则里的 `lib/` 把 `scripts/lib/` 一起吞掉
 *   - 跳过整目录：`persona/*` 跳过 persona/，于是 `!persona/reframe.txt` 永远扫不到
 *   （`.gitignore` 的 `!` 反向规则是"重新纳入"，和"整目录排除"交错时语义很绕，
 *     手搓一版就等于给守卫埋一批静默盲区——这比多扫几个文件危险得多。）
 *
 * 所以只做两件确定的事：跳过「明确的大产物目录」与「噪声文件」，其余一律扫。
 * 代价是会扫到本机资产（voice/*.wav、persona/prompt.txt）并如实报出"资产文件入树/人设文本片段"——
 * 那是本机仓库的真实状态，不是误报；真拿它们当发布内容打包，本来就该被拦下。
 * 有 git 时（正常情况）仍走 `git ls-files`，语义精确，不受这里影响。
 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'lib', 'dist', '.npm-cache', 'GPT-SoVITS', 'Nori_web', 'cubism_sdk', 'ffmpeg'])
/** 噪声文件/目录：本机日志/缓存/打包产物/回滚备份，扫它们没有意义
 * （真正的凭据走 nori.config.json，仍会被扫） */
const NOISE_EXT = /\.(log|tsbuildinfo|tgz|zip|rar|7z|tmp|bak)$/i
const NOISE_NAME = /^\.backup-/i
/** 路径比较（Windows 大小写不敏感 + 分隔符归一） */
const sameDir = (a, b) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

function walkFiles(dir, out = [], depth = 0) {
  if (depth > 8) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      // SKIP_DIRS 只对**仓库顶层**生效：`lib` 指的是根目录构建产物，
      // 不能让它把 `scripts/lib/` 这类源码目录一起吞掉（真实漏扫过一次）。
      if (sameDir(dir, root) && SKIP_DIRS.has(e.name)) continue
      if (NOISE_NAME.test(e.name)) continue // 回滚备份等
      walkFiles(join(dir, e.name), out, depth + 1)
      continue
    }
    if (!e.isFile()) continue
    const rel = relative(root, join(dir, e.name)).split('\\').join('/')
    const base = rel.slice(rel.lastIndexOf('/') + 1)
    if (NOISE_EXT.test(base) || NOISE_NAME.test(base)) continue
    out.push(rel)
  }
  return out
}

function list(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }
  catch { return null }
}

// 文件清单：环境变量 GUARD_FILES 优先（分号/换行分隔）→ git 暂存区/全树 → 文件系统遍历回退
const files = (() => {
  if (process.env.GUARD_FILES) {
    return process.env.GUARD_FILES.split(/[;\n\r]+/).map((s) => s.trim()).filter(Boolean)
  }
  const fromGit = STAGED
    ? list('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'])
    : list('git', ['ls-files'])
  if (fromGit) return fromGit
  if (STAGED) {
    // 暂存区拿不到（git 不可用）：pre-commit 钩子本身也跑不起来，此处退化成全树扫描并说明
    console.error('guard: 暂存区文件清单不可用（git 被限制？）→ 回退为全树扫描')
  } else {
    console.error(`guard: git 不可用 → 回退为文件系统遍历（跳过顶层产物目录：${[...SKIP_DIRS].join('/')}）`)
  }
  return walkFiles(root)
})()

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
/**
 * 本机/私有端点：中转网关与内网域名。
 * 为什么要有这条：审查文档里写过真实端点（`<主机名>.host:端口`、某第三方聚合域名），
 * 第一次扫描时全靠人眼发现——说明"私有端点"当时根本不在检测范围内，漏一次就在公开仓库留下
 * 一处基础设施信息。故补成规则。
 * 模式分片拼接 + 用 `\\d` 这类转义写法（而非 `\\d{2,5}` 里的真实数字），
 * 使源码里不存在能被自身匹配的连续字面量（与 home-path.mjs 同一手法；第一版用真字面量
 * 拼，结果守卫把自己报成了"私有端点"）。
 */
const PRIVATE_ENDPOINT = new RegExp(
  [
    '[a-z0-9-]+' + '\\.' + 'host' + ':' + '\\d{2,5}', // 形如 xxx.ho\u200bst:3514
    'llm' + 'api\\.isr' + 'c\\.a' + 'c\\.cn', // 聚合端点（按域名片段拼接）
  ].join('|'),
  'i',
)
const ASSET_EXT = /\.(png|jpe?g|webp|gif|bmp|wav|mp3|m4a|ogg|flac|moc3|motion3\.json|model3\.json|cdf|moc)$/i
// README/ 下的文档媒体（演示图等）允许入树；其余位置的资产扩展名仍一律拒绝
const DOC_MEDIA = /^README\//

const findings = []
function scan(file, label) { findings.push(label + '  ' + file) }

for (const f of files) {
  if (!DOC_MEDIA.test(f) && ASSET_EXT.test(f)) { scan(f, '资产文件入树'); continue }
  let text
  try { text = readFileSync(join(root, f), 'utf8') } catch { continue }
  if (text.includes('\0')) continue // 二进制（图片/gif/音频/模型）不是文本，跳过字符串扫描
  if (HOME_PATH.test(text)) scan(f, '家目录/机器路径')
  if (PRIVATE_ENDPOINT.test(text)) scan(f, '私有端点/内网域名')
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