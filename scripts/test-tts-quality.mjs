#!/usr/bin/env node
/**
 * 声音引擎质量回归：金句集 → 合成 → **转写回汉字** → 指标。
 *
 * 用法（在 dsh-nori-pet 目录）：
 *   node scripts/test-tts-quality.mjs              # 全部用例：合成 + 波形指标 + 落盘
 *   node scripts/test-tts-quality.mjs --filter URL # 只跑名字含 URL 的用例
 *
 * 关于 ASR 比对（判定"念出来的到底是不是这句话"）：
 *   本沙箱禁止子进程管道，Node 侧无法捕获 ASR 输出 → 分两趟走，用**文件**交换：
 *     1) node scripts/test-tts-quality.mjs                    # 合成 + 落盘 + 写 cases.json
 *     2) <venv>/python audio/asr_batch.py scripts/.tts-quality \
 *          scripts/.tts-quality/cases.json scripts/.tts-quality/asr.json
 *     3) node scripts/test-tts-quality.mjs --asr-json scripts/.tts-quality/asr.json   # 出 sim 指标
 *   没有 ASR 时有波形指标 + 可试听文件，仍能发现"语速异常/拖长"两类问题。
 *
 * 指标（每条用例）：
 *   chars  — 送进 TTS 的汉/英/数字字符数（语速分母）
 *   cps    — 字符/秒。正常中文约 4~8；**显著偏低 = 把标点/符号当音节念出来了**
 *   maxRun — 最长连续有声段(s)，>3.5 判拖长吞句
 *   sim    — 转写文本与原文的相似度（0~1）；<0.6 基本可判"念出来的不是这句话"
 *   extra  — 转写里多出来的内容（原文没有的"嗯/啊/字幕"等即幻觉）
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '.tts-quality')
mkdirSync(OUT, { recursive: true })

const args = process.argv.slice(2)
const opt = { filter: '', asrJson: process.env.NORI_ASR_JSON || '', ref: '', prompt: '', url: 'http://127.0.0.1:9880/tts', onlyAsr: false }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--filter') opt.filter = args[++i]
  else if (a === '--asr-json') { opt.asrJson = args[++i]; opt.onlyAsr = true }
  else if (a === '--ref') opt.ref = args[++i]
  else if (a === '--prompt') opt.prompt = args[++i]
  else if (a === '--url') opt.url = args[++i]
}

// 用户实际配置（nori.config.json）优先，避免脚本与面板参数不一致
try {
  const cfg = JSON.parse(readFileSync(join(HERE, '..', 'nori.config.json'), 'utf8'))
  if (!opt.ref && cfg.refAudio) opt.ref = cfg.refAudio
  if (!opt.prompt && cfg.refPrompt) opt.prompt = cfg.refPrompt
} catch { /* 无配置则用 --ref/--prompt */ }

/** 金句集：每条 = 面板真实会送进 TTS 的文本形态（含未清理的符号） */
const CASES = [
  { name: '正常中文', text: '今天天气不错，我们出去走走吧。', want: '纯中文基线' },
  { name: 'Markdown粗体', text: '**重点**：这里有颗星号。', want: '星号不该被念' },
  { name: 'Markdown列表', text: '1. 列表项一，2. 列表项二。', want: '序号不该念成数字串' },
  { name: 'Markdown标题', text: '# 标题：看这里。', want: '井号不该被念' },
  { name: 'URL', text: '详见 https://github.com/BubbleSalt/dsh-nori-pet 这个地址。', want: 'URL 应被替换/跳过而非逐字符念' },
  { name: 'Windows路径', text: '路径是 D:/models/nori/voice.wav 这里。', want: '路径不该逐字符念' },
  { name: '反引号命令', text: '执行 npm run build 就行了。', want: '英文命令读音可接受' },
  { name: '代码符号', text: '用 a|b 和 c=>d 还有 e==f 表示。', want: '符号不该被念' },
  { name: '箭头与数学符', text: '结果 → 成功，概率 ≥ 90%。', want: '→ ≥ 不该被念' },
  { name: '小数点数字', text: '温度是 0.9，上限 3.5 秒。', want: '小数不该被切碎' },
  { name: '长数字串', text: '端口是 9880，版本 0.2.4。', want: '数字读法可接受' },
  { name: '括号引用', text: '他说（原话）「这样最稳」。', want: '括号不该被念' },
  { name: '波浪引号', text: '大概 3~5 分钟吧~', want: '波浪号不该被念' },
  { name: '全角符号混排', text: '※注意：这里有【强调】与《书名》。', want: '※ 不该被念' },
  { name: '英文混排', text: '我把文件放到 GitHub 上面了。', want: '英文词读音可接受' },
  { name: 'emoji', text: '今天很开心 😊 真的！', want: 'emoji 不该被念成怪音' },
  { name: '感叹词叠字', text: '嗯……唔……那个……', want: 'AR 在鼻音上易循环拖长' },
  { name: '超长单句', text: '这是一段没有任何标点的很长很长的句子用来测试模型在长上下文下的注意力是否漂移从而产生念错内容的现象请你仔细听清楚每一个字是否都正确', want: '长句易漂移' },
]

function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
  let off = 12
  let sr = 24000, ch = 1, bits = 16, dataOff = -1, dataLen = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') { ch = Math.max(1, buf.readUInt16LE(off + 10)); sr = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22) }
    else if (id === 'data') { dataOff = off + 8; dataLen = Math.min(size, buf.length - dataOff); break }
    off += 8 + size + (size % 2)
  }
  if (dataOff < 0 || !dataLen) return null
  return { sr, ch, bits, dataOff, dataLen, dur: dataLen / (sr * ch * (bits / 8)) }
}

function maxRunSec(buf, w) {
  const bytesPer = w.bits / 8
  const per = Math.max(1, Math.floor(w.sr * 0.1))
  const stride = per * bytesPer * w.ch
  const n = Math.floor(w.dataLen / stride)
  let best = 0, cur = 0
  for (let f = 0; f < n; f++) {
    let sum = 0
    const base = w.dataOff + f * stride
    for (let i = 0; i < per; i++) {
      const p = base + i * bytesPer * w.ch
      const v = w.bits === 16 ? buf.readInt16LE(p) / 32768 : (buf.readUInt8(p) - 128) / 128
      sum += v * v
    }
    if (Math.sqrt(sum / per) >= 0.06) { cur++; best = Math.max(best, cur) } else cur = 0
  }
  return best / 10
}

/** 字符集相似度：编辑距离（转写 vs 原文），只保留汉/英/数字 */
function normChars(s) {
  return [...String(s).replace(/[\s，。、！？；：""''（）「」《》…—~～,.!?;:"'()]/g, '')].filter((c) => /[\u4e00-\u9fffA-Za-z0-9]/.test(c))
}
function editDistance(a, b) {
  const m = a.length, n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}
function similarity(a, b) {
  const A = normChars(a), B = normChars(b)
  if (!A.length && !B.length) return 1
  return 1 - editDistance(A, B) / Math.max(A.length, B.length, 1)
}

// ASR 结果（第二趟产物）：name → 转写文本
let asrMap = new Map()
if (opt.asrJson) {
  try {
    for (const r of JSON.parse(readFileSync(opt.asrJson, 'utf8'))) asrMap.set(r.name, r.got || '')
    console.log(`ASR 结果: ${opt.asrJson}（${asrMap.size} 条）`)
  } catch (e) {
    console.log(`★ 读不到 ASR 结果 ${opt.asrJson}: ${String(e?.message ?? e)}`)
  }
}
// 第一趟先把"用例清单"写给 Python（两边靠文件交换，见文件头说明）
const casesFile = join(OUT, 'cases.json')
if (!opt.onlyAsr) writeFileSync(casesFile, JSON.stringify(CASES.map((c) => ({ name: c.name, text: c.text })), null, 1), 'utf8')

const rows = []
console.log(`参考音频: ${opt.ref || '(服务端默认)'}`)
if (!opt.onlyAsr) console.log(`用例清单: ${casesFile}`)
console.log('')

for (const c of CASES) {
  if (opt.filter && !c.name.includes(opt.filter)) continue

  let w = null
  let maxRun = 0
  let bufLen = 0
  let ms = 0
  if (!opt.onlyAsr) {
    const body = {
      text: c.text, text_lang: 'zh', prompt_lang: 'zh', media_type: 'wav',
      temperature: 0.9, top_k: 12, speed_factor: 1.0,
      ...(opt.ref ? { ref_audio_path: opt.ref } : {}),
      ...(opt.prompt ? { prompt_text: opt.prompt } : {}),
    }
    const t0 = Date.now()
    let res
    try {
      res = await fetch(opt.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) })
    } catch (e) {
      console.log(`★ ${c.name}: 请求失败 ${String(e?.message ?? e)}`)
      rows.push({ name: c.name, fail: true })
      continue
    }
    ms = Date.now() - t0
    if (!res.ok) {
      console.log(`★ ${c.name}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)
      rows.push({ name: c.name, http: res.status })
      continue
    }
    const buf = Buffer.from(await res.arrayBuffer())
    bufLen = buf.length
    w = parseWav(buf)
    if (!w) { console.log(`★ ${c.name}: 非 WAV`); rows.push({ name: c.name, bad: true }); continue }
    writeFileSync(join(OUT, `${c.name}.wav`), buf)
    maxRun = maxRunSec(buf, w)
  }

  const chars = normChars(c.text).length
  const cps = w && w.dur > 0 ? chars / w.dur : null

  // 转写比对
  const got = asrMap.get(c.name) ?? ''
  let sim = null
  let extra = ''
  if (got) {
    sim = similarity(c.text, got)
    const set = new Set(normChars(c.text))
    extra = [...normChars(got)].filter((ch) => !set.has(ch)).join('')
  }

  const flags = []
  if (cps !== null && cps < 3) flags.push(`语速低(${cps.toFixed(1)})`)
  if (maxRun > 3.5) flags.push(`拖长(${maxRun.toFixed(1)}s)`)
  if (sim !== null && sim < 0.6) flags.push(`★念错内容(sim=${sim.toFixed(2)})`)
  const head = w ? `${w.dur.toFixed(2)}s ${cps.toFixed(1)}字/秒 最长连续${maxRun.toFixed(1)}s` : '(未合成)'
  console.log(`${flags.length ? '★' : '✅'} ${c.name.padEnd(12)} ${head}` +
    (sim !== null ? ` sim=${sim.toFixed(2)}` : '') + (flags.length ? `  [${flags.join(' ')}]` : ''))
  if (got) console.log(`     原文: ${c.text}`)
  if (got) console.log(`     转写: ${got}${extra ? `  ← 多出: ${extra}` : ''}`)
  rows.push({ name: c.name, dur: w?.dur, cps, maxRun, sim, got, extra, bytes: bufLen, ms })
}

console.log('\n=== 需要处理的用例 ===')
const bad = rows.filter((r) => r.fail || r.http || r.bad || (r.cps !== undefined && r.cps < 3) || (r.maxRun !== undefined && r.maxRun > 3.5) || (r.sim !== null && r.sim !== undefined && r.sim < 0.6))
if (!bad.length) console.log('  （无）')
for (const r of bad) console.log(`  ${r.name}${r.sim !== undefined && r.sim !== null ? ` sim=${r.sim.toFixed(2)}` : ''}  期望: ${CASES.find((c) => c.name === r.name)?.want}`)
console.log(`\n音频落盘: ${OUT}`)
