/**
 * 桌宠布局换算：位置收边、缩放档位、画布尺寸。
 *
 * 从 src/client/widget.ts 搬出。这些纯算术里藏着两个已经踩过的坑：
 *  1) **默认位置必须落在 left/top 坐标系**：CSS 的 right/bottom 与 top 竞争会把垂直拖动钉死
 *     （曾经"只能左右拖、上下拖不动"）；
 *  2) 尺寸变化后要把位置重新收进屏幕，且边缘留 12px 可抓回，左侧/上方允许略微出屏（-80）。
 */
export const MIN_SCALE = 0.4
export const MAX_SCALE = 4.0
/** 按钮一次缩放的步进 */
export const SCALE_STEP = 0.15
/** 滚轮一次缩放的比例 */
export const WHEEL_FACTOR = 1.1
/** 收边时保留的边缘像素（保证还能抓回来） */
export const EDGE_PX = 12
/** 允许出屏的上限（负向），避免完全拖出视野后再也点不到 */
export const OVERHANG_PX = 80

export function clampScale(v: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

export function clampPos(x: number, y: number, vw: number, vh: number): [number, number] {
  const maxX = Math.max(0, vw - EDGE_PX)
  const maxY = Math.max(0, vh - EDGE_PX)
  return [Math.min(Math.max(-OVERHANG_PX, x), maxX), Math.min(Math.max(-OVERHANG_PX, y), maxY)]
}

/** 无记忆时的默认位置：右下角（与 CSS 初始视觉一致，但落在 left/top 坐标系） */
export function defaultPos(rootW: number, rootH: number, vw: number, vh: number): [number, number] {
  return [Math.max(0, vw - rootW - EDGE_PX), Math.max(0, vh - rootH - EDGE_PX)]
}

export function stepScale(cur: number, delta: number): number {
  return clampScale(cur + delta)
}

export function wheelScale(cur: number, deltaY: number): number {
  return clampScale(cur * (deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR))
}

/**
 * 画布尺寸：高度按 logicalH×f（不随体型/Q版参数变化）；宽度取"按比例贴合"与"逻辑宽×f"
 * 的较小者（去两侧空白，画布窄 = 两边裁边，不把模型等比压小）。
 */
export function canvasSize(f: number, modelRatio: number, logicalW: number, logicalH: number, min = 48): [number, number] {
  const h = Math.max(min, Math.round(logicalH * f))
  const wFull = Math.max(min, Math.round(h * modelRatio))
  const wMax = Math.max(min, Math.round(logicalW * f))
  return [Math.min(wFull, wMax), h]
}
