#!/usr/bin/env node
/**
 * 清理方案 A/B 实证：同一批"有问题"的文本，
 *   A = 现有 `normalizeSpeakText` 的清理形态（只剥 emotion 标签 + 中英之间插逗号）
 *   B = 新的 `toSpeakable`（URL/路径/命令 → 可朗读说法，符号 → 读音，Markdown → 剥）
 * 两版都送进 GPT-SoVITS 合成，落盘供 ASR 回转比对（比对由 audio/asr_report.py 出）。
 *
 * 用法（在 dsh-nori-pet 目录）：
 *   node scripts/test-speaktext-ab.mjs            # 合成两版并落盘 + 写 cases.json
 *   <venv>/python audio/asr_batch.py scripts/.tts-ab \
 *       scripts/.tts-ab/cases.json scripts/.tts-ab/asr.json
 *   <venv>/python audio/asr_report.py scripts/.tts-ab/asr.json scripts/.tts-ab/report.txt
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toSpeakable } from '../lib/speakText.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '.tts-ab')
mkdirSync(OUT, { recursive: true })

// 与 src/index.ts 的 normalizeSpeakText 保持一致的"现状"实现（对照组 A）
function currentNormalize(raw) {
  let t = String(raw).replace(/\r/g, '').trim()
  if (!t) return t
  t = t.replace(/[`′]/g, '')
  t = t.replace(/([\u4e00-\u9fff])\s*([A-Za-z]{2,}[A-Za-z0-9'-]*)/g, '$1，$2')
  if (!/[。！？!?；;…]$/.test(t)) t += '。'
  return t
}

const CASES = [
  '详见 https://github.com/BubbleSalt/dsh-nori-pet 这个地址。',
  '路径是 D:/models/nori/voice.wav 这里。',
  '执行 npm run build 就行了。',
  '用 a|b 和 c=>d 还有 e==f 表示。',
  '嗯……唔……那个……',
  '**重点**：这里有颗星号。',
  '1. 列表项一，2. 列表项二。',
  '今天很开心 😊 真的！',
  '结果 → 成功，概率 ≥ 90%。',
  '温度是 0.9，上限 3.5 秒。',
  '我把配置写进 nori.config.json 了。',
  '答案是 3×4 等于 12。',
]

let ref = ''
let prompt = ''
try {
  const cfg = JSON.parse(readFileSync(join(HERE, '..', 'nori.config.json'), 'utf8'))
  ref = cfg.refAudio || ''
  prompt = cfg.refPrompt || ''
} catch { /* 无配置 */ }

const cases = []
console.log('用例对照（A=现状 / B=toSpeakable）')
console.log('='.repeat(96))
for (let i = 0; i < CASES.length; i++) {
  const src = CASES[i]
  const a = currentNormalize(src)
  const { text: b, dropped } = toSpeakable(src)
  console.log(`\n[${i}] 原文: ${src}`)
  console.log(`  A 现状 : ${a}`)
  console.log(`  B 新法 : ${b}${dropped ? '   ← 判为不可朗读，跳过合成' : ''}`)
  cases.push({ name: `A${i}-现状`, text: a })
  if (!dropped) cases.push({ name: `B${i}-新法`, text: b })
  else cases.push({ name: `B${i}-新法`, text: '', skip: true })
}
writeFileSync(join(OUT, 'cases.json'), JSON.stringify(cases.filter((c) => !c.skip), null, 1), 'utf8')

const url = 'http://127.0.0.1:9880/tts'
console.log('\n' + '='.repeat(96))
console.log('开始合成（每条约 1~7s）')
for (const c of cases) {
  if (c.skip) { console.log(`⏭ ${c.name}: 跳过（无可朗读内容）`); continue }
  const body = JSON.stringify({
    text: c.text, text_lang: 'zh', prompt_lang: 'zh', media_type: 'wav',
    temperature: 0.9, top_k: 12, speed_factor: 1.0,
    ...(ref ? { ref_audio_path: ref } : {}),
    ...(prompt ? { prompt_text: prompt } : {}),
  })
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(120000) })
    if (!res.ok) { console.log(`★ ${c.name}: HTTP ${res.status}`); continue }
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(join(OUT, `${c.name}.wav`), buf)
    console.log(`✅ ${c.name}: ${(buf.length / 1024).toFixed(0)}KB`)
  } catch (e) {
    console.log(`★ ${c.name}: ${String(e?.message ?? e)}`)
  }
}
console.log(`\n音频: ${OUT}`)
console.log(`下一步: python audio/asr_batch.py "${OUT}" "${join(OUT, 'cases.json')}" "${join(OUT, 'asr.json')}"`)
