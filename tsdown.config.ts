import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

// Nori 桌宠插件仓库根（tsdown.config.ts 位于仓库根，用它推导所有相对路径）
const REPO_ROOT = dirname(fileURLToPath(import.meta.url))
const SHIM = join(REPO_ROOT, 'src/client/url-shim.ts')

// live2dcubismcore.js（widget bundle banner 内联）：探测仓库内 cubism_sdk/Core
// （资产约定在仓库内；install.ps1 会自动下载官方 CDN 到该位置）。
function resolveCoreFile(): string {
  const probe = join(REPO_ROOT, 'cubism_sdk', 'Core', 'live2dcubismcore.js')
  if (existsSync(probe)) return probe
  throw new Error('live2dcubismcore.js not found — run install.ps1 first (it auto-downloads the official core into cubism_sdk/Core/)')
}

// Nori 桌宠 widget：宿主通过 tapIndex 注入 <script src=".../widget.js">，
// 本 bundle 是**普通浏览器脚本**（IIFE），不经过 ModuleLoader，也没有外部依赖。
const widgetBundle: UserConfig = {
  entry: { widget: 'src/client/widget.ts' },
  outDir: 'lib',
  format: 'iife',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  // pixi-live2d-display / @pixi/utils 的 ESM 入口 import 'url'（Node 内置）——浏览器里没有它，
  // alias 到本地 shim（含 resolve/parse/format 的浏览器安全实现）。
  alias: {
    url: SHIM,
    'node:url': SHIM,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  // 把所有依赖（pixi / live2d / eventemitter …）全部打进单文件，无外部 require。
  deps: {
    neverBundle: [],
  },
  // pixi-live2d-display/cubism4 在模块求值时就检查 window.Live2DCubismCore —— 把真实
  // live2dcubismcore.js 内联进 banner（先于 bundle 代码执行、在页面作用域定义全局），
  // guard 直接通过，无需运行时动态注入。
  banner: readFileSync(resolveCoreFile(), 'utf8'),
  outputOptions: {
    entryFileNames: 'widget.js',
    codeSplitting: false,
  },
}

export default [widgetBundle] satisfies UserConfig[]