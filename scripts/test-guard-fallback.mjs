#!/usr/bin/env node
/**
 * 回归测试：发布守卫在「git 不可用」时退化为文件系统遍历，遍历必须
 *   ① 不跳过任何会被提交的文件（漏扫 = 守卫出现盲区，且不会报错，只会静默少扫）
 *   ② 不把 .gitignore 排除的大目录/产物扫进来（假 FAIL 会让用户以为守卫坏了）
 *
 * 为什么值得单独测：这里连踩三次坑，全是"看起来对、实际漏/错"：
 *   - 按名字裁目录：`lib/` 规则把 `scripts/lib/` 一起吞掉 → 源码漏扫
 *   - 跳过 .gitignore 的整目录：`persona/*` 跳过 persona/ → `!persona/reframe.txt` 永远扫不到
 *   - 不认 `!` 放行：`.gitkeep`、`reframe.txt` 这类显式放行的文件被当忽略处理
 *
 * 测法：造一棵假仓库（.gitignore 照抄本仓库形态），往三个"易漏点"里植入可检测的
 * 家目录路径违规，然后在假仓库里端到端跑 guard——
 * 能命中 = 说明这些文件确实被扫到了；扫到产物目录 = 输出里会出现不该有的文件名。
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

/** 以写模式打开文件并返回 fd（子进程 stdio 重定向用） */
function fdOf(p) { return openSync(p, 'w') }

const GUARD = join(process.cwd(), 'scripts/guard-release.mjs')
// 家目录形态的违规内容。刻意用拼接构造，不在本文件里留下连续字面量
// —— 否则这个测试文件自身会被守卫报「家目录/机器路径」（真踩过）。
const LEAK = `const p = '${['C:', 'Users', 'someone', 'x'].join('\\')}'`
let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? '\n      ' + extra : ''}`) }
}

const root = mkdtempSync(join(tmpdir(), 'nori-guard-'))
try {
  const put = (rel, content = 'clean\n') => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  writeFileSync(join(root, '.gitignore'), [
    '# 团队资产原件',
    'persona/*',
    '!.gitkeep',
    '!persona/reframe.txt',
    'voice/*',
    'GPT-SoVITS/*',
    '*.log',
    'nori.config.json',
    '.backup-*/',
    'node_modules/',
    'lib/',
    'dist/',
    '*.tgz',
    '',
  ].join('\n'))

  // 三个"易漏点"：都植入家目录路径，能命中才算被扫到
  put('persona/reframe.txt', LEAK)        // 整目录排除 + ! 放行
  put('scripts/lib/home-path.mjs', LEAK)  // 顶层 lib/ 规则不得吞掉 scripts/lib/
  put('README.md', LEAK)                  // 常规文件作对照
  // 干净文件（不该出现在报告里，但必须在扫描清单内；用命名冲突验证不被误跳）
  put('src/index.ts'); put('package.json'); put('scripts/guard-release.mjs'); put('persona/.gitkeep', '')
  // 本机/产物：不该被扫
  put('lib/index.js', LEAK); put('node_modules/x/i.js', LEAK); put('dist/old.tgz', LEAK)
  put('.backup-2026/x.ts', LEAK); put('nori-pet-error.log', LEAK); put('voice/nori.wav', LEAK)

  // 注意：guard 在仓库根用 ./lib/home-path.mjs。而根目录 lib/ 正是我们要验证"被跳过"的产物目录，
  // 若把探测模块放进去，它就查不到授权人设了。故改放到 scripts/ 下，并把 import 路径改过去。
  const guardSrc = readFileSync(GUARD, 'utf8').replace("'./lib/home-path.mjs'", "'./scripts/home-path.mjs'")
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'guard.mjs'), guardSrc)
  writeFileSync(join(root, 'scripts/home-path.mjs'),
    readFileSync(join(process.cwd(), 'scripts/lib/home-path.mjs'), 'utf8'))
  const out = (() => {
    // 不能靠 stdio:'pipe' 捕获：受限沙箱下 node 无法打开命名管道（EPERM），会静默拿到空输出。
    // 也不能只重定向 fd 1/2 —— 提示性日志走 stderr，得让 shell 自己把 2>&1 一起落到文件里。
    const logFile = join(root, 'guard-out.txt')
    try {
      execFileSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, 'guard.mjs'))} > ${JSON.stringify(logFile)} 2>&1`,
        { cwd: root, env: { ...process.env, GUARD_FILES: '' }, shell: true, stdio: 'ignore' })
    } catch { /* 非 0 退出即命中违规，输出已在文件里 */ }
    return existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  })()
  if (process.env.NORI_DEBUG_GUARD) console.log('--- guard 输出 ---\n' + out + '--- 结束 ---')

  // 只取"命中清单"部分做断言：诊断行本身会列出跳过目录（含 node_modules 字样），
  // 若拿整段输出做 includes 断言，就会被自己的提示语骗过（假通过）。
  const findings = out.split(/禁止提交\/发布|FAIL/).pop() ?? ''
  if (process.env.NORI_DEBUG_GUARD) console.log('--- 命中清单 ---\n' + findings + '--- 结束 ---')

  ok(/回退为文件系统遍历/.test(out), 'git 不可用时回退为遍历（不再直接失效）')
  ok(/persona[\\/]reframe\.txt/.test(findings), 'persona/reframe.txt 被扫到（! 放行规则生效）', findings)
  ok(/scripts[\\/]lib[\\/]home-path\.mjs/.test(findings), 'scripts/lib/ 被扫到（未被顶层 lib/ 规则吞掉）', findings)
  ok(/README\.md/.test(findings), 'README.md 被扫到（常规路径有效，避免整测失效）', findings)
  ok(!/node_modules/.test(findings), 'node_modules 未进扫描清单', findings)
  ok(!/(^|[^-])dist[\\/]old\.tgz/.test(findings), 'dist/ 未进扫描清单', findings)
  ok(!/lib[\\/]index\.js/.test(findings), '顶层 lib/ 产物未进扫描清单', findings)
  ok(!/\.backup-2026/.test(findings), '.backup-* 未进扫描清单', findings)
  ok(!/nori-pet-error\.log/.test(findings), '*.log 未进扫描清单', findings)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅' : '❌'} guard fallback: pass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
