#requires -Version 5.1
<#
.SYNOPSIS
  One-click installer for the Nori desktop-pet plugin (@dsh-external/dsh-nori-pet)
  using the official dsh plugin API.

.DESCRIPTION
  配置外置：所有业务配置（模型/语音/GPT-SoVITS）从 nori.config.json 读取（模板
  nori.config.example.json，本机 nori.config.json 含机器路径、不入库）。留空则全部
  走默认约定（探测仓库内 Nori_web/、voice/；Live2D Core 自动下载官方 CDN）。

  流程：读配置 -> 探测模型 + core（自动下载）-> 构建（-SkipBuild 跳过）-> 无空格
  junction 暂存（dsh plugin 经 cmd.exe 转发，路径含空格会被拆断，故 %LOCALAPPDATA%
  \dsh-links\dsh-nori-pet）-> `dsh plugin add link:<junction>`（官方安装依赖并登记
  bundles）-> 把运行时配置写入 profile 的 cordis.patch.yml（Loader PatchOptions：
  顶层 `- id:` + `config:`；官方 overlay 机制，不碰 cordis.yml）。

  末尾汇总语音可用性：未配置 GPT-SoVITS 时跳过并提示（可 .\install-sovits.ps1
  一键部署，或用已有部署填 nori.config.json 的 sovits 段）。

.PARAMETER Profile
  Target dsh profile name. Default web.

.PARAMETER SkipBuild
  Skip the build step (if already built).

> Live2D Cubism Core（live2dcubismcore.js）对所有用户是同一官方文件：仓库内不存在时
> 自动从官方 CDN 下载（cubism.live2d.com/sdk-web/cubismcore/），无需任何参数。
> Python 仅用于 GPT-SoVITS（api.py 9880 + ttsWatch 拉起），版本需 3.9~3.11，见 install-sovits.ps1。

.EXAMPLE
  .\install.ps1

.EXAMPLE
  # 自定义模型/语音/GPT-SoVITS：编辑 nori.config.json 后
  .\install.ps1
#>
param(
  [string]$Profile = 'web',
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'

$Repo     = $PSScriptRoot
$Pkg      = '@dsh-external/dsh-nori-pet'
$PkgShort = 'dsh-nori-pet'
$DshHome  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfRoot = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path $ProfRoot)) { throw "profile not found: $ProfRoot (use -Profile)" }

# ---- 0) load nori.config.json（配置外置；文件缺失/损坏则全部走默认约定）----
$ConfigPath = Join-Path $Repo 'nori.config.json'
$cfgFile = @{}
if (Test-Path $ConfigPath) {
  try { $cfgFile = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { Write-Warning "nori.config.json 解析失败，按默认约定继续：$($_.Exception.Message)" }
}
$ModelDir  = [string]$cfgFile.modelDir
$RefAudio  = [string]$cfgFile.refAudio
$RefPrompt = if ([string]$cfgFile.refPrompt) { [string]$cfgFile.refPrompt } else { '你好,初次见面,我的名字是Nori' }
$TtsUrl    = if ([string]$cfgFile.ttsUrl)    { [string]$cfgFile.ttsUrl }    else { 'http://127.0.0.1:9880/tts' }
$GsvBase   = [string]$cfgFile.sovits.gsvBase
$VenvPy    = [string]$cfgFile.sovits.venvPy
$SovitsConfigured = ($GsvBase -ne '') -or ($VenvPy -ne '')

# 无空格 staging path（dsh plugin -> pnpm 经 cmd.exe 转发，含空格的绝对路径会被拆断）
$StagingLink = Join-Path $env:LOCALAPPDATA 'dsh-links\dsh-nori-pet'

function Write-U8($Path, $Content) {
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

# ---- 1) resolve model / core ----------------------------------------------
# 资产约定：模型/语音放仓库内占位目录（Nori_web/、voice/）；Live2D Core 是官方通用文件，
# 仓库内不存在时自动下载官方 CDN（live2dcubismcore.min.js -> cubism_sdk/Core/live2dcubismcore.js）。
$ModelGiven = ($ModelDir -ne '')
if (-not $ModelDir) {
  $probe = Join-Path $Repo 'Nori_web'
  if (Test-Path (Join-Path $probe 'Nori.model3.json')) { $ModelDir = $probe }
}
if (-not $ModelDir -or -not (Test-Path (Join-Path $ModelDir 'Nori.model3.json'))) {
  throw "model dir unavailable (nori.config.json modelDir 或仓库内 Nori_web)：$ModelDir"
}
# 模型完整性校验（只查不改，保证安装效果一致）：只适配原版 Nori_web——睡眠动作
# 00_Sleep 在 Idle 组（idle 池一员），缺失时睡眠会退化（不出错但不闭眼），提示换回原版。
try {
  $m3 = Get-Content (Join-Path $ModelDir 'Nori.model3.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $idleNames = @($m3.FileReferences.Motions.Idle | ForEach-Object { [IO.Path]::GetFileName($_.File) })
  if (-not (($idleNames -match 'Sleep|EyeClosed').Count -gt 0)) {
    Write-Warning '模型 Idle 组缺少睡眠动作（00_Sleep/EyeClosed）；睡眠会退化，请使用 Nori_web 原版模型'
  }
} catch { /* 校验失败不阻断 */ }
$CoreFile = Join-Path $Repo 'cubism_sdk\Core\live2dcubismcore.js'
if (-not (Test-Path $CoreFile)) {
  Write-Host '==> live2dcubismcore.js 缺失，从官方 CDN 下载（所有用户同一官方文件）...'
  New-Item -ItemType Directory (Split-Path $CoreFile) -Force | Out-Null
  try {
    Invoke-WebRequest -Uri 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js' -OutFile $CoreFile -UseBasicParsing -TimeoutSec 90
  } catch {
    Remove-Item $CoreFile -Force -ErrorAction SilentlyContinue
    throw "Live2D Core 自动下载失败（需要网络/代理，可手动放入仓库 cubism_sdk\Core\ 后重跑）：$($_.Exception.Message)"
  }
  if ((Get-Item $CoreFile).Length -lt 50000) {
    throw "Live2D Core 下载内容异常（<50KB，疑似错误页）：$CoreFile"
  }
  Write-Host "    core downloaded: $CoreFile"
}
# 写入 patch 的值：模型显式传参原样（可为绝对）；缺省探测命中则写相对仓库根的值（发布友好）。
$CfgModel = if ($ModelGiven) { $ModelDir } else { 'Nori_web' }
$CfgCore  = 'cubism_sdk\Core\live2dcubismcore.js'
Write-Host "model : $ModelDir"
Write-Host "core  : $CoreFile"
if ($RefAudio) { Write-Host "audio : $RefAudio" } else { Write-Host 'audio : (empty -> GPT-SoVITS server default voice)' }

# ---- 2) build --------------------------------------------------------------
if (-not $SkipBuild) {
  Write-Host '==> [1/3] build host (tsc -> lib/index.js)'
  if (-not (Test-Path (Join-Path $Repo 'node_modules\typescript'))) {
    Write-Host 'node_modules/typescript missing; running npm ci (needs registry access)...'
    Push-Location $Repo
    try { & npm ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' } } finally { Pop-Location }
  }
  Push-Location $Repo
  try {
    & node 'node_modules\typescript\lib\tsc.js' -p tsconfig.json
    if ($LASTEXITCODE -ne 0) { throw 'host build failed' }
  } finally { Pop-Location }

  Write-Host '==> [2/3] build client (npm run build:client -> lib/widget.js, Core inlined)'
  Push-Location $Repo
  try {
    & npm run build:client
    if ($LASTEXITCODE -ne 0) { throw 'client build failed' }
  } finally { Pop-Location }
}

# ---- 3) official install via dsh plugin ------------------------------------
Write-Host '==> [3/3] dsh plugin add (official API)'
$linksDir = Split-Path $StagingLink -Parent
New-Item -ItemType Directory -Path $linksDir -Force | Out-Null
if (Test-Path $StagingLink) {
  $st = Get-Item $StagingLink -Force
  if ($st.LinkType -ne 'Junction' -or $st.Target -ne $Repo) {
    throw "staging link exists but not pointing at this repo: $StagingLink"
  }
} else {
  New-Item -ItemType Junction -Path $StagingLink -Target $Repo | Out-Null
  Write-Host "staging link created: $StagingLink"
}

# idempotent: if already installed, `add` just reports "Already up to date"
& dsh plugin --profile $Profile add "link:$StagingLink"
if ($LASTEXITCODE -ne 0) { throw 'dsh plugin add failed (see output above)' }

# ---- 4) runtime config overlay (profile/cordis.patch.yml, loader update) ----
Write-Host '==> [3b] write runtime config overlay (cordis.patch.yml)'
$patchPath = Join-Path $ProfRoot 'cordis.patch.yml'
$content   = ''
if (Test-Path $patchPath) { $content = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8) }

$blocks = @($content -split '(?m)^(?=- )' | Where-Object { $_.Trim() -ne '' })
$keep   = @($blocks | Where-Object { $_ -notmatch 'dsh-nori-pet' })
$keep   = @($keep | ForEach-Object { $_ -replace '(?m)^\s*\[\s*\]\s*$', '' } | Where-Object { $_.Trim() -ne '' })

# 语音默认目录约定（发布友好，不依赖任何旧数据）：未配置 refAudio 时，
# 探测仓库内 voice/ 目录的第一个 wav（与 Nori_web、cubism_sdk、GPT-SoVITS 同一套约定），
# 命中即写相对路径；未命中才退回服务端默认音色。
if (-not $RefAudio) {
  $voiceDir = Join-Path $Repo 'voice'
  $wav = Get-ChildItem $voiceDir -Filter *.wav -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($wav) {
    $RefAudio = 'voice\' + $wav.Name
    Write-Host "audio : (voice/ 约定目录) $RefAudio"
  } else {
    Write-Host 'audio : (empty -> GPT-SoVITS server default voice; 将语音 wav 放入仓库 voice/ 或配置 nori.config.json refAudio)'
  }
}

function Y($v) { return "'" + ($v -replace "'", "''") + "'" }
$cfg = @()
$cfg += "    assetsDir: $(Y $CfgModel)"
$cfg += "    coreFile: $(Y $CfgCore)"
$cfg += "    ttsUrl: $(Y $TtsUrl)"
$cfg += "    refPrompt: $(Y $RefPrompt)"
if ($RefAudio) { $cfg += "    refAudio: $(Y $RefAudio)" }
if ($GsvBase) { $cfg += "    gsvBase: $(Y $GsvBase)" }
if ($VenvPy)  { $cfg += "    venvPy: $(Y $VenvPy)" }

# Loader PatchOptions 格式（dsh-app-boot applyEntryPatches）：顶层数组条目 = {id, name?, config?, ...}，
# config 子键缩进 4 空格。禁止 update:/insert: 包装（非法字段会被静默跳过 → patch 从未生效：
# 曾致 refAudio 从未注入，直连 9880 正常但 /api/speak 一直 502 tts http 400）。
# 插件行本身由 bundle 层装配，这里只重写该行的 config（restate 全部字段，patch 是整块替换）。
$entry = "- id: '$Pkg'`n  config:`n" + ($cfg -join "`n")

$out = @()
if ($keep.Count -gt 0) { $out += ($keep -join '') }
$out += $entry
Write-U8 $patchPath (($out -join "`n") + "`n")
Write-Host "overlay written: $patchPath"

# ---- 5) structural validation with dsh's own yaml --------------------------
# 探测 dsh CLI 自带 js-yaml（不写死 npm 全局根路径；找不到则跳过校验，仅给警告）
$jsyaml = ''
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
  $dshDir = Split-Path $dshCmd.Source -Parent
  foreach ($c in @(
    (Join-Path $dshDir 'node_modules\@deepseek-ai\dsh\node_modules\js-yaml'),
    (Join-Path $dshDir 'node_modules\js-yaml')
  )) {
    if (Test-Path $c) { $jsyaml = $c; break }
  }
}
if ($jsyaml) {
  node -e "const fs=require('fs');const y=require(process.argv[1]);const p=y.load(fs.readFileSync(process.argv[2],'utf8'));if(!Array.isArray(p))process.exit(3);const e=p[0];if(!e||!e.id||!e.config)process.exit(4);console.log('overlay valid: id='+e.id);" $jsyaml $patchPath
  if ($LASTEXITCODE -ne 0) { throw 'overlay validation failed (js-yaml)' }
} else {
  Write-Warning 'js-yaml 未在 dsh 安装目录找到，跳过 overlay 结构校验（不阻塞安装）'
}

Write-Host ''
Write-Host 'Install done (official dsh plugin + overlay).'
Write-Host "  - Verify: dsh --profile $Profile --dump-config | Select-String -Pattern '$PkgShort'"
Write-Host '  - Restart dsh; the bundle row mounts once and the overlay supplies the config.'
Write-Host '  - Uninstall: .\uninstall.ps1'
if ($SovitsConfigured) {
  Write-Host "  - Voice: GPT-SoVITS configured (gsvBase=$GsvBase, venvPy=$VenvPy)"
} else {
  Write-Host ''
  Write-Warning '语音功能无法使用：未配置 GPT-SoVITS（模型/动画安装已完成，仅 TTS 语音未接线）。'
  Write-Host '  - 一键部署（clone + venv + 依赖 + 可选默认权重）：.\install-sovits.ps1 -DownloadModels'
  Write-Host '  - 或已有部署：编辑 nori.config.json 的 sovits.gsvBase / sovits.venvPy 后重跑本脚本'
}
if (-not (Test-Path (Join-Path $Repo 'persona\prompt.txt')) -or -not (Test-Path (Join-Path $Repo 'persona\reframe.txt'))) {
  Write-Warning '人设文件缺失（persona\prompt.txt / persona\reframe.txt）：Nori 口吻改写层将关闭，桌宠直接朗读原始输出。'
  Write-Host '  - 把已授权的人设文本放入 persona\ 目录（模板见 persona\.gitkeep 说明），重跑本脚本即可生效。'
}