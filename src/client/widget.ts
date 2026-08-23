/**
 * Nori 桌宠 widget —— 宿主 tapIndex 注入的普通 <script>，自建 DOM（whale 插件同款机制）。
 * 特性：DPR 高清渲染 / 整窗拖动+记忆位置 / 句子级分段朗读（打断重排 + 音量驱动口型）/
 *       情绪联动（LLM 情绪标签或本地关键词 → 表情+动作）/ 思考表情（agent 工作中）/
 *       摸头反馈（长按摩擦触发台词）/ 睡眠状态机（90s 无交互入睡）/ 体型滑槽（少女/Q版）/
 *       穿透式画布 + 摸头热区（不挡页面文字选取）/ 气泡贴头（随体型/缩放比例定位）。
 * 依赖：bundle banner 内联的 live2dcubismcore.js（真实 core，先于本代码执行）。
 */
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'
;(window as any).PIXI = PIXI

const PREFIX = '/@dsh-external/dsh-nori-pet'
// 口型驱动：ParamMouthOpenY（编辑器实测 = 张嘴 open 参数，运行时表情管道证实有效）。
// 关键时序：变形在 model.update()（csmUpdateModel）时按参数值计算，之后 setParameterValueById
// 只改存储不重算顶点 → 必须把口型写在 coreModel.update() 之前，让变形用我们的值。
const MOUTH_ID = 'ParamMouthOpenY'
const LOGICAL_W = 300
const LOGICAL_H = 280
const DPR = Math.min(window.devicePixelRatio || 1, 2)

// ─── 样式 + 根节点（固定右下角，可拖动） ────────────────────────
const css = `
#nori-pet-root{position:fixed;width:300px;z-index:9999;font-family:inherit;user-select:none;-webkit-user-select:none;touch-action:none;pointer-events:none}
#nori-pet-drag{position:absolute;top:0;left:0;right:20%;height:14px;cursor:move;background:rgba(32,49,112,0);border-radius:8px 8px 0 0}
#nori-pet-drag:hover{background:rgba(32,49,112,.10)}
#nori-pet-bubble{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% + 4px);display:flex;flex-direction:column;align-items:center;gap:4px;max-width:min(300px,calc(100% - 8px));pointer-events:none}
#nori-pet-bubble .bub{background:rgba(255,255,255,.95);color:#203170;border:1px solid rgba(32,49,112,.25);border-radius:10px;padding:6px 10px;font-size:13px;line-height:1.4;box-shadow:0 4px 14px rgba(0,0,0,.14);white-space:pre-wrap;word-break:break-word;max-width:100%;overflow:hidden;transition:opacity .4s ease,max-height .4s ease,padding .4s ease,margin .4s ease}
#nori-pet-bubble .bub.fading{opacity:0;max-height:0;padding-top:0;padding-bottom:0;margin:0}
#nori-pet-canvas{display:block;width:300px;height:280px;-webkit-user-drag:none;pointer-events:none}
#nori-pet-hit{position:absolute;left:32%;top:6.3%;width:36%;height:21%;pointer-events:auto;cursor:grab;background:rgba(0,0,0,0)}
#nori-pet-hit:active{cursor:grabbing}
#nori-pet-controls{position:absolute;top:2px;right:0;display:flex;gap:4px;padding:4px}
#nori-pet-controls button{width:26px;height:26px;border:none;border-radius:8px;background:rgba(32,49,112,.78);color:#fff;font-size:12px;cursor:pointer;line-height:1}
#nori-pet-controls button:hover{background:rgba(32,49,112,.95)}
`
const styleEl = document.createElement('style')
styleEl.textContent = css
document.head.appendChild(styleEl)

const root = document.createElement('div')
root.id = 'nori-pet-root'

const dragHandle = document.createElement('div')
dragHandle.id = 'nori-pet-drag'
dragHandle.title = '拖动移动'

const bubble = document.createElement('div')
bubble.id = 'nori-pet-bubble'

const canvas = document.createElement('canvas')
canvas.id = 'nori-pet-canvas'
canvas.width = LOGICAL_W
canvas.height = LOGICAL_H

const controls = document.createElement('div')
controls.id = 'nori-pet-controls'
const btnZoomOut = document.createElement('button')
btnZoomOut.textContent = '−'
btnZoomOut.title = '缩小'
const btnZoomIn = document.createElement('button')
btnZoomIn.textContent = '＋'
btnZoomIn.title = '放大'
const btnMute = document.createElement('button')
btnMute.textContent = '🔊'
btnMute.title = '静音'
const btnClose = document.createElement('button')
btnClose.textContent = '✕'
btnClose.title = '隐藏/显示'
controls.append(btnZoomOut, btnZoomIn, btnMute, btnClose)

// 体型面板（可开关）：Param158 少女体型 + Param117 Q版，各自 0..1 滑槽
const btnFigure = document.createElement('button')
btnFigure.textContent = '🪆'
btnFigure.title = '体型（少女/Q版）'
const figureWrap = document.createElement('div')
figureWrap.id = 'nori-pet-figure'
figureWrap.style.cssText = 'position:absolute;left:50%;bottom:44px;transform:translateX(-50%);display:none;flex-direction:column;gap:5px;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:7px 12px;font:11px/1 system-ui,"Microsoft YaHei",sans-serif;color:#fff;user-select:none;pointer-events:auto;box-shadow:0 2px 10px rgba(0,0,0,.35)'
const mkRow = (label: string, val: number): HTMLDivElement => {
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;align-items:center;gap:6px;white-space:nowrap'
  const lab = document.createElement('span')
  lab.style.cssText = 'width:52px;color:rgba(255,255,255,.85)'
  lab.textContent = label
  const rg = document.createElement('input')
  rg.type = 'range'
  rg.min = '0'; rg.max = '1'; rg.step = '0.01'
  rg.value = String(val)
  rg.style.cssText = 'width:110px;accent-color:#7ab8ff;margin:0;cursor:pointer;height:14px'
  const v = document.createElement('span')
  v.style.cssText = 'min-width:32px;text-align:right;font-family:ui-monospace,Consolas,monospace;opacity:.9'
  v.textContent = Math.round(val * 100) + '%'
  row.append(lab, rg, v)
  ;(row as any).userData = { rg, v }
  return row
}
const row158 = mkRow('少女体型', 0)
const row117 = mkRow('Q版', 0)
figureWrap.append(row158, row117)
figureWrap.addEventListener('mouseenter', () => { figureWrap.style.opacity = '1' })
figureWrap.addEventListener('mouseleave', () => { figureWrap.style.opacity = '.92' })

const bindRow = (row: HTMLDivElement, setter: (v: number) => void): void => {
  const u = (row as any).userData as { rg: HTMLInputElement; v: HTMLSpanElement }
  u.rg.addEventListener('input', () => {
    const v = parseFloat(u.rg.value)
    u.v.textContent = Math.round(v * 100) + '%'
    setter(v)
  })
}
bindRow(row158, (v) => { figureValue = v })
bindRow(row117, (v) => { qfigureValue = v })
btnFigure.addEventListener('click', () => {
  const show = figureWrap.style.display === 'none'
  figureWrap.style.display = show ? 'flex' : 'none'
  btnFigure.style.background = show ? 'rgba(122,184,255,.4)' : ''
})

controls.insertBefore(btnFigure, btnClose)
// 摸头热区层：在 canvas 之上、但只占头部区域（20%~80% 宽、0~42% 高），
// root/canvas 本身 pointer-events:none 穿透 → 透明区域不挡文字选取
const hitZone = document.createElement('div')
hitZone.id = 'nori-pet-hit'
root.append(dragHandle, bubble, canvas, hitZone, controls, figureWrap)
// 层级：拖动条/按钮/面板浮于交互层之上，气泡中间
canvas.style.zIndex = '10'
hitZone.style.zIndex = '11'
dragHandle.style.zIndex = '20'
bubble.style.zIndex = '15'
controls.style.zIndex = '20'
figureWrap.style.zIndex = '20'
dragHandle.style.pointerEvents = 'auto'
controls.style.pointerEvents = 'auto'
figureWrap.style.pointerEvents = 'auto'
document.body.appendChild(root)

// ─── 位置：localStorage 记忆 + 拖动 ──────────────────────────────
const POS_KEY = 'nori-pet-pos'
function clampPos(x: number, y: number): [number, number] {
  // 收边用：保留边缘 12px 可抓回（松手时才执行，拖动中不受限）
  const maxX = Math.max(0, window.innerWidth - 12)
  const maxY = Math.max(0, window.innerHeight - 12)
  return [Math.min(Math.max(-80, x), maxX), Math.min(Math.max(-80, y), maxY)]
}
function applyPos(x: number, y: number): void {
  const [cx, cy] = clampPos(x, y)
  root.style.right = ''
  root.style.bottom = ''
  root.style.left = cx + 'px'
  root.style.top = cy + 'px'
  try { localStorage.setItem(POS_KEY, JSON.stringify({ x: cx, y: cy })) } catch { /* ignore */ }
}
function restorePos(): void {
  try {
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
    if (pos && typeof pos.x === 'number') { applyPos(pos.x, pos.y); return }
  } catch { /* ignore */ }
  // 无记忆：立即用 left/top 表达默认右下角位置——CSS 的 right/bottom 从起手就不参与，
  // 拖动的整个生命周期都在 left/top 坐标系里（垂直拖动不会再被 bottom 竞争钉死）
  try {
    const r = root.getBoundingClientRect()
    applyPos(Math.max(0, window.innerWidth - r.width - 12), Math.max(0, window.innerHeight - r.height - 12))
  } catch { /* ignore */ }
}
restorePos()

// ─── 缩放：＋/－按钮 + 滚轮，模型与面板同步缩放并记忆 ────────────
const SCALE_KEY = 'nori-pet-scale'
const MIN_SCALE = 0.4
const MAX_SCALE = 4.0
let scaleFactor = 1
try {
  const v = parseFloat(localStorage.getItem(SCALE_KEY) || '1')
  if (isFinite(v)) scaleFactor = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
} catch { /* ignore */ }
let baseScale = 0
let modelRatio = 1 // 模型原生宽高比（加载时一次性记录，避免运行时读取 0/NaN）
function curH(): number { return root.offsetHeight || LOGICAL_H }
/** 画布尺寸：高度按 LOGICAL_H×f（不随体型/Q版参数变化）；宽度 = 原贴合宽的 60%（更窄、去两侧空白） */
function canvasSize(): [number, number] {
  const f = scaleFactor
  const h = Math.max(48, Math.round(LOGICAL_H * f))
  const wFull = Math.max(48, Math.round(h * modelRatio))
  const wMax = Math.max(48, Math.round(LOGICAL_W * f))
  const w0 = Math.min(wFull, wMax)
  return [w0, h]
}
function applyScale(f: number): void {
  scaleFactor = Math.min(MAX_SCALE, Math.max(MIN_SCALE, f))
  const [w, h] = canvasSize()
  root.style.width = w + 'px'
  if (app) {
    app.renderer.resize(w, h)
    if (model) {
      // 模型不缩小：按高度适配画布（baseScale×f）；画布窄 = 两边裁边，不把模型等比压小
      model.scale.set(baseScale * scaleFactor)
      model.position.set(w / 2, h / 2)
    }
  } else {
    canvas.width = w
    canvas.height = h
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
  }
  try { localStorage.setItem(SCALE_KEY, String(scaleFactor)) } catch { /* ignore */ }
  // 尺寸变化后把已拖动的位置重新收进屏幕
  const r = root.getBoundingClientRect()
  if (r.left !== 0 || r.top !== 0) applyPos(r.left, r.top)
}
btnZoomIn.addEventListener('click', () => applyScale(scaleFactor + 0.15))
btnZoomOut.addEventListener('click', () => applyScale(scaleFactor - 0.15))
// 滚轮缩放：绑在摸头热区 + 拖动条上（canvas 已穿透，不再接收事件）
const onWheel = (e: WheelEvent): void => {
  e.preventDefault()
  applyScale(scaleFactor * (e.deltaY < 0 ? 1.1 : 0.9))
}
hitZone.addEventListener('wheel', onWheel, { passive: false })
dragHandle.addEventListener('wheel', onWheel, { passive: false })
{
  let dragging = false
  let lastDragX = 0
  let lastDragY = 0
  dragHandle.addEventListener('pointerdown', (e) => {
    dragging = true
    lastDragX = e.clientX
    lastDragY = e.clientY
    // 按下瞬间强制锚定到 left/top（清掉 CSS 可能残留的 right/bottom），
    // 避免 fixed 布局中 bottom/top 竞争导致垂直方向拖不动
    const r = root.getBoundingClientRect()
    root.style.right = ''
    root.style.bottom = ''
    root.style.left = r.left + 'px'
    root.style.top = r.top + 'px'
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  })
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return
    // 拖动中完全自由移动（不 clamp）：增量叠加到 root 当前坐标，上下左右对称
    const dx = e.clientX - lastDragX
    const dy = e.clientY - lastDragY
    lastDragX = e.clientX
    lastDragY = e.clientY
    const r = root.getBoundingClientRect()
    root.style.right = ''
    root.style.bottom = ''
    root.style.left = (r.left + dx) + 'px'
    root.style.top = (r.top + dy) + 'px'
  })
  window.addEventListener('pointerup', () => {
    if (!dragging) return
    dragging = false
    // 松手时收边一次：把位置收进屏幕（含本地保存）
    const r = root.getBoundingClientRect()
    applyPos(r.left, r.top)
  })
}

// ─── 气泡（每条独立气泡 + 各自 10 秒后独立淡出） ────────────────
const MAX_BUBBLES = 6
function showBubble(text: string): void {
  const bub = document.createElement('div')
  bub.className = 'bub'
  bub.textContent = text
  bubble.appendChild(bub)
  // 普通 column：DOM 第一个在顶部（最旧）—— 超出上限时移除顶部最旧
  while (bubble.children.length > MAX_BUBBLES) bubble.removeChild(bubble.firstChild!)
  // 每条独立淡出：10 秒后淡出并收起，不影响其他气泡
  window.setTimeout(() => {
    bub.classList.add('fading')
    window.setTimeout(() => { try { bub.remove() } catch { /* ignore */ } }, 450)
  }, 20000)
}

// ─── 语音（TTS → WAV → 播放 → RMS → 口型；句子分段 + 打断重排） ──
let audioCtx: AudioContext | null = null
let muted = false
let model: Live2DModel | null = null
let playToken = 0
let currentSrc: AudioBufferSourceNode | null = null
let stopRender = false // 隐藏时停止渲染循环

function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    // 浏览器自动播放策略：首次用户手势（点击/按键）解锁 AudioContext
    const unlock = (): void => { void audioCtx?.resume().catch(() => {}) }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
  }
  return audioCtx
}

function setMouth(v: number): void {
  if (!model) return
  try {
    ;(model as any).internalModel.coreModel.setParameterValueById(MOUTH_ID, Math.min(1, Math.max(0, v)), 1.0)
  } catch { /* ignore */ }
}

// 口型渲染链末段强写的目标值（-1 = 不干预，交给表情/呼吸自由）
let mouthTarget = -1
// 少女体型（Param158）滑槽当前值，0..1；每帧写入防止被状态重置
let figureValue = 0
// Q版（Param117）滑槽当前值，0..1
let qfigureValue = 0
// 默认（体型 0/0）时模型头顶到 root 底部的距离，加载后一次性测量；气泡高度 = 此值 × 比例
let defaultHeadTop = -1

/**
 * 句子切分：先按句末标点切主句，再按逗号/顿号切短（每段上限 40 字，过长硬切）。
 * 短句 → TTS 合成快 → 朗读延迟低，也更贴近 Nori 的短句口吻。
 */
function splitSentences(text: string): string[] {
  const MAX_LEN = 40
  const mainParts = text.match(/[^。！？!?…;\n]+[。！？!?…;]?/g) || [text]
  const out: string[] = []
  for (const part of mainParts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    // 次级切分：逗号/顿号/空格
    const sub = trimmed.split(/(?<=[，、,，])\s*/)
    let buf = ''
    for (const seg of sub) {
      if (buf.length + seg.length <= MAX_LEN) { buf += seg; continue }
      if (buf) { out.push(buf); buf = '' }
      // 单段仍超长 → 硬切
      let rest = seg
      while (rest.length > MAX_LEN) { out.push(rest.slice(0, MAX_LEN)); rest = rest.slice(MAX_LEN) }
      buf = rest
    }
    if (buf) out.push(buf)
  }
  return out.filter((s) => s.trim().length > 0)
}

/** 向宿主合成一句音频；返回 ArrayBuffer（被打断/失败返回 null）。不打断当前播放。 */
function fetchTts(text: string, token: number): Promise<ArrayBuffer | null> {
  return fetch(PREFIX + '/api/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
    .then(async (res) => {
      // 给用户看的气泡文案：503/连不上 = soviits未上线（清晰易懂）；其它错误码保留 codes 便于排障
      if (res.status === 503) { showBubble('（soviits未上线）'); return null }
      if (!res.ok) { showBubble('（TTS 未就绪：' + res.status + '）'); return null }
      const buf = await res.arrayBuffer()
      return token === playToken ? buf : null
    })
    .catch(() => { showBubble('（soviits未上线）'); return null })
}

/** 播放已合成的音频；返回 Promise，播放完或被打断时 resolve。 */
function playBuffer(buf: ArrayBuffer, token: number): Promise<void> {
  return new Promise((resolve) => {
    ;(async () => {
      if (token !== playToken || muted) { resolve(); return }
      const ctx2 = getCtx()
      // 自动播放策略：suspended 时静默尝试恢复——解锁引导已由"睡着等待首次点击"完成，无需再提示
      try { await ctx2.resume() } catch { /* ignore */ }
      if (token !== playToken || muted) { resolve(); return }
      const audio = await ctx2.decodeAudioData(buf)
      if (token !== playToken || muted) { resolve(); return }
      const src = ctx2.createBufferSource()
      src.buffer = audio
      const analyser = ctx2.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
      analyser.connect(ctx2.destination)
      currentSrc = src
      const data = new Uint8Array(analyser.fftSize)
      const start = performance.now()
      const loop = (): void => {
        if (token !== playToken) { mouthTarget = -1; setMouth(0); return }
        if (performance.now() - start >= audio.duration * 1000) { mouthTarget = -1; setMouth(0); return }
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        mouthTarget = Math.min(1, Math.sqrt(sum / data.length) * 7)
        requestAnimationFrame(loop)
      }
      loop()
      src.onended = () => { mouthTarget = -1; setMouth(0); if (currentSrc === src) currentSrc = null; src.disconnect(); resolve() }
      src.start()
    })()
  })
}

// ── 情绪标签解析：改写层输出的每行以【情绪】开头，解析成逐句 {text, emo} ──
const EMO_TAG_RE = /^【([^】]+)】\s*/
const VALID_EMO_TAGS = new Set(['default', 'happy', 'excited', 'angry', 'refuse', 'sad', 'doubt', 'troubled', 'shy', 'surprised', 'dizzy', 'serious', 'speechless', 'think'])
interface TaggedSentence { text: string; emo: Emotion | null }
function parseTagged(text: string): TaggedSentence[] {
  return text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const m = line.match(EMO_TAG_RE)
      if (m && VALID_EMO_TAGS.has(m[1])) return { text: line.slice(m[0].length).trim(), emo: m[1] as Emotion }
      return { text: line, emo: null }
    })
}

/** 朗读：优先按【情绪】标签逐句（每句激活对应表情）；无标签文本回落 splitSentences 本地分类。
 * 预取策略：窗口内并行合成 ≤4 句；第一句就绪即打断当前播放入口、立即开播，播放中后台推进预取。 */
async function speakText(text: string, token: number): Promise<void> {
  const tagged = parseTagged(text)
  const useTagged = tagged.length > 0 && tagged.some((t) => t.emo !== null)
  let sentences: TaggedSentence[]
  if (useTagged) {
    // 标签行逐句；超长行按逗号/句号子切（情绪沿用）
    sentences = []
    for (const t of tagged) {
      if (t.text.length <= 45) { sentences.push(t); continue }
      const sub = t.text.match(/[^，。！？!?…;\n]+[，。！？!?…;]?/g) || [t.text]
      let buf = ''
      for (const seg0 of sub) {
        if (buf.length + seg0.length <= 45) { buf += seg0; continue }
        if (buf) { sentences.push({ text: buf, emo: t.emo }); buf = '' }
        let rest = seg0
        while (rest.length > 45) { sentences.push({ text: rest.slice(0, 45), emo: t.emo }); rest = rest.slice(45) }
        buf = rest
      }
      if (buf) sentences.push({ text: buf, emo: t.emo })
    }
  } else {
    sentences = splitSentences(text).map((s) => ({ text: s, emo: null }))
  }
  if (!sentences.length || token !== playToken) return
  if (muted) {
    // 静音时仍显示气泡，只是不朗读
    showBubble(sentences[0].text)
    return
  }
  // 滑动窗口预取：在途 TTS 请求 ≤4（HTTP/1.1 同源 6 连接上限 + api_v2 单实例排队），
  // 当前句是最早发起的、播放句按序 await，慢句只卡自己——不阻塞后续已就绪的句子
  const MAX_INFLIGHT = 4
  let nextFetch = 0
  const fetchMap = new Map<number, Promise<ArrayBuffer | null>>()
  const ensureFetches = (untilIdx: number): void => {
    const until = Math.min(sentences.length, untilIdx)
    while (nextFetch < until) {
      const j = nextFetch
      nextFetch += 1
      fetchMap.set(j, fetchTts(sentences[j].text, token))
    }
  }
  ensureFetches(MAX_INFLIGHT)
  if (token !== playToken) return
  // 第一句就绪 → 打断当前 → 立即开播
  if (currentSrc) { try { currentSrc.stop() } catch { /* ignore */ } currentSrc = null }
  for (let i = 0; i < sentences.length; i++) {
    if (token !== playToken) break
    ensureFetches(i + MAX_INFLIGHT) // 播放到 i 时，窗口推进预取到 i+4
    if (sentences[i].emo && !sleeping) setEmotion(sentences[i].emo) // LLM 情绪标签 → 逐句激活表情
    // 句首清场：表情切换可能残留嘴部参数，先归零再开播（保证口型从 0 跟随音量）
    try { (model as any).internalModel.coreModel.setParameterValueById(MOUTH_ID, 0, 1.0) } catch { /* ignore */ }
    showBubble(sentences[i].text)
    const buf = await fetchMap.get(i)!
    if (token !== playToken || !buf) break
    await playBuffer(buf, token)
  }
}

// ─── 朗读队列：同 turn 的文本排队顺序读完，跨 turn 才打断 ───────
let activeTurn: number | null = null
const pendingTexts: string[] = []
let pumping = false

// ── 取证：播放文本 hash 环形缓冲（重复朗读检测，只 warn 不改行为）──
const PLAY_HASH_MAX = 30
const playHashes: string[] = []
function hashText(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
function notePlayed(text: string): void {
  const h = hashText(text)
  if (playHashes.includes(h)) console.warn('[nori-pet] REPEAT PLAY detect: hash=' + h + ' text=' + text.slice(0, 30))
  playHashes.push(h)
  if (playHashes.length > PLAY_HASH_MAX) playHashes.shift()
}

/** 新 turn：打断当前朗读，重排为最新文本 */
function speakInterrupt(text: string): void {
  notePlayed(text)
  wakeUp() // 朗读唤醒
  playToken += 1
  if (currentSrc) { try { currentSrc.stop() } catch { /* ignore */ } currentSrc = null }
  pendingTexts.length = 0
  pendingTexts.push(text)
  void pumpQueue()
}

/** 同 turn 追加：加入队列尾部，不打断当前（读完上一段再接） */
function speakAppend(text: string): void {
  notePlayed(text)
  wakeUp() // 朗读唤醒
  if (muted) {
    const first = parseTagged(text)[0]
    if (first && first.text) showBubble(first.text)
    return
  }
  pendingTexts.push(text)
  void pumpQueue()
}

async function pumpQueue(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    while (pendingTexts.length) {
      const text = pendingTexts.shift()!
      await speakText(text, playToken)
    }
  } finally {
    pumping = false
  }
}

/** 兼容旧调用：独立触发（如打招呼）→ 打断重排 */
function speak(text: string): void {
  speakInterrupt(text)
}

/** 优先插入（摸头等反馈台词）：打断当前正在读的句子、插到队首立即说，
 * 但【保留等待队列】——摸头台词说完后，剩余文本继续朗读（不截断）。 */
function speakPriority(text: string): void {
  notePlayed(text)
  wakeUp() // 朗读唤醒
  playToken += 1 // 作废在途 TTS 与当前句
  if (currentSrc) { try { currentSrc.stop() } catch { /* ignore */ } currentSrc = null }
  pendingTexts.unshift(text) // 队首插入，保留其余等待文本
  void pumpQueue()
}

btnMute.addEventListener('click', () => {
  muted = !muted
  btnMute.textContent = muted ? '🔇' : '🔊'
  if (muted) { if (currentSrc) { try { currentSrc.stop() } catch { /* ignore */ } currentSrc = null } }
})

// ─── 情绪枢纽：文本 → 表情 + 动作联动（纯 widget 端，零 LLM 成本） ──
type Emotion =
  | 'default' | 'happy' | 'excited' | 'angry' | 'refuse' | 'sad' | 'doubt'
  | 'troubled' | 'shy' | 'surprised' | 'dizzy' | 'serious' | 'speechless'
  | 'think'

/**
 * 情绪 → Live2D 表现：
 * expr = model3.json Expressions 的 Name；reaction = Motions.Reactions 组下标。
 * holdMs = 该情绪的最长驻留（毫秒），超时无新消息自行回落 default（防表情冻住）。
 * 标签→表情严格语义对应（happy=开心笑等）；口型独立于表情（cm.update 前置写 MouthOpenY）。
 * default = 纯待机：不应用表情（模型无 00_Default 表达式），直接回 Idle 0（00_Idle）。
 */
const EMOTION_TABLE: Record<Emotion, { expr?: string; reaction?: number; holdMs?: number }> = {
  default:    { }, // 无表情：回待机动作（setEmotion 特判 Idle 0）
  happy:      { expr: '13_Happy',   reaction: 5 }, // 开心笑 + WakuWaku_in
  excited:    { expr: '01_KiraKira', reaction: 6 }, // 星星眼 + Wakuwaku_loop
  angry:      { expr: '03_Angry',   reaction: 7 },
  refuse:     { expr: '11_Disgust', reaction: 12 }, // 拒绝：厌恶脸 + NoNoNo
  sad:        { expr: '08_Tears' },
  doubt:      { expr: '10_Doubt',   reaction: 8 },
  troubled:   { expr: '09_Troubled', reaction: 9 },
  shy:        { expr: '04_Shy',   reaction: 0 }, // Nod
  surprised:  { expr: '01_KiraKira', reaction: 2 }, // 星光眼 + Stare_loop
  dizzy:      { expr: '02_Dizzy',   reaction: 10 },
  serious:    { expr: '12_Serious' },
  speechless: { expr: '06_Speechless', reaction: 1 }, // ShakeHead
  think:      { expr: '10_Doubt',   reaction: 3, holdMs: 15000 }, // 思考：Doubt + Stare_in（Param132 疑问嘴不影响 MouthOpenY，可正常张口）
}

/** 关键词 → 情绪（顺序即优先级：先命中先取） */
const EMOTION_KEYWORDS: Array<[Emotion, RegExp]> = [
  ['excited', /哇|天哪|居然|太棒|好耶|惊喜|没想到|万岁|好厉害|真厉害|吓一跳/],
  ['happy', /开心|高兴|太好了|真好|嘿嘿|哈哈|嘻嘻|喜欢|爱了|棒|好呀|好哇|真不错|有趣|摸摸头|舒服/],
  ['sad', /难过|伤心|遗憾|可惜|哭了|想哭|好痛|失落|寂寞|舍不得/],
  ['angry', /生气|可恶|气死|气人|讨厌|过分|岂有此理|不干了|不行了/],
  ['refuse', /拒绝|我不要|才不要|不要不要|别别别|不愿意|免了|算了|不去|不行不行|NoNo|说no/],
  ['surprised', /竟然|居然|吃惊|惊讶|吓到|突然/],
  ['troubled', /麻烦|难办|纠结|怎么办|头疼|犯难|为难|不知所措/],
  ['doubt', /奇怪|怎么回|为什么|真的吗|是这样吗|疑问|嗯？|？|想不通/],
  ['dizzy', /晕|眼花|天旋地转|昏/],
  ['serious', /认真|严肃|重要|必须|一定|警告|注意|记住/],
  ['speechless', /无语|说不出话|沉默|无言以对/],
  ['shy', /害羞|不好意思|谢谢|麻烦你了|脸红/],
]

function classifyEmotion(text: string): Emotion {
  for (const [e, re] of EMOTION_KEYWORDS) if (re.test(text)) return e
  return 'default'
}

let lastExprApplied = '' // 当前实际应用的表情，避免同表情重复切换（口型/过渡不被频繁打断）
let currentEmotion: Emotion = 'default'
let thinking = false
let emotionTimer: number | null = null

/** 表情驻留到期 → 回落 default（think 由 setThinking 独立管理，不在这里回收） */
function scheduleEmotionReset(ms: number): void {
  if (emotionTimer) window.clearTimeout(emotionTimer)
  emotionTimer = window.setTimeout(() => {
    if (!thinking && currentEmotion !== 'default') setEmotion('default')
  }, ms)
}

/**
 * 切换情绪：换表情，情绪变化时附带播一次对应小动作（朗读中不抢）。
 * opts.force=true 强制重申表情（摸头等直接反馈场景，无视同表情门控）；
 * opts.forceReaction=true 强制播一次对应小动作（朗读中也能给反馈）；
 * opts.noReaction=true 不播小动作（揉头等需要保持头部跟随的场景）。
 * default = 纯待机：不应用表情（模型无 00_Default），直接回 Idle 0（00_Idle）并清表情门控。
 */
function setEmotion(e: Emotion, opts?: { force?: boolean; forceReaction?: boolean; noReaction?: boolean }): void {
  if (!model) return
  if (sleeping) return // 睡觉不动表情（闭眼状态归睡觉逻辑管）
  if (e === 'default') {
    currentEmotion = 'default'
    lastExprApplied = '' // 清门控：下一个表情无条件生效（"无表情在位"语义）
    if (emotionTimer) { window.clearTimeout(emotionTimer); emotionTimer = null }
    // 表情回中性（resetExpression = 无表情驻留，pixi 库语义）
    try {
      const em = (model as any).internalModel.motionManager.expressionManager
      if (em?.resetExpression) em.resetExpression()
    } catch { /* ignore */ }
    if (!stroke) { try { model.motion('Idle', 0) } catch { /* ignore */ } } // 回待机动作
    return
  }
  const changed = currentEmotion !== e
  currentEmotion = e
  const cfg = EMOTION_TABLE[e]
  const expr = cfg.expr!
  // 仅在实际表情变化（或 force 重申）时才调用 expression（同情绪连续句不再打断过渡/口型）
  if (opts?.force || expr !== lastExprApplied) {
    try {
      model.expression(expr)
      lastExprApplied = expr // 仅成功才记录——失败则下次继续重试，不会被门控吞掉
    } catch (err) {
      console.warn('[nori-pet] expression fail:', expr, err)
    }
  }
  // noReaction：摸头等需要保持头部跟随的场景禁用 reaction 动作；揉头中（stroke）也一律不播，防头部曲线回盖
  if (typeof cfg.reaction === 'number' && !stroke && !opts?.noReaction && (opts?.forceReaction || (changed && !currentSrc))) {
    try { model.motion('Reactions', cfg.reaction) } catch { /* ignore */ }
  }
  scheduleEmotionReset(cfg.holdMs ?? 8000)
}

/** 思考态开关：agent 工作中显示沉思表情；结束收回（不覆盖朗读中的真实情绪） */
function setThinking(on: boolean): void {
  if (on) {
    thinking = true
    setEmotion('think')
    return
  }
  if (!thinking) return
  thinking = false
  if (currentEmotion === 'think') setEmotion('default')
}

// ─── Live2D ──────────────────────────────────────────────────────
let app: PIXI.Application | null = null

function setRendering(on: boolean): void {
  stopRender = !on
  if (app) {
    if (on) { try { app.start() } catch { /* ignore */ } }
    else { try { app.stop() } catch { /* ignore */ } }
  }
}

async function startModel(): Promise<void> {
  try {
    app = new PIXI.Application({
      view: canvas,
      width: LOGICAL_W,
      height: LOGICAL_H,
      resolution: DPR,
      autoDensity: true,
      backgroundAlpha: 0,
      autoStart: true,
      antialias: true,
    })
    const m = await Live2DModel.from(PREFIX + '/assets/Nori.model3.json', {
      autoInteract: false,
      motionPreload: 'none' as any, // 库类型枚举与实际运行值不一致，运行时行为正确
    })
    model = m
    // 渲染链强写口型（前置写）：库 _render 顺序 = internalModel.update()（csmUpdateModel 顶点
    // 变形在此按参数计算）→ draw()。把音量 MouthOpenY 写在 cm.update 之前，变形直接用音量值；
    // expression 的 MouthOpenY 也被我们压过（表达式在 update 流程内执行，早于这里）。
    ;(function attachMouthOverride(target: any): void {
      const im = target.internalModel
      const cm = im.coreModel
      const origUpdate = cm.update.bind(cm)
      cm.update = (...a: any[]) => {
        try {
          if (mouthTarget >= 0) {
            cm.setParameterValueById(MOUTH_ID, Math.min(1, Math.max(0, mouthTarget)), 1.0)
          }
          // 体型（少女/Q版）：每帧保持滑槽值（防被表情/动画/loadParameters 重置）
          cm.setParameterValueById('Param158', figureValue, 1.0)
          cm.setParameterValueById('Param117', qfigureValue, 1.0)
        } catch { /* ignore */ }
        return origUpdate(...a)
      }
    })(m)
    baseScale = Math.min(LOGICAL_W / m.width, LOGICAL_H / m.height) * 0.92
    if (isFinite(m.width / m.height) && m.height > 0) modelRatio = m.width / m.height
    m.anchor.set(0.5, 0.5)
    app.stage.addChild(m)
    // 应用记忆的缩放因子（resize + scale + 居中）
    applyScale(scaleFactor)
    // 一次性测量默认头顶高度（此时 scale 已是最终比例；失败则按比例估算兜底）
    try {
      const im = (m as any).internalModel
      const cm2 = im.coreModel
      const n = cm2.getDrawableCount()
      let minY = Infinity
      for (let i = 0; i < n; i++) {
        if ((cm2.getDrawableOpacity(i) ?? 1) < 0.02) continue
        const vs = im.getDrawableVertices(i)
        for (let j = 1; j < vs.length; j += 2) {
          const y = vs[j]
          if (y < minY) minY = y
        }
      }
      if (isFinite(minY)) defaultHeadTop = curH() - minY
    } catch { /* ignore */ }
    if (defaultHeadTop < 0) defaultHeadTop = Math.round(0.9 * curH())
    // 统一动画帧：摸头摩擦头部跟随（被揉反馈） + UI 贴头定位
    const tick = (): void => {
      if (stopRender) return
      try {
        const core = (model as any).internalModel.coreModel
        // 摸头反馈（被揉感加强）：头部大幅跟随鼠标、跟手更快；松手/睡觉回中
        strokeSX += ((stroke ? strokeHeadX : 0) - strokeSX) * 0.25
        strokeSY += ((stroke ? strokeHeadY : 0) - strokeSY) * 0.25
        const sc = sleeping ? 0 : 1
        core.setParameterValueById('ParamAngleX', strokeSX * 24 * sc, 1.0) // 转头 ±24°
        core.setParameterValueById('ParamAngleY', strokeSY * 18 * sc, 1.0) // 点头 ±18°
        core.setParameterValueById('ParamAngleZ', strokeSX * 14 * sc, 1.0) // 歪头 ±14°
        // 兜底：揉头期间每帧无条件停掉一切动作（idle/reaction 的头部曲线任何时刻都会被清掉，
        // 不依赖偏差检测——快速连续揉动也不会被 fade 中的动作拽走头部）
        if (stroke && performance.now() - strokeDownT > 120) {
          try { ;(model as any).internalModel.motionManager.stopAllMotions() } catch { /* ignore */ }
        }
        // UI 锚定模型头顶（纯比例，无扫描无浮动）；相对 canvas 顶部（top 坐标系）+ 气泡 bottom 定位：
        // 头顶离画布顶 topY = 画布高 - (头顶距底部)；按钮 topY-16k、拖动条 -36k、面板 -68k（k=1/缩放），
        // 气泡 bottom = 头顶距底 + 60k（新气泡贴头、旧话向上推）；热区顶 = 头顶上方 6% 画布高
        if (defaultHeadTop > 0) {
          const ratio = Math.max(0.6, 1 - 0.05 * figureValue - 0.30 * qfigureValue)
          const ht = Math.round(defaultHeadTop * ratio)
          const k = 1 / Math.max(0.4, scaleFactor)
          const hPx = root.offsetHeight || curH()
          const topY = hPx - ht // 模型头顶离画布顶（随体型变矮而下移）
          controls.style.bottom = ''
          controls.style.top = String(Math.round(topY - 16 * k)) + 'px'
          dragHandle.style.bottom = 'auto'
          dragHandle.style.top = String(Math.round(topY - 36 * k)) + 'px'
          // 气泡：bottom 锚定在头顶上方 —— 新气泡贴头、旧气泡被顶向上（远离脸）
          bubble.style.top = 'auto'
          bubble.style.bottom = String(ht + 60 * k) + 'px'
          figureWrap.style.bottom = ''
          figureWrap.style.top = String(Math.round(topY - 68 * k)) + 'px'
          // 摸头热区跟随体型：顶 = 头顶上方 6% 画布高（模型变矮 → 热区同步下移）
          hitZone.style.top = Math.round(Math.max(0, topY - 0.06 * hPx)) + 'px'
        }
      } catch { /* ignore */ }
      requestAnimationFrame(tick)
    }
    tick()
    // ── 苏醒流程：初始呈现睡眠（Sleep 组 00_Sleep）→ 首次点击页面后醒来打招呼（手势解锁音频，语音才能出声）→ 微笑驻留超时回落纯 idle ──
    sleeping = true // 初始睡眠态（不启动入睡计时，唤醒后 resetSleepTimer 自然接管）
    playSleepMotion() // 00_Sleep（独立 Sleep 组，不进库的 idle 随机池；加载完成后自动置真循环）
    const GREETING = '你回来啦！Nori真的等你好久了呀......这里一下子又暖起来了。'
    let greetingDone = false
    function greetOnce(): void {
      if (greetingDone) return
      greetingDone = true
      speak(GREETING) // → speakInterrupt → wakeUp：转 Idle[0] + resetSleepTimer（90s 入睡计时从这里起算）
      setEmotion('happy') // 醒来转微笑（happy 驻留 ~8s，超时 scheduleEmotionReset 回落纯 idle）
    }
    // 等首次点击（AudioContext 手势解锁的同一事件）再触发打招呼（无 60s 兜底：不点击就一直睡着等用户）
    window.addEventListener('pointerdown', greetOnce, { once: true })
  } catch (e) {
    showBubble('（模型加载失败：' + String(e).slice(0, 80) + '）')
    console.error('[nori-pet] model failed', e)
  }
}

function initLive2D(): void {
  // banner 已内联真实 core；若锚点仍缺失（如缓存旧 bundle），动态补一次
  if (!(window as any).Live2DCubismCore) {
    const script = document.createElement('script')
    script.src = PREFIX + '/assets/core/live2dcubismcore.js'
    script.onload = () => { void startModel() }
    script.onerror = () => showBubble('（core 加载失败）')
    document.head.appendChild(script)
    return
  }
  void startModel()
}

// ─── WebSocket 订阅（agent 输出 → 气泡 + 朗读） ─────────────────
let ws: WebSocket | null = null
let wsRetry = 0
let lastMsg = ''
let lastSpeak = ''
function connect(): void {
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(proto + '://' + location.host + PREFIX + '/ws')
  } catch {
    ws = null
  }
  if (!ws) { showBubble('（无法连接宿主）'); return }
  ws.onopen = () => {
    wsRetry = 0
    ws!.send(JSON.stringify({ type: 'hello', sessionId: '' }))
  }
  ws.onmessage = (ev) => {
    let msg: any
    try { msg = JSON.parse(ev.data as string) } catch { return }
    lastMsg = String(ev.data).slice(0, 120)
    try { ws!.send(JSON.stringify({ type: 'ack' })) } catch { /* ignore */ }
    if (msg.type === 'approval' && typeof msg.text === 'string' && msg.text) {
      // 权限申请提醒：打断当前朗读优先播报（原文，提醒用户回来处理）
      lastSpeak = msg.text.slice(0, 60)
      activeTurn = null
      setThinking(false)
      setEmotion('surprised') // 惊一下：权限申请需要用户注意
      speakInterrupt(msg.text)
      return
    }
    if (msg.type === 'assistant' && typeof msg.text === 'string' && msg.text) {
      lastSpeak = msg.text.slice(0, 60)
      setThinking(false) // 有输出了，思考态结束
      // 情绪联动：优先 LLM 情绪标签（首句）；普通句只有命中关键词才切情绪——无情绪句
      // 不打断当前表情（驻留由 scheduleEmotionReset 统一管理，避免逐句推流把表情秒打回 default）
      const firstTag = parseTagged(msg.text).find((t) => t.emo)
      if (firstTag) setEmotion(firstTag.emo)
      else {
        const c = classifyEmotion(msg.text)
        if (c !== 'default') setEmotion(c)
      }
      const t = typeof msg.turn === 'number' ? msg.turn : null
      if (t !== null) {
        if (activeTurn === null || t === activeTurn) {
          if (activeTurn === null) activeTurn = t
          speakAppend(msg.text)
        } else {
          activeTurn = t
          speakInterrupt(msg.text)
        }
      } else {
        activeTurn = null
        speakInterrupt(msg.text)
      }
      return
    }
    // 思考表情：agent 工作中（用户发言 / 工具调用）→ 沉思；turn 结束回收
    if (msg.type === 'tool' || msg.type === 'user') { setThinking(true); return }
    if (msg.type === 'turn-end') { setThinking(false); return }
    // emote：宿主 /api/emote 手动触发（验证情绪联动用）
    if (msg.type === 'emote') {
      const e = String(msg.e ?? '')
      if (e in EMOTION_TABLE) { setThinking(false); setEmotion(e as Emotion) }
      if (typeof msg.text === 'string' && msg.text) { activeTurn = null; speakInterrupt(msg.text) }
      return
    }
  }
  ws.onclose = () => {
    ws = null
    if (!document.hidden && wsRetry < 10) {
      wsRetry += 1
      setTimeout(connect, Math.min(10000, 1000 * wsRetry))
    }
  }
  ws.onerror = () => { try { ws!.close() } catch { /* ignore */ } }
}

let hidden = false
btnClose.addEventListener('click', () => {
  hidden = !hidden
  root.style.visibility = hidden ? 'hidden' : 'visible'
  btnClose.textContent = hidden ? '◉' : '✕'
  setRendering(!hidden)
})

// ─── 摸头（按住+拖动摩擦触发）：长按摩擦一小会才说台词（台词绑定情绪）；
//      摩擦途中头部轻微跟随（被揉反馈）；音效接口留占位（找到音源后接入）。
const PAT_REPLIES: Array<{ text: string; emo: Emotion }> = [
  { text: '头发都被你揉乱啦。', emo: 'shy' },
  { text: '再摸就要收费啦。', emo: 'happy' },
  { text: 'Nori不是小狗啦。', emo: 'speechless' },
  { text: '你是不是把Nori当宠物了？', emo: 'doubt' },
  { text: '为什么摸我的头呀。', emo: 'doubt' },
  { text: '摸完要负责陪我玩游戏哦。', emo: 'happy' },
  { text: '你摸Nori，Nori也不会掉毛的。', emo: 'speechless' },
  { text: '好乖....啊，说反了，是你在摸我。', emo: 'shy' },
  { text: '只有Nori有摸头待遇吗？', emo: 'doubt' },
  { text: '嘿嘿，摸摸头很舒服，感觉芯片都要开心得发热了。', emo: 'happy' },
  { text: '这算是表扬吗？那我记下来了。', emo: 'shy' },
]
const HEAD_ZONE = { x0: 0.2, x1: 0.8, y1: 0.42 } // 头部区域（画布归一化）
let stroke = false // 是否正在摸头摩擦
let strokeDownT = 0 // 按下时刻
let strokeDist = 0 // 累计拖动距离（px）
let strokeLastX = 0
let strokeLastY = 0
let strokeTriggered = false
let strokeHeadX = 0 // 摩擦中鼠标相对画布中心偏移（-1..1，头部跟随目标）
let strokeHeadY = 0
let strokeSX = 0 // 平滑跟踪（tick 里 lerp，松手回中）
let strokeSY = 0

function canvasPos(e: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect()
  return rect.width ? [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height] : [0.5, 1]
}
function inHeadZone(x: number, y: number): boolean {
  return x >= HEAD_ZONE.x0 && x <= HEAD_ZONE.x1 && y <= HEAD_ZONE.y1
}
// 摸头台词冷却：触发台词后此时间内再摸只跟随反馈、不说话（防连续刷屏）
const PAT_COOLDOWN_MS = 6000
let patCooldownUntil = 0

function triggerPat(): void {
  if (strokeTriggered) return
  strokeTriggered = true
  wakeUp()
  // 冷却中：摸头反馈始终是"被揉"（头部跟随一直在 tick 里），只在冷却到点后加台词/表情
  const now = Date.now()
  if (now < patCooldownUntil) return
  patCooldownUntil = now + PAT_COOLDOWN_MS
  const pat = PAT_REPLIES[Math.floor(Math.random() * PAT_REPLIES.length)]
  // 只切表情、不播 reaction 动作（动作含头部曲线会覆盖揉头跟随）
  setEmotion(pat.emo, { force: true, noReaction: true })
  // speak 内部会显示气泡并朗读 —— 这里不再单独 showBubble，避免重复显示
  speakPriority(pat.text) // 摸头台词优先插入：不截断正在排队等待的朗读文本
}
function startStroke(): void {
  stroke = true
  strokeDownT = performance.now()
  strokeDist = 0
  strokeTriggered = false
  // ── 摩擦音效接口占位：找到音源后在这里循环播放（音量 ~0.2），endStroke() 里停止 ──
  // 关键：停掉待机动作（00_Idle 的曲线每帧覆盖 ParamAngleX/Y/Z），头部完全交给揉头参数驱动
  try { ;(model as any).internalModel.motionManager.stopAllMotions() } catch { /* ignore */ }
}
function endStroke(): void {
  if (!stroke) return
  stroke = false
  // ── 摩擦音效停止占位 ──
  // 恢复待机动作（idle 或睡眠闭眼），头部控制权交还原动作；睡眠恢复用 FORCE（同 NORMAL 守卫）
  if (sleeping) {
    const t = sleepMotionTarget()
    if (t) { try { model.motion(t.group, t.index, 3) } catch { /* ignore */ } }
    ensureSleepLoop()
  } else { try { model.motion('Idle', 0) } catch { /* ignore */ } }
}

hitZone.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || stroke) return
  const [x, y] = canvasPos(e)
  if (!inHeadZone(x, y)) return
  startStroke()
  strokeLastX = e.clientX
  strokeLastY = e.clientY
  try { hitZone.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  wakeUp()
})
window.addEventListener('pointermove', (e) => {
  if (!stroke) return
  const [x, y] = canvasPos(e)
  // 摩擦中：累计拖动距离 + 头部跟随目标
  const dx = e.clientX - strokeLastX
  const dy = e.clientY - strokeLastY
  strokeDist += Math.sqrt(dx * dx + dy * dy)
  strokeLastX = e.clientX
  strokeLastY = e.clientY
  strokeHeadX = Math.max(-1, Math.min(1, (x - 0.5) * 2))
  strokeHeadY = Math.max(-1, Math.min(1, (y - 0.5) * 2))
  // 触发：按住 ≥2000ms + 拖动 ≥20px（长按摩擦才触发台词；动效反馈在 startStroke 后即有头部跟随）
  const held = performance.now() - strokeDownT
  if (!strokeTriggered && held > 2000 && strokeDist > 20) triggerPat()
})
const endStrokeP = (): void => endStroke()
window.addEventListener('pointerup', endStrokeP)
window.addEventListener('pointercancel', endStrokeP)

// ─── 睡觉状态机：N 分钟无交互 → 播 Sleep 组 00_Sleep；任何交互/朗读 → 唤醒 ──
const SLEEP_AFTER_MS = 90000 // 90 秒无交互入睡（原 180s 减半）
let sleeping = false
let sleepTimer: number | null = null
let lastMoveActivity = 0
let lastMoveX = -1
let lastMoveY = -1
// 交互监听：桌宠区域的操作算"活动"；鼠标快速划过（位移 <15px）不误唤醒
root.addEventListener('pointerdown', () => wakeUp())
root.addEventListener('wheel', () => wakeUp(), { passive: true })
root.addEventListener('pointermove', (e) => {
  // 睡眠中悬停不算交互唤醒（仅点击/滚轮/朗读唤醒）——否则鼠标路过/停在头部区域就会误唤醒睁眼
  if (sleeping) return
  const now = Date.now()
  if (now - lastMoveActivity <= 5000) {
    lastMoveX = e.clientX
    lastMoveY = e.clientY
    return
  }
  const dx = e.clientX - lastMoveX
  const dy = e.clientY - lastMoveY
  if (lastMoveX < 0 || Math.sqrt(dx * dx + dy * dy) > 15) {
    lastMoveActivity = now
    lastMoveX = e.clientX
    lastMoveY = e.clientY
    wakeUp()
  }
})

function resetSleepTimer(): void {
  if (sleepTimer) window.clearTimeout(sleepTimer)
  sleepTimer = window.setTimeout(goSleep, SLEEP_AFTER_MS)
}

/** 让睡眠动作真正循环（Sleep 组或 Idle 组内的睡眠动作）：这版 pixi 库不消费 motion3.json 的
 * Loop 字段（_isLoop 恒 false）→ 播 3 秒即 finished → 库会自动随机重播 idle 池（睁眼）。
 * 对已加载的 CubismMotion 实例调用 setIsLoop(true)：Loop 后永不 finished，睡眠稳定闭眼。
 * 同时关掉 loop 重播的 fade（setIsLoopFadeIn(false)）：否则每 3 秒循环重播时参数曲线
 * 从头 fade 一遍 → 头部/身体参数被重置回起始值（"头突然回正"的突兀感）。
 * 需在睡眠动作的异步加载完成后调用（motionGroups 里才有实例）。 */
function ensureSleepLoop(): void {
  try {
    const t = sleepMotionTarget()
    if (!t) return
    const mm = (model as any)?.internalModel?.motionManager
    const sl = mm?.motionGroups?.[t.group]?.[t.index]
    if (sl && typeof sl.setIsLoop === 'function') {
      sl.setIsLoop(true)
      if (typeof sl.setIsLoopFadeIn === 'function') sl.setIsLoopFadeIn(false)
    }
  } catch { /* ignore */ }
}
/** 睡眠动作定位（只适配原版 Nori 模型）：00_Sleep 就在 Idle 组（idle 池一员），
 * 主动入睡时直接指定该 index 播放 + 置永续 loop，脱离 idle 池随机。 */
function sleepMotionTarget(): { group: string; index: number } | null {
  try {
    const idle = (model as any)?.internalModel?.motionManager?.definitions?.Idle ?? []
    for (let i = 0; i < idle.length; i++) {
      if (/Sleep|EyeClosed/i.test(String(idle[i]?.File ?? ''))) return { group: 'Idle', index: i }
    }
  } catch { /* ignore */ }
  return null
}
/** 播入睡动作（Sleep 组 或 Idle 组内的睡眠动作）+ 加载完成后置真循环。
 * 必须用 MotionPriority.FORCE(=3)：goSleep 前 setEmotion('default') 会先播 Idle(NORMAL=2)，
 * 库的 reserve 守卫 `priority <= currentPriority` 会拒绝同优先级的睡眠动作 → 从未播放
 * （sleeping=true 但动作停留在 Idle）。FORCE 绕过守卫必定切入睡姿。 */
function playSleepMotion(): void {
  try {
    const t = sleepMotionTarget()
    if (!t) return
    const p = model.motion(t.group, t.index, 3) // MotionPriority.FORCE
    if ((p as any)?.then) (p as any).then(ensureSleepLoop)
    // 一次性兜底（仅入睡这一刻，非 per-frame）：00_Sleep 时长 3s，若 loop 因任何原因
    // 未设置成功（播完回落 idle 池睁眼），3.5s 后复查当前动作并 FORCE 重播。
    window.setTimeout(() => {
      try {
        const t2 = sleepMotionTarget()
        const mm = (model as any)?.internalModel?.motionManager
        const active = !!t2 && !!mm?.state && mm.state.currentGroup === t2.group
        if (sleeping && t2 && !active) {
          const p2 = model.motion(t2.group, t2.index, 3)
          if ((p2 as any)?.then) (p2 as any).then(ensureSleepLoop)
        }
      } catch { /* ignore */ }
    }, 3500) as unknown as number
  } catch { /* ignore */ }
}

function goSleep(): void {
  if (!model) { resetSleepTimer(); return }
  if (sleeping) return
  // 朗读中不入睡：长回复逐句播放可能超过 90s，播放完后的完整空闲再重新计时
  if (currentSrc || pumping || pendingTexts.length) { resetSleepTimer(); return }
  if (currentEmotion !== 'default') setEmotion('default') // 睡前清表情，防止带嘴/带眼表情残留睁眼
  sleeping = true
  playSleepMotion()
  showBubble('唔……Nori要睡着了。')
}

function wakeUp(): void {
  if (!sleeping) { resetSleepTimer(); return }
  sleeping = false
  if (model) {
    // 必须先清空动作队列：00_Sleep 已被置为永续 loop（NORMAL 优先级永不 finished），
    // 直接 motion('Idle',0)（同为 NORMAL）会被库的同级覆盖检查拒绝 → 动作永远卡在睡姿。
    // stopAllMotions 清掉 Sleep 条目与 currentPriority → Idle 0 才能正常启动。
    try { (model as any).internalModel.motionManager.stopAllMotions() } catch { /* ignore */ }
    try { model.motion('Idle', 0) } catch { /* ignore */ } // 回待机
  }
  resetSleepTimer()
  setEmotion('default') // 睡醒回纯 idle（无表情）
}

initLive2D()
connect()

;(window as any).__noriPetWidget = {
  root, showBubble, speak,
  get model() { return model },
  diag: () => ({ wsState: ws?.readyState ?? -1, wsRetry, muted, lastMsg, lastSpeak, scale: scaleFactor,
    pos: root.style.left || root.style.right, top: root.style.top || root.style.bottom }),
  // 调试：让 Nori 说一段带标签的句子（完整走朗读 + 情绪标签链路）。
  // 用法：__noriPetWidget.say('【happy】晚饭吃什么好呀~\n【think】嗯……想想')
  say(text) {
    try { speak(Array.isArray(text) ? text.join('\n') : String(text)) }
    catch (e) { console.error('[nori-pet] say', e) }
  },
  // 调试：单个情绪标签 + 一句话。用法：__noriPetWidget.sayTag('angry', '不许这样！')
  sayTag(tag, text) {
    this.say('【' + tag + '】' + text)
  },
  // 查看当前动作/表情/状态。用法：__noriPetWidget.motion()
  motion() {
    if (!model) return { loaded: false }
    try {
      const im = (model as any).internalModel
      const mm = im?.motionManager
      const st = mm?.state
      const cur = st && typeof st.currentIndex === 'number' && st.currentIndex >= 0
        ? { group: st.currentGroup, index: st.currentIndex,
            file: mm.definitions?.[st.currentGroup]?.[st.currentIndex]?.File ?? null }
        : null
      const reserve = st && typeof st.reservedIndex === 'number' && st.reservedIndex >= 0
        ? { group: st.reservedGroup, index: st.reservedIndex } : null
      const ex = mm?.expressionManager?.currentExpression
      return {
        loaded: true,
        motion: cur,        // 当前播放动作（group = Idle[0,2,3] / Sleep[0] / Reactions[0..12]）
        reserved: reserve,  // 排队待播的下一动作（如有）
        expression: ex && ex.File ? { file: ex.File, name: ex.Name ?? null } : null,
        sleeping, stroke, thinking, emotion: currentEmotion,
        figure: { girl: +figureValue.toFixed(2), q: +qfigureValue.toFixed(2) },
        speaking: !!(currentSrc || pumping || pendingTexts.length),
      }
    } catch (e) { return { loaded: true, error: String(e) } }
  },
}