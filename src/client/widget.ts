/**
 * Nori 桌宠 widget —— 宿主 tapIndex 注入的普通 <script>，自建 DOM（whale 插件同款机制）。
 * 特性：DPR 高清渲染 / 整窗拖动+记忆位置 / 句子级分段朗读（打断重排 + 音量驱动口型）/
 *       情绪联动（LLM 情绪标签或本地关键词 → 表情+动作）/ 思考表情（agent 工作中）/
 *       摸头反馈（长按摩擦触发台词）/ 睡眠状态机（90s 无交互入睡）/ 体型滑槽（少女/Q版）/
 *       穿透式画布 + 摸头热区（不挡页面文字选取）/ 气泡贴头（随体型/缩放比例定位）。
 * 依赖：bundle banner 内联的 live2dcubismcore.js（真实 core，先于本代码执行）。
 */
import * as PIXI from 'pixi.js'
import { SPEAK_MAX, spokenUnits, widthOf } from '../segmentation.js'
import { PREFIX } from '../protocol.js'
import { DEFAULT_MODEL_MAP, mergeModelMap, modelGaps, type ModelMap } from '../modelMap.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'
import type { Emotion } from '../emotions.js'
import { parseTaggedSentences } from '../speakText.js'
import type { TaggedSentence } from '../speakText.js'
import { createSpeakQueue } from '../speakQueue.js'
import { createTtsClient } from '../ttsClient.js'
import { emotionForAssistantText } from '../speakText.js'
import { planAssistantRoute } from '../turns.js'
import { createSleepTimer } from '../sleepTimer.js'
import { PAT_REPLIES, createPatDetector, inHeadZone } from '../patStroke.js'
import { createConfigPanel } from './configPanel.js'
import { SCALE_STEP, canvasSize as sizeFor, clampPos as clampPosTo, clampScale, defaultPos, stepScale, wheelScale } from '../clientLayout.js'
import { createWsClient } from '../wsClient.js'
import type { WsLike } from '../wsClient.js'
import { createBubbleQueue } from '../bubbleQueue.js'

import { createPlayback } from '../playback.js'
import type { AudioCtxLike } from '../playback.js'
import { createEmotionDriver } from '../emotionDriver.js'
import { parseClientEvent } from '../clientProtocol.js'
;(window as any).PIXI = PIXI

// 路由前缀来自 protocol.ts（与宿主、smoke-test 同一份）；宿主 hello 帧下发的 prefix 与之同源
// 口型驱动：ParamMouthOpenY（编辑器实测 = 张嘴 open 参数，运行时表情管道证实有效）。
// 关键时序：变形在 model.update()（csmUpdateModel）时按参数值计算，之后 setParameterValueById
// 只改存储不重算顶点 → 必须把口型写在 coreModel.update() 之前，让变形用我们的值。
let MOUTH_ID = DEFAULT_MODEL_MAP.mouthParam // 模型契约可覆盖（见 loadModelMap）
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

// 拖动改为"抓本体"：整块画布可拖，**但头部热区在它上面**（z-index 更高）→ 摸头优先，
// 头区域不算拖动区。原来的头顶小条会随身高移动、还能被推出屏幕，换掉。
const dragHandle = document.createElement('div')
dragHandle.id = 'nori-pet-body'
dragHandle.title = '拖动移动（双击归位）'
dragHandle.style.cursor = 'grab'

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
// 设置入口放浮动栏（与缩放/静音同一排）：右下角再挂一个齿轮会和浮栏抢位置
const btnCfg = document.createElement('button')
btnCfg.textContent = '⚙'
btnCfg.title = '设置'
controls.append(btnZoomOut, btnZoomIn, btnMute, btnCfg, btnClose)

// 体型面板（可开关）：Param158 少女体型 + Param117 Q版，各自 0..1 滑槽
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

// 摸头热区层：在 canvas 之上、但只占头部区域（20%~80% 宽、0~42% 高），
// root/canvas 本身 pointer-events:none 穿透 → 透明区域不挡文字选取
const hitZone = document.createElement('div')
hitZone.id = 'nori-pet-hit'
root.append(dragHandle, bubble, canvas, hitZone, controls, figureWrap)
// 层级：拖动条/按钮/面板浮于交互层之上，气泡中间
canvas.style.zIndex = '10'
hitZone.style.zIndex = '11'
dragHandle.style.zIndex = '10'
bubble.style.zIndex = '15'
controls.style.zIndex = '20'
figureWrap.style.zIndex = '20'
dragHandle.style.pointerEvents = 'auto'
// 必须有 position:absolute —— 静态定位下 top/bottom 全部无效，元素退化成 0 高度空块（实测 rect.height=0）
dragHandle.style.position = 'absolute'
// 拖动区必须撑满画布宽度：只有 top/bottom 没有 left/right 的话宽度为 0，等于抓不到（实测就是这个）
dragHandle.style.top = '0'
dragHandle.style.height = curH() + 'px'

/**
 * 拖动区几何：高度按画布，**宽度收窄到模型实测占位**（画布比模型宽，
 * 整块可拖会把大片透明区域也变成拦截层，挡文字选取）。
 */
function syncDragBox(hPx: number, topY: number): void {
  // 关键：画布可能比视口高得多（实测 756px 画布 / 只有 292px 在视口内）。
  // 按整块画布算高度 → 三分之二在屏幕外，能抓的只剩胸口到腰那一窄条。
  // 这里把拖动区裁到"画布的可见部分"：上沿取头顶，下沿取视口底。
  const rr = root.getBoundingClientRect()
  const topRel = Math.round(Math.min(Math.max(0, topY - 0.06 * hPx), hPx - 1))
  const visibleH = Math.max(0, Math.min(hPx, window.innerHeight - rr.top))
  dragHandle.style.top = topRel + 'px'
  dragHandle.style.height = Math.max(0, visibleH - topRel) + 'px'
  dragHandle.style.left = '25%'
  dragHandle.style.right = 'auto'
  dragHandle.style.width = '50%'
}
dragHandle.style.left = '0'
dragHandle.style.right = '0'
dragHandle.style.background = 'transparent'
controls.style.pointerEvents = 'auto'
figureWrap.style.pointerEvents = 'auto'
document.body.appendChild(root)

// ─── 位置：localStorage 记忆 + 拖动 ──────────────────────────────
const POS_KEY = 'nori-pet-pos'
const clampPos = (x: number, y: number): [number, number] => clampPosTo(x, y, window.innerWidth, window.innerHeight)
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
    const [dx, dy] = defaultPos(r.width, r.height, window.innerWidth, window.innerHeight)
    applyPos(dx, dy)
  } catch { /* ignore */ }
}
restorePos()

// ─── 缩放：＋/－按钮 + 滚轮，模型与面板同步缩放并记忆 ────────────
const SCALE_KEY = 'nori-pet-scale'
let scaleFactor = 1
try {
  const v = parseFloat(localStorage.getItem(SCALE_KEY) || '1')
  if (isFinite(v)) scaleFactor = clampScale(v)
} catch { /* ignore */ }
let baseScale = 0
let modelRatio = 1 // 模型原生宽高比（加载时一次性记录，避免运行时读取 0/NaN）
function curH(): number { return root.offsetHeight || LOGICAL_H }
/** 画布尺寸：高度按 LOGICAL_H×f（不随体型/Q版参数变化）；宽度 = 原贴合宽的 60%（更窄、去两侧空白） */
function canvasSize(): [number, number] {
  return sizeFor(scaleFactor, modelRatio, LOGICAL_W, LOGICAL_H)
}
function applyScale(f: number): void {
  // 通知外部（配置面板滑杆）同步；浮动 +/- 与滑杆必须是同一个值的两个入口
  try { window.dispatchEvent(new CustomEvent('nori-scale', { detail: scaleFactor })) } catch { /* 环境不支持事件 */ }
  scaleFactor = clampScale(f)
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
btnZoomIn.addEventListener('click', () => applyScale(stepScale(scaleFactor, SCALE_STEP)))
btnZoomOut.addEventListener('click', () => applyScale(stepScale(scaleFactor, -SCALE_STEP)))
// 滚轮缩放：绑在摸头热区 + 拖动条上（canvas 已穿透，不再接收事件）
const onWheel = (e: WheelEvent): void => {
  e.preventDefault()
  applyScale(wheelScale(scaleFactor, e.deltaY))
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
  // 双击本体 = 归位：拖到屏幕外时的保险，比再去找一根拖条可靠
dragHandle.addEventListener('dblclick', () => {
  // 不能靠清空内联样式"归位"：清掉后没有 right/bottom 兜底，元素会掉到 (0,0) 之外（实测跑到左下角外）
  // 正确做法是算出默认右下角坐标，再走 applyPos（它自带收边，效果与首次加载一致）
  const r = root.getBoundingClientRect()
  const w = r.width || canvasSize()[0]
  const h = r.height || curH()
  applyPos(Math.max(0, window.innerWidth - w - 12), Math.max(0, window.innerHeight - h - 12))
  try { localStorage.removeItem(POS_KEY) } catch { /* 存不了不影响归位 */ }
})
window.addEventListener('pointerup', () => {
  if (!dragging) return
    dragging = false
    // 松手时收边一次：把位置收进屏幕（含本地保存）
    const r = root.getBoundingClientRect()
    applyPos(r.left, r.top)
  })
}

// 播报结果统计：气泡出现 ≠ 有声音（合成失败/被宿主热重载打断时就是静默气泡）。
// 这三个数在 window.__noriPetWidget.diag().speak 里能直接看到，别靠猜。
const speakStats = { requested: 0, played: 0, skipped: 0, failed: 0 }

// ─── 气泡：每条独立淡出、同屏上限 6，策略在 src/bubbleQueue.ts（可单测）──
/** 上一条气泡实际渲染了几行（真机反馈，随 /api/speak 上报供对账） */
let lastBubbleLines = 0
const bubbles = createBubbleQueue<HTMLDivElement>({
  mount: (text) => {
    const bub = document.createElement('div')
    bub.className = 'bub'
    bub.textContent = text
    bubble.appendChild(bub)
    return bub
  },
  fade: (bub) => bub.classList.add('fading'),
  remove: (bub) => { try { bub.remove() } catch { /* 已被上层移除 */ } },
  // 数一下这条气泡实际占了几行：断句预算（SPEAK_MAX=34）是按"一行 17 个汉字"定的，
  // 行数是唯一能验证它的真机信号，报给宿主就能在 /api/status 里看到 34 是不是刚好两行。
  measureLines: (bub) => {
    try {
      const rect = bub.getBoundingClientRect()
      const cs = getComputedStyle(bub)
      const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.4
      const innerH = rect.height - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0)
        - (parseFloat(cs.borderTopWidth) || 0) - (parseFloat(cs.borderBottomWidth) || 0)
      return Math.max(1, Math.round(innerH / lh))
    } catch { return null }
  },
  retag: (bub, text) => { bub.textContent = text },
  onLines: (n) => { lastBubbleLines = n },
})
const showBubble = (text: string): HTMLDivElement => bubbles.show(text)

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
// 量 defaultHeadTop 当时的缩放：缩放变化后头顶距底要按比例重算，否则锚点还停在旧尺寸上（实测：缩放后按钮/拖动条/摸头热区全失位，刷新才对——刷新会重新量一次）
let headTopAtScale = 1

/**
 * 句子切分：统一走 src/segmentation.ts 的 spokenUnits（宿主与 widget 同一份实现，避免两套规则打架）。
 * 长度上限 = `SPEAK_MAX`（一行 17 个汉字 → 两行 34，用户实测给的精确值），词感知断点
 * （绝不在英文词/路径中间切），允许 ≤4 字溢出贴合自然断点。
 */
function splitSentences(text: string): string[] {
  return spokenUnits(text, SPEAK_MAX).map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * 合成缓存与单句请求在 src/ttsClient.ts（超时、204/503/超时话术、缓存命中都在那里可单测）。
 * 这里只把 widget 的运行时状态接进去。
 */
const tts = createTtsClient({
  basePath: PREFIX,
  unitsOf: (t) => widthOf(t),
  lines: () => lastBubbleLines,
  dropped: () => queue.dropped(),
  currentToken: () => playToken,
  onNotice: (msg) => showBubble(msg),
  log: (m) => console.warn(m),
})
const fetchTts = (text: string, token: number): Promise<ArrayBuffer | null> => tts.get(text, token)

/** 播放：解码/起播/口型/收尾在 src/playback.ts（token 作废、口型交还都有断言） */
const playback = createPlayback({
  getCtx: () => getCtx() as unknown as AudioCtxLike,
  isMuted: () => muted,
  currentToken: () => playToken,
  onMouth: (v) => { mouthTarget = v; if (v < 0) setMouth(0) }, // v<0 = 交还口型：立刻闭嘴，之后交给表情/呼吸
  onSourceChange: (src) => { currentSrc = src as AudioBufferSourceNode | null },
  raf: (fn) => { requestAnimationFrame(fn) },
  now: () => performance.now(),
})
const playBuffer = (buf: ArrayBuffer, token: number): Promise<void> => playback.play(buf, token)

/** 朗读：优先按【情绪】标签逐句（每句激活对应表情）；无标签文本回落 splitSentences 本地分类。
 * 预取策略：窗口内并行合成 ≤4 句；第一句就绪即打断当前播放入口、立即开播，播放中后台推进预取。 */
async function speakText(text: string, token: number): Promise<void> {
  const tagged = parseTaggedSentences(text)
  const useTagged = tagged.length > 0 && tagged.some((t) => t.emo !== null)
  let sentences: TaggedSentence[]
  if (useTagged) {
    // 标签行逐句；超长行按同一份断句规则子切（情绪沿用）
    sentences = []
    for (const t of tagged) {
      for (const unit of spokenUnits(t.text, SPEAK_MAX)) sentences.push({ text: unit, emo: t.emo })
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
    const emo = sentences[i].emo
    if (emo && !sleep.isSleeping()) setEmotion(emo) // LLM 情绪标签 → 逐句激活表情
    // 句首清场：表情切换可能残留嘴部参数，先归零再开播（保证口型从 0 跟随音量）
    try { (model as any).internalModel.coreModel.setParameterValueById(MOUTH_ID, 0, 1.0) } catch { /* ignore */ }
    const bub = showBubble(sentences[i].text)
    speakStats.requested += 1
    const buf = await fetchMap.get(i)!
    if (token !== playToken) break // 被打断：气泡留着（用户仍该看到这句话）
    if (!buf) {
      // 合成失败（sovits 未上线 / 超时 / 宿主热重载中）→ 气泡必须写清楚，别让它看着像正常播报
      speakStats.failed += 1
      bubbles.retag(bub, sentences[i].text + '（没读出来）')
      break
    }
    speakStats.played += 1
    await playBuffer(buf, token)
  }
}

// ─── 朗读队列：同 turn 的文本排队顺序读完，跨 turn 才打断 ───────
let activeTurn: string | null = null // 归一后的逻辑 turn（`12` 与 `12-sum` 视为同一轮）
// ─── 朗读队列（打断/追加/优先插入的排队策略在 src/speakQueue.ts，可单测）──
const queue = createSpeakQueue({
  speakOne: (text, token) => speakText(text, token),
  prewarm: (unit, token) => fetchTts(unit, token),
  hasCached: (unit) => tts.has(unit),
  currentToken: () => playToken,
  bumpToken: () => { playToken += 1 },
  stopCurrent: () => { if (currentSrc) { try { currentSrc.stop() } catch { /* ignore */ } currentSrc = null } },
  isMuted: () => muted,
  wake: () => wakeUp(),
  onDropped: (units) => { if (!muted) for (const u of units) showBubble(u) },
  onPreview: (unit) => showBubble(unit),
  log: (m) => console.info(m),
})
const speakInterrupt = (text: string): void => queue.interrupt(text)
const speakAppend = (text: string): void => queue.append(text)
/** 概括覆盖：丢掉尚未开播的细粒度排队，改成读这段概括（正在播的那句不打断） */
const speakReplace = (text: string): void => queue.replacePending(text)
const speakPriority = (text: string): void => queue.priority(text)
/** 兼容旧调用：独立触发（如打招呼）→ 打断重排 */
const speak = (text: string): void => queue.interrupt(text)

btnMute.addEventListener('click', () => {
  muted = !muted
  btnMute.textContent = muted ? '🔇' : '🔊'
  if (muted) { if (currentSrc) { try { currentSrc.stop() } catch { /* ignore */ } currentSrc = null } }
})

// ─── 情绪枢纽：文本 → 表情 + 动作联动（纯 widget 端，零 LLM 成本） ──
// Emotion 类型由 src/emotions.ts 的 EMOTIONS 元组派生（加情绪只改那一处）

/**
 * 情绪 → Live2D 表现：
 * expr = model3.json Expressions 的 Name；reaction = Motions.Reactions 组下标。
 * holdMs = 该情绪的最长驻留（毫秒），超时无新消息自行回落 default（防表情冻住）。
 * 标签→表情严格语义对应（happy=开心笑等）；口型独立于表情（cm.update 前置写 MouthOpenY）。
 * default = 纯待机：不应用表情（模型无 00_Default 表达式），直接回 Idle 0（00_Idle）。
 */
// 情绪 → 表情/动作表在 src/emotionDriver.ts（与驻留回落规则一起可单测）

// 关键词 → 情绪的分类器在 src/emotions.ts（纯逻辑，可在 node 里直接单测）

// ─── 情绪表现：表与规则在 src/emotionDriver.ts，这里只接模型操作 ──
const emotionDriver = createEmotionDriver({
  ready: () => !!model,
  sleeping: () => sleep.isSleeping(),
  patActive: () => pat.active(),
  speaking: () => !!currentSrc,
  applyExpression: (expr) => { model!.expression(expr) },
  playMotion: (group, index) => { model!.motion(group, index) },
  resetExpression: () => {
    const em = (model as any).internalModel.motionManager.expressionManager
    if (em?.resetExpression) em.resetExpression()
  },
  playIdle: () => { model!.motion(MAP.idleGroup, 0) },
  log: (m, err) => console.warn(m, err ?? ''),
  table: () => MAP.emotions,
})
const setEmotion = (e: Emotion, opts?: { force?: boolean; forceReaction?: boolean; noReaction?: boolean }): void => emotionDriver.set(e, opts)
const setThinking = (on: boolean): void => emotionDriver.setThinking(on)

// ─── 模型契约（nori.config.json 的 model 段，宿主经 /api/model-map 下发） ──
// 拿不到就用 Nori 默认值：本机行为与重构前一致；换模型只需改配置，不用重编译 widget。
let MAP: ModelMap = DEFAULT_MODEL_MAP
async function loadModelMap(): Promise<void> {
  try {
    const r = await fetch(PREFIX + '/api/model-map')
    if (r.ok) MAP = mergeModelMap(await r.json())
    else console.warn('[nori-pet] /api/model-map 返回', r.status, '，沿用默认模型映射')
  } catch (err) {
    console.warn('[nori-pet] 读取模型映射失败，沿用默认（Nori）', err)
  }
  MOUTH_ID = MAP.mouthParam
  // 供设置面板预填情绪映射（面板用它兜底，避免配置里没有 model 段时表格全空）
  ;(window as unknown as { __noriModelMap?: unknown }).__noriModelMap = MAP
  const gaps = modelGaps(MAP)
  if (gaps.length) {
    // 缺资源不是错误：这些情绪只会没有表情/动作，气泡与声音照常
    console.warn('[nori-pet] 模型缺这些情绪的可视资源（仅影响表情）:', gaps.join(','))
  }
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

/**
 * 禁用 Live2D 模型的 pixi 层命中测试（v6/v7 版本混装兼容垫片，见 startModel 注释）。
 * v6 DisplayObject 的 isInteractive 是 getter 属性（原型上无 setter、严格模式赋值会抛错），
 * 故用 Object.defineProperty 定义自有属性覆盖；interactive/interactiveChildren 一并关掉，
 * 让 v7 EventBoundary 在进入模型子树前就短路，指针移动不再崩溃。
 */
function disableLive2DHitTest(m: any): void {
  const fix = (o: any): void => {
    if (!o || typeof o !== 'object') return
    try { Object.defineProperty(o, 'isInteractive', { value: () => false, configurable: true }) } catch { /* ignore */ }
    try { o.interactive = false } catch { /* ignore */ }
    try { o.interactiveChildren = false } catch { /* ignore */ }
  }
  const walk = (o: any): void => {
    fix(o)
    for (const c of o.children ?? []) walk(c)
  }
  walk(m)
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
    await loadModelMap()
    let m: any
    try {
      m = await Live2DModel.from(PREFIX + '/' + MAP.modelPath, {
        autoInteract: false,
        motionPreload: 'none' as any, // 库类型枚举与实际运行值不一致，运行时行为正确
      })
    } catch (err) {
      // 纸片人模式：模型是第三方 IP，克隆者可能没有。气泡 + 声音与模型无关，必须还能用。
      console.warn('[nori-pet] Live2D 模型未加载（' + MAP.modelPath + '），进入纸片人模式：气泡与语音正常，表情/动作不可用', err)
      return
    }
    model = m
    // pixi-live2d-display@0.4 的 peerDeps 是 @pixi/* v6，而本 bundle 的 EventBoundary 来自 pixi.js v7：
    // v6 对象把 isInteractive 当作布尔属性，v7 命中测试按方法调用 → 指针移到画布即抛
    // "currentTarget.isInteractive is not a function"（console 刷屏）。桌宠交互全部走 DOM 热区
    // （hitZone），pixi 层不需要任何命中测试 → 把挂到舞台的 v6 模型子树统一降级为不可交互。
    disableLive2DHitTest(m as any)
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
    app.stage.addChild(m as any)
    // 应用记忆的缩放因子（resize + scale + 居中）
    applyScale(scaleFactor)
    // 一次性测量默认头顶高度（此时 scale 已是最终比例；失败则按比例估算兜底）
    try {
      const im = (m as any).internalModel
      const cm2 = im.coreModel
      const n = cm2.getDrawableCount()
      let minY = Infinity
        let minX = Infinity
        let maxX = -Infinity
      for (let i = 0; i < n; i++) {
        if ((cm2.getDrawableOpacity(i) ?? 1) < 0.02) continue
        const vs = im.getDrawableVertices(i)
        for (let j = 1; j < vs.length; j += 2) {
          const y = vs[j]
          if (y < minY) minY = y
          const x = vs[j - 1]
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
      }
      if (isFinite(minY)) defaultHeadTop = curH() - minY
    } catch { /* ignore */ }
    if (defaultHeadTop < 0) defaultHeadTop = Math.round(0.9 * curH())
      headTopAtScale = scaleFactor
    // 统一动画帧：摸头摩擦头部跟随（被揉反馈） + UI 贴头定位
    const tick = (): void => {
      if (stopRender) return
      try {
        const core = (model as any).internalModel.coreModel
        // 摸头反馈（被揉感加强）：头部大幅跟随鼠标、跟手更快；松手/睡觉回中
        strokeHead.sx += ((pat.active() ? strokeHead.x : 0) - strokeHead.sx) * 0.25
        strokeHead.sy += ((pat.active() ? strokeHead.y : 0) - strokeHead.sy) * 0.25
        const sc = sleep.isSleeping() ? 0 : 1
        core.setParameterValueById('ParamAngleX', strokeHead.sx * 24 * sc, 1.0) // 转头 ±24°
        core.setParameterValueById('ParamAngleY', strokeHead.sy * 18 * sc, 1.0) // 点头 ±18°
        core.setParameterValueById('ParamAngleZ', strokeHead.sx * 14 * sc, 1.0) // 歪头 ±14°
        // 兜底：揉头期间每帧无条件停掉一切动作（idle/reaction 的头部曲线任何时刻都会被清掉，
        // 不依赖偏差检测——快速连续揉动也不会被 fade 中的动作拽走头部）
        if (pat.active() && performance.now() - strokeDownAt > 120) {
          try { ;(model as any).internalModel.motionManager.stopAllMotions() } catch { /* ignore */ }
        }
        // UI 锚定模型头顶（纯比例，无扫描无浮动）；相对 canvas 顶部（top 坐标系）+ 气泡 bottom 定位：
        // 头顶离画布顶 topY = 画布高 - (头顶距底部)；按钮 topY-16k、拖动条 -36k、面板 -68k（k=1/缩放），
        // 气泡 bottom = 头顶距底 + 60k（新气泡贴头、旧话向上推）；热区顶 = 头顶上方 6% 画布高
        if (defaultHeadTop > 0) {
          const ratio = Math.max(0.6, 1 - 0.05 * figureValue - 0.30 * qfigureValue)
          // 头顶距底随整体缩放线性变化：以测量时的缩放为基准换算
      const ht = Math.round(defaultHeadTop * (scaleFactor / headTopAtScale) * ratio)
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
        syncDragBox(hPx, topY)
        }
      } catch { /* ignore */ }
      requestAnimationFrame(tick)
    }
    tick()
    // ── 苏醒流程：初始呈现睡眠（Sleep 组 00_Sleep）→ 首次点击页面后醒来打招呼（手势解锁音频，语音才能出声）→ 微笑驻留超时回落纯 idle ──
    sleep.markSleeping() // 初始睡眠态（不排入睡计时，唤醒后 reset 自然接管）
    playSleepMotion() // 00_Sleep（原版 Idle 组内成员：指定 index 播放 + 置永续 loop）
    const GREETING = '你回来啦！Nori真的等你好久了呀......这里一下子又暖起来了。'
    let greetingDone = false
    function greetOnce(): void {
      if (greetingDone) return
      greetingDone = true
  // 正在播报 turn 时不打招呼：打招呼是"见面第一句"，插进播报里既打断内容又重复
  if (currentSrc || queue.busy()) { wakeUp(); return }
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

/** 协议分发：字段解析在 src/clientProtocol.ts（turn 两形态/emote 白名单/空文本都有断言） */
function handleWsMessage(raw: string, reply: (data: string) => void): void {
  const ev = parseClientEvent(raw)
  if (!ev) return
  lastMsg = raw.slice(0, 120)
  reply(JSON.stringify({ type: 'ack' }))
  switch (ev.kind) {
    case 'approval':
      // 权限申请提醒：打断当前朗读优先播报（原文，提醒用户回来处理）
      lastSpeak = ev.text.slice(0, 60)
      activeTurn = null
      setThinking(false)
      setEmotion('surprised') // 惊一下：权限申请需要用户注意
      speakInterrupt(ev.text)
      return
    case 'assistant': {
      lastSpeak = ev.text.slice(0, 60)
      setThinking(false) // 有输出了，思考态结束
      // 情绪联动：优先 LLM 情绪标签（首句）；普通句只有命中关键词才切情绪——无情绪句
      // 不打断当前表情（驻留由 emotionDriver 统一管理，避免逐句推流把表情秒打回 default）
      const emo = emotionForAssistantText(ev.text)
      if (emo) setEmotion(emo)
      // turn 身份：改写路径给数字 12，概括路径给字符串 12-sum —— 归一化在 planAssistantRoute 里，
      // 同一轮的话排队而不是抢断（早先按 typeof number 判断，概括那批会打断自己）
      const route = planAssistantRoute(activeTurn, ev.turn)
      activeTurn = route.base
      if (route.action === 'replace') speakReplace(ev.text)
      else if (route.action === 'append') speakAppend(ev.text)
      else speakInterrupt(ev.text)
      return
    }
    // 思考表情：agent 工作中（用户发言 / 工具调用）→ 沉思；turn 结束回收
    case 'user':
      sleep.setTurnActive(true) // turn 激活：清入睡计时（turn 未结束不入睡）
      wakeUp() // 用户开口即唤醒，不等到第一句回答
      setThinking(true)
      return
    case 'tool': setThinking(true); return
    case 'turn-end':
      sleep.setTurnActive(false) // turn 结束：入睡计时此刻才开始
      setThinking(false)
      resetSleepTimer()
      return
    // emote：宿主 /api/emote 手动触发（验证情绪联动用）
    case 'emote':
      if (ev.emotion) { setThinking(false); setEmotion(ev.emotion) }
      if (ev.text) { activeTurn = null; speakInterrupt(ev.text) }
      return
    default: return
  }
}

// ─── WebSocket：传输/重连/自愈在 src/wsClient.ts（后台不重连、回前台补连、周期兜底都有断言）──
let lastMsg = ''
let lastSpeak = ''
const ws = createWsClient({
  url: () => (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + PREFIX + '/ws',
  create: (url) => new WebSocket(url) as unknown as WsLike,
  hello: () => JSON.stringify({ type: 'hello', sessionId: '' }),
  onMessage: (raw, reply) => handleWsMessage(raw, reply),
  isHidden: () => document.hidden,
  onConnectError: () => showBubble('（无法连接宿主）'),
  log: (m) => console.warn(m),
})
ws.connect()
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  wakeUp() // 回到桌面先醒（用户回来看到的就是待机态）
  ws.ensure() // hidden 期间断掉的连接在此补上
})
setInterval(() => ws.ensure(), 15000) // 周期自愈：宿主重启 / 长连接被服务端回收等兜底

let hidden = false
btnClose.addEventListener('click', () => {
  hidden = !hidden
  root.style.visibility = hidden ? 'hidden' : 'visible'
  btnClose.textContent = hidden ? '◉' : '✕'
  setRendering(!hidden)
})

// ─── 摸头（按住+拖动摩擦触发）：长按摩擦一小会才说台词（台词绑定情绪）；
//      摩擦途中头部轻微跟随（被揉反馈）；音效接口留占位（找到音源后接入）。
// ─── 摸头：触发判定与台词表在 src/patStroke.ts（按住时长/拖动距离/冷却都有断言）──
const pat = createPatDetector()
const strokeHead = { x: 0, y: 0, sx: 0, sy: 0 } // 目标 + 平滑跟踪（tick 里 lerp，松手回中）
let strokeDownAt = 0

function canvasPos(e: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect()
  return rect.width ? [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height] : [0.5, 1]
}

/** 触发摸头台词：切表情（不播 reaction 动作，否则头部曲线会覆盖揉头跟随）+ 优先插播 */
function sayPat(): void {
  wakeUp()
  const p2 = PAT_REPLIES[Math.floor(Math.random() * PAT_REPLIES.length)]
  setEmotion(p2.emo, { force: true, noReaction: true })
  speakPriority(p2.text) // 摸头台词优先插入：不截断正在排队等待的朗读文本
}

/** 摩擦开始：停掉待机动作（00_Idle 的曲线每帧覆盖 ParamAngleX/Y/Z，头部交给揉头参数驱动） */
function startStroke(): void {
  strokeDownAt = performance.now() // 揉头 120ms 后再每帧强停动作（见 tick）
  try { (model as any).internalModel.motionManager.stopAllMotions() } catch { /* ignore */ }
}

function endStroke(): void {
  if (!pat.active()) return
  pat.end()
  // 恢复待机动作（idle 或睡眠闭眼），头部控制权交还原动作；睡眠恢复用 FORCE（同 NORMAL 守卫）
  if (sleep.isSleeping()) {
    const t = sleepMotionTarget()
    if (t && model) { try { model.motion(t.group, t.index, 3) } catch { /* ignore */ } }
    ensureSleepLoop()
  } else if (model) { try { model.motion('Idle', 0) } catch { /* ignore */ } }
}
hitZone.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || pat.active()) return
  const [x, y] = canvasPos(e)
  if (!inHeadZone(x, y)) return
  startStroke()
  pat.start(performance.now(), e.clientX, e.clientY)
  try { hitZone.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  wakeUp()
})
window.addEventListener('pointermove', (e) => {
  if (!pat.active()) return
  const [x, y] = canvasPos(e)
  const r = pat.move(x, y, e.clientX, e.clientY, performance.now())
  strokeHead.x = r.headX
  strokeHead.y = r.headY
  if (r.speaks) sayPat()
})
const endStrokeP = (): void => endStroke()
window.addEventListener('pointerup', endStrokeP)
window.addEventListener('pointercancel', endStrokeP)

// ─── 睡觉状态机：N 分钟无交互 → 播 Sleep 组 00_Sleep；任何交互/朗读 → 唤醒 ──
let lastMoveActivity = 0
let lastMoveX = -1
let lastMoveY = -1
// 交互监听：桌宠区域的操作算"活动"；鼠标快速划过（位移 <15px）不误唤醒
root.addEventListener('pointerdown', () => wakeUp())
root.addEventListener('wheel', () => wakeUp(), { passive: true })
root.addEventListener('pointermove', (e) => {
  // 睡眠中悬停不算交互唤醒（仅点击/滚轮/朗读唤醒）——否则鼠标路过/停在头部区域就会误唤醒睁眼
  if (sleep.isSleeping()) return
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
/** 播入睡动作（Idle 组内的睡眠动作）+ 加载完成后置真循环。
 * 必须用 MotionPriority.FORCE(=3)：goSleep 前 setEmotion('default') 会先播 Idle(NORMAL=2)，
 * 库的 reserve 守卫 `priority <= currentPriority` 会拒绝同优先级的睡眠动作 → 从未播放
 * （sleeping=true 但动作停留在 Idle）。FORCE 绕过守卫必定切入睡姿。 */
function playSleepMotion(): void {
  try {
    const t = sleepMotionTarget()
    if (!t || !model) return
    const p = model.motion(t.group, t.index, 3) // MotionPriority.FORCE
    if ((p as any)?.then) (p as any).then(ensureSleepLoop)
    // 一次性兜底（仅入睡这一刻，非 per-frame）：00_Sleep 时长 3s，若 loop 因任何原因
    // 未设置成功（播完回落 idle 池睁眼），3.5s 后复查当前动作并 FORCE 重播。
    window.setTimeout(() => {
      try {
        const t2 = sleepMotionTarget()
        const mm = (model as any)?.internalModel?.motionManager
        const active = !!t2 && !!mm?.state && mm.state.currentGroup === t2.group
        if (sleep.isSleeping() && t2 && model && !active) {
          const p2 = model.motion(t2.group, t2.index, 3)
          if ((p2 as any)?.then) (p2 as any).then(ensureSleepLoop)
        }
      } catch { /* ignore */ }
    }, 3500) as unknown as number
  } catch { /* ignore */ }
}

// 入睡计时与状态在 src/sleepTimer.ts（turn 未结束不睡、朗读中不睡、假醒防御都在那里有断言）。
// 这里只提供"怎么睡、怎么醒"的模型动作。
const sleep = createSleepTimer({
  canSleep: () => !!model && !currentSrc && !queue.busy(),
  onSleep: () => {
    if (emotionDriver.current() !== 'default') setEmotion('default') // 睡前清表情，防带嘴/带眼的残留睁眼
    playSleepMotion()
    showBubble('唔……Nori要睡着了。')
  },
  onWake: (wasSleeping) => {
    if (!model) return
    if (!wasSleeping) {
      // 假醒防御：逻辑已醒，但画面可能仍卡在睡眠动作（FORCE 循环未被清掉）→ 强制切回待机
      const t = sleepMotionTarget()
      const mm = (model as any).internalModel.motionManager
      if (t && mm?.state && mm.state.currentGroup === t.group) {
        try { mm.stopAllMotions() } catch { /* ignore */ }
        try { model.motion('Idle', 0) } catch { /* ignore */ }
      }
      return
    }
    // 真醒：必须先清空动作队列 —— 00_Sleep 被置为永续 loop，直接 motion('Idle',0) 会被同级
    // 覆盖检查拒绝 → 动作永远卡在睡姿
    try { (model as any).internalModel.motionManager.stopAllMotions() } catch { /* ignore */ }
    try { model.motion('Idle', 0) } catch { /* ignore */ }
    setEmotion('default') // 睡醒回纯 idle
  },
})
const resetSleepTimer = (): void => sleep.reset()
const wakeUp = (): void => sleep.wake()


initLive2D()

;(window as any).__noriPetWidget = {
  /** 诊断：当前生效的模型契约（换模型没反应时先看这个） */
  modelMap: () => ({ path: MAP.modelPath, mouth: MAP.mouthParam, idle: MAP.idleGroup, gaps: modelGaps(MAP), loaded: !!model }),
  /** 配置面板的即时预览入口（松手才写配置，见 configPanel） */
  setScale: (f: number) => applyScale(f),
  /** 体型（少女 Param158 / Q版 Param117）读写：设置面板里的滑杆直接用 */
  getFigure: () => ({ girl: figureValue, chibi: qfigureValue }),
  setFigure: (kind: "girl" | "chibi", v: number) => {
    const clamped = Math.max(0, Math.min(1, v))
    if (kind === 'girl') figureValue = clamped
    else qfigureValue = clamped
  },
  /** 当前缩放：面板滑杆要跟浮动按钮共用同一个值，不能各存一份 */
  getScale: () => scaleFactor,
  setVolume: (v: number) => { (window as any).__noriPetVolume = Math.max(0, Math.min(1, v)) },
  /** 打开设置面板（齿轮按钮同款） */
  openConfig: () => configPanel.open(),
  root, showBubble, speak,
  get model() { return model },
  diag: () => ({ speak: { ...speakStats }, wsState: ws.healthy() ? 1 : -1, wsRetry: ws.retries(), muted, lastMsg, lastSpeak, scale: scaleFactor,
    pos: root.style.left || root.style.right, top: root.style.top || root.style.bottom }),
  // 调试：让 Nori 说一段带标签的句子（完整走朗读 + 情绪标签链路）。
  // 用法：__noriPetWidget.say('【happy】晚饭吃什么好呀~\n【think】嗯……想想')
  say(text: string | string[]) {
    try { speak(Array.isArray(text) ? text.join('\n') : String(text)) }
    catch (e) { console.error('[nori-pet] say', e) }
  },
  // 调试：单个情绪标签 + 一句话。用法：__noriPetWidget.sayTag('angry', '不许这样！')
  sayTag(tag: string, text: string) {
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
        sleeping: sleep.isSleeping(), stroke: pat.active(), thinking: emotionDriver.isThinking(), emotion: emotionDriver.current(),
        figure: { girl: +figureValue.toFixed(2), q: +qfigureValue.toFixed(2) },
        speaking: !!(currentSrc || queue.busy()),
      }
    } catch (e) { return { loaded: true, error: String(e) } }
  },
}

/** 齿轮 + 设置面板：宿主后端已就绪（GET/POST /api/config、/api/model/probe） */
const configPanel = createConfigPanel(PREFIX)
btnCfg.addEventListener('click', () => configPanel.toggle())
