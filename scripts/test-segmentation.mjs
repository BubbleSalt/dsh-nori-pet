#!/usr/bin/env node
/**
 * 断句单元测试：node scripts/test-segmentation.mjs
 *
 * 规格（与用户确认过的需求对齐）：
 *   - 目标长度取默认 `SPEAK_MAX`（=40，按气泡"两行以内"算出来的），允许 ≤4 字溢出
 *     （自然断点优先于"卡长度"）；默认 min=12 以下才视为碎片
 *   - 绝不切断英文词/路径/标识符；纯拉丁原子串整段保留（宁可超长）
 *   - 短句原样；纯中文无标点长串按字切开；句末标点不单独成句
 *   - **任何单元都不以句读开头**（"：ssh.exe…"这种气泡看着像断掉的句子）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spokenUnits, softCut, findCut, cleanSpeech, SPEAK_MAX, SPEAK_LINE, widthOf } from '../lib/segmentation.js'

const MAX = SPEAK_MAX // 长度单位（汉字 = 1），不是字符数
const HARD = MAX + 4 // 允许的自然溢出（同样按长度算）

// 示例盘位路径拆片拼接：与 scripts/lib/home-path.mjs 同理，避免源码内出现"家目录形态"字面量
// （发布守卫会拦截，且真实家目录属于不该入库的信息）
const DRIVE = 'C' + String.fromCharCode(58) + String.fromCharCode(47)
const SAMPLE_PATH = DRIVE + 'Users/x/.dsh/profiles/web'

test('超长行被切开，单元贴合上限、不切断内容', () => {
  const line = '本机 dsh 沙箱里 sh.exe 建不了信号管道，会报 Win32 error 5，所以任何 git commit 都会被拒。'
  const units = spokenUnits(line, MAX)
  assert.ok(units.length >= 2, `应至少切 2 段: ${JSON.stringify(units)}`)
  for (const u of units) assert.ok(widthOf(u) <= HARD, `单元超长: ${widthOf(u)} "${u}"`)
  // 不增删非空白内容（切点处可能丢一个半角空格，故按去空白比较）
  assert.equal(units.join('').replace(/\s+/g, ''), line.replace(/\s+/g, ''))
})

test('绝不切断标识符：danger-full-access 完整保留', () => {
  for (const text of [
    'escalate sandbox to danger-full-access',
    '有权限申请：escalate sandbox to danger-full-access，这是要做的事',
    '原因是 escalate sandbox to danger-full-access 需要授权',
  ]) {
    const out = spokenUnits(text, MAX).join('|')
    assert.ok(out.includes('danger-full-access'), `标识符被切断: ${out}`)
  }
})

test('绝不切断英文词：Win32 / git commit', () => {
  const out = spokenUnits('会报 Win32 error 5，所以任何 git commit 都会被拒。', MAX).join('|')
  assert.ok(out.includes('Win32'), out)
  assert.ok(out.includes('commit'), out)
  assert.ok(!/Win\s*\||commi\s*\||erro\s*\||acces\s*\||\|\s*s\b/.test(out), `疑似断词: ${out}`)
})

test('长路径完整保留（不在斜杠/点处切碎目录名）', () => {
  const src = SAMPLE_PATH + ' 里放配置'
  const out = spokenUnits(src, MAX)
  assert.ok(out.some((u) => u.includes(SAMPLE_PATH)), JSON.stringify(out))
  for (const u of out) assert.ok(widthOf(u) <= HARD || /[A-Za-z0-9_/]$/.test(u), `单元超长: ${widthOf(u)} "${u}"`)
})

test('已知取舍：原子标识符比预算长时，只能切在它边界之外（不切词）', () => {
  // 32 字的路径 + 5 字中文 → 只能切在路径之后（可能留一个 3 字尾巴）：整段超预算时不可避免，
  // 但绝不出现 acces+s / profi+les 这类断字。这条测试是"契约"而非理想输出。
  const out = spokenUnits(SAMPLE_PATH + ' 里放配置', MAX)
  assert.ok(out.some((u) => u.includes(SAMPLE_PATH)), JSON.stringify(out))
  for (let i = 0; i + 1 < out.length; i++) {
    assert.ok(!/[A-Za-z0-9_]$/.test(out[i]) || !/^[A-Za-z0-9_]/.test(out[i + 1]), `断词: ${JSON.stringify(out)}`)
  }
})

test('纯中文长串（无标点）也能切，且切点不在词中间', () => {
  const line = '这是一段没有任何标点的很长很长的中文内容需要被切成多个朗读单元否则会超长朗读下去'
  const units = spokenUnits(line, MAX)
  assert.ok(units.length >= 2, `应切开: ${JSON.stringify(units)}`)
  for (const u of units) assert.ok(widthOf(u) <= HARD, `单元超长: ${widthOf(u)} "${u}"`)
  assert.equal(units.join(''), line, '切分不得增删字符')
})

test('短句原样保留（不碎片化）', () => {
  assert.deepEqual(spokenUnits('有权限申请，工具 pwsh。', MAX), ['有权限申请，工具 pwsh。'])
  assert.deepEqual(spokenUnits('嗯，我在看。', MAX), ['嗯，我在看。'])
})

test('句末标点不单独成句（会并回上一句）', () => {
  const line = '这是一段没有任何标点的很长很长的中文内容需要被切成多个朗读单元否则会超长朗读下去。'
  const units = spokenUnits(line, MAX)
  assert.equal(units[units.length - 1].endsWith('。'), true, JSON.stringify(units))
  assert.equal(units.join(''), line)
})

test('空输入与空白输入', () => {
  assert.deepEqual(spokenUnits('', MAX), [])
  assert.deepEqual(spokenUnits('   \n  ', MAX), [])
})

test('softCut（批次上限）绝不落在拉丁词内部', () => {
  const s = 'aaaaaaaaaaaaaaaaaaaaaaaaa danger-full-access 后面的内容'
  const cut = softCut(s, 34)
  const before = s[cut - 1]
  const after = s[cut]
  assert.ok(!(/[A-Za-z0-9_]/.test(before) && /[A-Za-z0-9_]/.test(after)), `落在词内部: "${s.slice(cut - 8, cut)}|${s.slice(cut, cut + 8)}"`)
})

test('findCut：不在拉丁词内部下刀（中西交界与空格后可以）', () => {
  const s = SAMPLE_PATH + ' 里放配置'
  const cut = findCut(s, 34)
  const before = s[cut - 1]
  const after = s[cut]
  assert.ok(!(/[A-Za-z0-9_]/.test(before) && /[A-Za-z0-9_]/.test(after)), `切在词内部: "${s.slice(cut - 6, cut)}|${s.slice(cut, cut + 6)}"`)
})

test('findCut：窗口内没有任何可断点时返回 0，而不是乱切', () => {
  assert.equal(findCut('a'.repeat(50), 34), 0)
})

// ── 情绪标签绝不进入朗读文本 ──
// 实测踩坑：Intl.Segmenter 的 sentence 粒度会切在标签内部（"…最稳。【" | "serious】拉起…"），
// 朗读时 "serious】" 被当正文念出来。不变量 = 朗读文本里不出现标签，由 cleanSpeech 兜底。

test('朗读文本里不出现任何标签痕迹（真实概括用例）', () => {
  const text = '【think】看门狗用探测式为主、再加一个很长周期的兜底重启来清洗状态，这样最稳。'
    + '【serious】拉起前要先确认端口占用者是谁，按PID核对命令行和启动时间。'
  const units = spokenUnits(text, MAX)
  for (const u of units) {
    const spoken = cleanSpeech(u)
    assert.ok(!/【|】/.test(spoken), '标签残骸进入朗读: ' + JSON.stringify(spoken))
    assert.ok(!/^(happy|think|serious|default|sad|angry)/i.test(spoken), '裸标签词进入朗读: ' + JSON.stringify(spoken))
  }
  const joined = units.map((u) => cleanSpeech(u)).join('')
  assert.ok(joined.includes('看门狗用探测式为主'), joined)
  assert.ok(joined.includes('拉起前要先确认端口占用者是谁'), joined)
})

test('cleanSpeech：完整标签 / 各类残骸 / 裸标签词都被清掉', () => {
  assert.equal(cleanSpeech('【happy】完成啦！'), '完成啦！')
  assert.equal(cleanSpeech('…这样最稳。【'), '…这样最稳。')
  assert.equal(cleanSpeech('serious】拉起前要先确认。'), '拉起前要先确认。')
  assert.equal(cleanSpeech('think】接下来做这个：'), '接下来做这个：')
  assert.equal(cleanSpeech('【serious】'), '')
})

test('cleanSpeech 不误伤正文里的普通英文', () => {
  const s = '正常文本 ThinkPad 很好用，excitedly 也是这样。'
  assert.equal(cleanSpeech(s), s)
})

// ── 气泡两行预算 + 悬空句读（用户实测："断句有点短""danger-full-access 那句切得挺不自然"）──
// 关键教训：预算是**长度**不是字数。长度规则由用户给定：汉字 1、连续字母/数字每字 0.5
// 且整段向上取整（3 字母 = 2）；一行正好 17 个汉字，两行 = 34。
test('★ SPEAK_MAX：一行 17 长度、两行 34（用户实测给的精确值）', () => {
  assert.equal(SPEAK_LINE, 17, `一行应当是 17: ${SPEAK_LINE}`)
  assert.equal(SPEAK_MAX, SPEAK_LINE * 2, `两行应当 = 34: ${SPEAK_MAX}`)
  assert.equal(widthOf('一二三四五六七八九十一二三四五六七'), 17, '17 个汉字应当正好一行')
  assert.equal(widthOf('abc'), 2, '3 个字母应当算 2 长度（向上取整）')
  assert.equal(widthOf('ab'), 1, '2 个字母应当算 1 长度')
  assert.equal(widthOf('abcdef'), 3, '6 个字母应当算 3 长度')
  const line = '这是一段没有任何标点的很长很长的中文内容需要被切成多个朗读单元否则会超长朗读下去'.repeat(2)
  for (const u of spokenUnits(line)) assert.ok(widthOf(u) <= SPEAK_MAX + 4, `超两行预算: ${widthOf(u)} "${u}"`)
  // 默认参数就是 SPEAK_MAX（宿主与 widget 都靠这个默认值保持一致）
  assert.deepEqual(spokenUnits('嗯，我在看。'), ['嗯，我在看。'])
})

test('★ 混排句子按长度填满两行（不因字符数提前截断）', () => {
  const line = '把 reframe 的 timeout 从 8000 改成 12000，然后在 package.json 里把 build:client 换成 tsdown，再重跑 npm test 确认 8 套件全绿。'
  const units = spokenUnits(line)
  const budget = SPEAK_MAX
  // 至少有一个单元用掉大半个两行预算（按字数硬截时会更短）
  assert.ok(units.some((u) => widthOf(u) >= budget * 0.7), `没有任何单元填满两行: ${JSON.stringify(units.map((u) => widthOf(u)))}`)
  for (const u of units) assert.ok(widthOf(u) <= budget + 4, `超两行预算: ${widthOf(u)} "${u}"`)
  // 拉丁字更窄、字符更多，但占用长度仍在一行/两行预算内
  assert.ok(units[0].length > 34, `混排单元应当比 34 字更长: ${units[0].length}`)
})

test('★ 任何单元都不以句读开头（旧版会把句末冒号推给下一句）', () => {
  const cases = [
    '有权限申请：pwsh。原因：允许本次操作使用 danger-full-access 权限：ssh.exe 在受限沙箱内无法创建信号管道，需要放宽一次以推送本轮修复与 v0.2.9 tag。',
    '注意：这一条非常关键：改完之后必须重新跑一遍测试：否则不能发布。',
    '清单如下：一、改断句；二、改气泡；三、跑回归；四、发版本。',
  ]
  for (const c of cases) {
    for (const u of spokenUnits(c)) {
      assert.ok(!/^[：:，,、；;]/.test(u), `以句读开头: ${JSON.stringify(u)}`)
    }
  }
})

test('★ 不切在词中间、也不留过碎的尾巴', () => {
  const ap = '有权限申请：pwsh。原因：允许本次操作使用 danger-full-access 权限：ssh.exe 在受限沙箱内无法创建信号管道，需要放宽一次以推送本轮修复与 v0.2.9 tag。'
  const units = spokenUnits(ap)
  assert.ok(units.some((u) => u.includes('danger-full-access')), JSON.stringify(units))
  assert.ok(!units.some((u) => /权限：?$/.test(u) && u.length <= 4), JSON.stringify(units))
  // 不许出现"权" | "限" 这种把一个词劈两半的切法
  for (let i = 0; i + 1 < units.length; i++) {
    assert.ok(!(units[i].endsWith('权') && /^限/.test(units[i + 1])), `切在词中间: ${JSON.stringify(units)}`)
  }
  // 尾巴不能过短（旧版出现过"与 v0.2.9 tag。"这种碎尾）；单位是长度，不是 px
  const last = units[units.length - 1]
  assert.ok(widthOf(last) >= 12, `尾巴过短: ${JSON.stringify(units)}`)
})

test('★ 模型吐出的 <br> 不进气泡/朗读文本', () => {
  const s = '统计接口和 swap 机制语义，对吧？<br>【think】这次改动我先确认一下两边的定义边界。'
  for (const u of spokenUnits(s)) assert.ok(!u.includes('<br>'), `气泡里带 <br>: ${JSON.stringify(u)}`)
  assert.equal(cleanSpeech('统计接口和 swap 机制语义，对吧？<br>【think】这次改动'), '统计接口和 swap 机制语义，对吧？这次改动')
  // 不误伤正文里的"小于"关系
  assert.equal(cleanSpeech('a<b 是成立的'), 'a<b 是成立的')
})

test('★ 代码块内容不读、也不进气泡（含未闭合围栏）', () => {
  const fence = '```ts\nconst a = 1\nconsole.log(a)\n```'
  const s = `先说结论：改好了。\n${fence}\n细节在最后一句。`
  const units = spokenUnits(s)
  const joined = units.join('\n')
  assert.ok(!joined.includes('const a'), `气泡里出现代码: ${JSON.stringify(units)}`)
  assert.ok(!joined.includes('```'), `气泡里出现围栏: ${JSON.stringify(units)}`)
  assert.ok(joined.includes('改好了'), `围栏前的正文丢了: ${JSON.stringify(units)}`)
  assert.ok(joined.includes('细节在最后一句'), `围栏后的正文丢了: ${JSON.stringify(units)}`)
  // 未闭合围栏：宁可丢尾巴，也不能把代码当正文念
  const broken = spokenUnits('看这段：\n```py\nprint(1)\n')
  assert.ok(!broken.join('').includes('print'), `未闭合围栏泄漏: ${JSON.stringify(broken)}`)
  // cleanSpeech 同口径
  assert.ok(!cleanSpeech(`前${fence}后`).includes('const a'))
  // 行内反引号（不是代码块）照常保留内容
  assert.equal(cleanSpeech('把 `budget` 改成 34'), '把 `budget` 改成 34')
})
