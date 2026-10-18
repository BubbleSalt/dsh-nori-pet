import { readFileSync, writeFileSync } from 'node:fs'

/**
 * 直接问 GPT-SoVITS：这段文本会合成出什么样的音频？
 * 用法（在 dsh-nori-pet 目录）：
 *   node scripts/tts-probe.mjs "文本1" "文本2" ...
 *   node scripts/tts-probe.mjs --ref <参考音频> --prompt "<参考文本>" "文本"
 *   node scripts/tts-probe.mjs --temp 0.9 --topk 12 "文本"
 *
 * 为什么需要它：面板上的"外星文/怪声"只有拿到**波形指标**才能定位——
 * 光看文本看不出模型会怎么念。本脚本对每段文本给出与面板同参数的结果，并打印：
 *   时长 / 峰值 / RMS / 本句时长是否与字数匹配 / 最长连续有声段（拖长吞句指标）/ 输出文件
 * 指标口径与 src/index.ts 的 maxContiguousSpeech、wavFrameRms 一致（帧 100ms）。
 */

const argv = process.argv.slice(2)
const opts = { ref: '', prompt: '', temp: '0.9', topk: '12', speed: '1.0', url: 'http://127.0.0.1:9880/tts' }
const texts = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--ref') opts.ref = argv[++i]
  else if (a === '--prompt') opts.prompt = argv[++i]
  else if (a === '--temp') opts.temp = argv[++i]
  else if (a === '--topk') opts.topk = argv[++i]
  else if (a === '--speed') opts.speed = argv[++i]
  else if (a === '--url') opts.url = argv[++i]
  else texts.push(a)
}
if (!texts.length) {
  console.error('用法: node scripts/tts-probe.mjs [--ref 音频] [--prompt 参考文本] "要合成的文本" ...')
  process.exit(2)
}

/** 解析 WAV：找到 fmt/data 块（不能假设 data 在固定偏移——参考音频常带 LIST 块） */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
  let off = 12
  let sr = 24000
  let ch = 1
  let bits = 16
  let dataOff = -1
  let dataLen = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      ch = Math.max(1, buf.readUInt16LE(off + 10))
      sr = buf.readUInt32LE(off + 12)
      bits = buf.readUInt16LE(off + 22)
    } else if (id === 'data') {
      dataOff = off + 8
      dataLen = Math.min(size, buf.length - dataOff)
      break
    }
    off += 8 + size + (size % 2)
  }
  if (dataOff < 0 || !dataLen) return null
  return { sr, ch, bits, dataOff, dataLen, dur: dataLen / (sr * ch * (bits / 8)) }
}

/** 每 100ms 一帧 RMS（与 wavFrameRms 同口径） */
function frames(buf, w) {
  const bytesPer = w.bits / 8
  const per = Math.max(1, Math.floor(w.sr * 0.1))
  const stride = per * bytesPer * w.ch
  const n = Math.floor(w.dataLen / stride)
  const out = []
  for (let f = 0; f < n; f++) {
    let sum = 0
    const base = w.dataOff + f * stride
    for (let i = 0; i < per; i++) {
      const p = base + i * bytesPer * w.ch
      const v = w.bits === 16 ? buf.readInt16LE(p) / 32768 : w.bits === 8 ? (buf.readUInt8(p) - 128) / 128 : buf.readInt32LE(p) / 2147483648
      sum += v * v
    }
    out.push(Math.sqrt(sum / per))
  }
  return out
}

const fps = opts.ref ? null : null
void fps

const results = []
for (let i = 0; i < texts.length; i++) {
  const text = texts[i]
  const body = {
    text,
    text_lang: 'zh',
    prompt_lang: 'zh',
    media_type: 'wav',
    temperature: Number(opts.temp),
    top_k: Number(opts.topk),
    speed_factor: Number(opts.speed),
    ...(opts.ref ? { ref_audio_path: opts.ref } : {}),
    ...(opts.prompt ? { prompt_text: opts.prompt } : {}),
  }
  const t0 = Date.now()
  let res
  try {
    res = await fetch(opts.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) })
  } catch (e) {
    console.log(`\n[${i}] ★ 请求失败: ${String(e?.message ?? e)}`)
    results.push({ i, text, fail: String(e?.message ?? e) })
    continue
  }
  const ms = Date.now() - t0
  if (!res.ok) {
    const err = (await res.text()).slice(0, 300)
    console.log(`\n[${i}] ★ HTTP ${res.status}（${ms}ms）  ${err}`)
    results.push({ i, text, status: res.status, err })
    continue
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const w = parseWav(buf)
  if (!w) { console.log(`\n[${i}] ★ 返回的不是可解析 WAV（${buf.length} 字节）`); results.push({ i, text, bad: true }); continue }
  const rms = frames(buf, w)
  const peak = rms.length ? Math.max(...rms) : 0
  const avg = rms.length ? rms.reduce((a, b) => a + b, 0) / rms.length : 0
  // 最长连续有声段（≥0.06 视作有声），单位秒
  let best = 0
  let cur = 0
  for (const r of rms) { if (r >= 0.06) { cur++; best = Math.max(best, cur) } else cur = 0 }
  const maxSpeech = best / 10
  const chars = [...text].filter((c) => /[\u4e00-\u9fffA-Za-z0-9]/.test(c)).length
  const cps = w.dur > 0 ? chars / w.dur : 0
  const file = `scripts/.tts-probe-${i}.wav`
  writeFileSync(file, buf)
  console.log(`\n[${i}] "${text}"`)
  console.log(`     HTTP 200  ${ms}ms  ${(buf.length / 1024).toFixed(1)}KB`)
  console.log(`     时长 ${w.dur.toFixed(2)}s  含字 ${chars}  语速 ${cps.toFixed(2)} 字/秒  ${cps >= 3 && cps <= 8 ? '✅' : '★ 偏离正常 3~8'}`)
  console.log(`     峰值 ${peak.toFixed(3)}  RMS均值 ${avg.toFixed(3)}  ${peak > 0.02 ? '✅ 有声' : '★ 近乎静音'}`)
  console.log(`     最长连续有声 ${maxSpeech.toFixed(1)}s  ${maxSpeech <= 3.5 ? '✅' : '★ 超 3.5s：疑似 AR 采样循环拖长/吞句'}`)
  console.log(`     → ${file}`)
  results.push({ i, text, dur: w.dur, cps, peak, maxSpeech, file })
}
console.log('\n=== 汇总 ===')
for (const r of results) {
  if (r.fail) console.log(`  [${r.i}] ★ 请求失败`)
  else if (r.status) console.log(`  [${r.i}] ★ HTTP ${r.status}`)
  else if (r.bad) console.log(`  [${r.i}] ★ 非 WAV`)
  else console.log(`  [${r.i}] ${r.dur.toFixed(2)}s ${r.cps.toFixed(2)}字/秒 最长连续${r.maxSpeech.toFixed(1)}s  "${r.text.slice(0, 24)}"`)
}
