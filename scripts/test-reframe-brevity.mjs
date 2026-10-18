#!/usr/bin/env node
/**
 * 改写层"注水"回归：短材料是否被撑成大长句。
 *
 * 背景（实测）：reframe 原规则写"内容少时 2~4 句"+"尽量把所有要点都说上"，两条一起把模型
 * 推向了注水——材料只有一条信息时，它只能靠"报进度 / 反问用户 / 感叹 / 重复动作"去够句数。
 * 真实 trace 证据：`中文测试OK`（6 字）→ 3 句；`CACHED`（6 字）→ 3 句。
 *
 * 本脚本用真实改写链路（同模型、同 temperature、同 persona）跑一批**短材料**，
 * 量三件事并做判定：
 *   句数      —— 短材料应当 1~2 句
 *   膨胀率    —— 输出字数 / 材料字数，短材料不该超过 ~2.0
 *   注水句    —— 明显与材料无关的"报进度/反问/安慰"句
 *
 * 用法：
 *   node scripts/test-reframe-brevity.mjs                     # 用当前 persona/reframe.txt
 *   node scripts/test-reframe-brevity.mjs --old .old-reframe.txt   # A/B：与旧版逐条对照
 *   node scripts/test-reframe-brevity.mjs --filter 中文测试        # 只跑匹配的用例
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const argv = process.argv.slice(2)
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : '' }
const OLD_FILE = argOf('--old')
const FILTER = argOf('--filter')

const cfg = JSON.parse(readFileSync(join(ROOT, 'nori.config.json'), 'utf8'))
const rf = cfg.reframe ?? {}
if (!rf.apiKey || !rf.reframeBaseUrl || !rf.reframeModel) {
  console.error('缺少 reframe 配置（apiKey / reframeBaseUrl / reframeModel）')
  process.exit(2)
}

const personaPrompt = readFileSync(join(ROOT, 'persona', 'prompt.txt'), 'utf8')
const reframeNew = readFileSync(join(ROOT, 'persona', 'reframe.txt'), 'utf8')
const reframeOld = OLD_FILE ? readFileSync(join(ROOT, OLD_FILE), 'utf8') : null

/** 短材料用例：全部取自真实 trace（"一句话的材料"） */
const SHORT_CASES = [
  '中文测试OK',
  'CACHED',
  '测试通过。',
  '下一步：改 prompt 的长度规则',
  '现在把文件转成带 BOM 的 UTF-8，顺便跑一下语法检查。',
  '两个 shell 都能解析通过。',
  '我先把改写层真正的指令文件打开看看。',
  '端口是 9880，服务还活着。',
  '让我检查一下 6.1 缺失的第二个防护。',
]

/**
 * 长材料用例：**反向回归**——收紧句数规则后，多要点材料不能被过度压缩丢信息。
 * 判据是"覆盖"：材料里的关键点应当出现在输出里。每个 key 是一组**等价写法**（任一命中即算覆盖）——
 * 模型有改写自由，把 `PS 5.1` 讲成 `PowerShell 5.1` 是正确行为，不该被判成丢要点。
 */
const LONG_CASES = [
  {
    text: '测试1通过（token→cookie→缓存，30 天过期）。PS 5.1 又撞到第二个问题：WebRequestSession 类型没有加载进来。让我先修这个，再重跑两个 shell 的语法检查。',
    keys: [['cookie', '缓存'], ['30'], ['PS', 'PowerShell'], ['WebRequestSession']],
  },
  {
    text: '断句改成按标点切分后，长句的停顿位置正常了；但英文词被截断的问题还在，英文前面要补逗号强制分片。另外超长内容现在走整轮概括，不再逐句念。',
    keys: [['标点'], ['英文'], ['逗号', '分片'], ['概括']],
  },
]

const argv2 = argv
const FILTER2 = argOf('--filter')
const CASES = FILTER2
  ? SHORT_CASES.filter((c) => c.includes(FILTER2))
  : (argv2.includes('--long') ? LONG_CASES.map((c) => c.text) : SHORT_CASES)

/** 注水句特征：报流程 / 反问用户 / 安慰 / 纯情绪铺垫（没有材料里的新信息） */
const WATER = [
  /等(我|Nori)?(查|测|看|弄)完.*(告诉|说)/, /(正在|还在)(盯着|处理|看|弄)/,
  /你(是不是|是)(想说什么|在检查|不小心)/, /再跟Nori(讲|说)一遍/, /别担心|放心*/,
  /接下来.*(会)?继续/, /先等一会儿|稍等/,
]

const stats = (text, src) => {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean)
  const content = lines.map((l) => l.replace(/^【[^】]*】/, ''))
  const chars = content.join('').replace(/\s/g, '').length
  const srcChars = src.replace(/\s/g, '').length
  return {
    n: lines.length,
    chars,
    ratio: srcChars ? chars / srcChars : 0,
    water: content.filter((c) => WATER.some((re) => re.test(c))).length,
  }
}

async function reframe(system, text) {
  const res = await fetch(rf.reframeBaseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + rf.apiKey },
    body: JSON.stringify({
      model: rf.reframeModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
      temperature: 0.8,
      max_tokens: rf.reframeMaxTokens ?? 4096,
    }),
    signal: AbortSignal.timeout(rf.reframeTimeoutMs ?? 60000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120))
  const j = await res.json()
  return String(j?.choices?.[0]?.message?.content ?? '').trim()
}

const variants = [['新', personaPrompt + '\n\n' + reframeNew]]
if (reframeOld) variants.push(['旧', personaPrompt + '\n\n' + reframeOld])

const cases = FILTER ? CASES.filter((c) => c.includes(FILTER)) : CASES
const rows = []
let fail = 0

console.log(`模型: ${rf.reframeModel}   用例: ${cases.length}   变体: ${variants.map((v) => v[0]).join(' / ')}`)
console.log('='.repeat(100))

for (const src of cases) {
  const out = {}
  for (const [tag, system] of variants) {
    try { out[tag] = await reframe(system, src) } catch (e) { out[tag] = '★ 失败: ' + String(e?.message ?? e) }
  }
  const s = {}
  for (const [tag] of variants) s[tag] = stats(out[tag], src)
  const cur = s['新']
  /**
   * 判定分两类，判据不同：
   *  · 短材料（<20 字）：句数是硬指标——一句自然中文本身就有 15~25 字，
   *    拿"膨胀 ≤2.0×"去卡 6 字材料是错的（永远不可能达标），所以只卡句数 ≤2 与注水句。
   *  · 较长材料（≥20 字）：句数、膨胀、注水三项都卡。
   */
  const srcLen = src.replace(/\s/g, '').length
  const short = srcLen < 20
  const bad = cur.n > (short ? 2 : Math.max(3, Math.ceil(srcLen / 12)))
    || (!short && cur.ratio > 2.0)
    || cur.water > 0
  if (bad) fail++
  console.log(`\n${bad ? '★' : '✅'} 材料(${src.replace(/\s/g, '').length}字): ${src}`)
  for (const [tag] of variants) {
    const st = s[tag]
    console.log(`   [${tag}] ${st.n}句 ${st.chars}字 膨胀${st.ratio.toFixed(2)}× 注水${st.water}句`)
    for (const l of out[tag].split('\n').filter(Boolean)) console.log(`        ${l}`)
  }
  rows.push({ src, ...Object.fromEntries(variants.map(([t]) => [t, s[t]])), text: out })
}

console.log('\n' + '='.repeat(100))
const avg = (k, tag) => (rows.reduce((a, r) => a + r[tag][k], 0) / rows.length).toFixed(2)
for (const [tag] of variants) {
  console.log(`  [${tag}] 平均句数 ${avg('n', tag)}   平均膨胀 ${avg('ratio', tag)}×   注水句合计 ${rows.reduce((a, r) => a + r[tag].water, 0)}`)
}

// 长材料走覆盖判据（反向回归：规则收紧后要点不能被压掉）
if (argv.includes('--long')) {
  console.log('\n长材料覆盖检查（关键 token 是否还在输出里）：')
  let miss = 0
  for (const [i, src] of CASES.entries()) {
    const keys = LONG_CASES[i].keys
    const text = rows[i].text['新']
    const gone = keys.filter((alts) => !alts.some((k) => text.includes(k)))
    if (gone.length) miss++
    const covered = keys.length - gone.length
    console.log(`  ${gone.length ? '★' : '✅'} ${src.slice(0, 26)}…  覆盖 ${covered}/${keys.length}${gone.length ? '  丢失: ' + gone.map((a) => a[0]).join('/') : ''}`)
  }
  console.log(`\n判定（长材料）：${miss === 0 ? 'PASS — 要点无丢失' : `FAIL — ${miss} 条丢要点`}`)
  process.exit(miss === 0 ? 0 : 1)
}

console.log(`\n判定（短材料）：${fail === 0 ? 'PASS — 全部 ≤2 句、无注水句（膨胀上限只对 ≥20 字材料生效）' : `FAIL — ${fail}/${cases.length} 条不合格`}`)
process.exit(fail === 0 ? 0 : 1)
