#requires -Version 5.1
<#
.SYNOPSIS
  可选一键部署 GPT-SoVITS（Nori 桌宠的 TTS 引擎，api_v2 -> 9880）。
  与 install.ps1 分离：install 不自动装，未配置时跳过并在末尾提示本脚本。

.DESCRIPTION
  Python 检测（需 3.9~3.11；用途仅限跑 GPT-SoVITS 的 api.py 推理服务 + ttsWatch 拉起） ->
  git clone GPT-SoVITS（默认仓库内 GPT-SoVITS/，-GsvBase 可换目录）-> python -m venv .venv ->
  pip install -r requirements.txt（torch 等大件，耗时与网络相关）-> 验证 torch 可用 ->
  （可选 -DownloadModels）下载官方默认权重到 GPT_SoVITS/pretrained_models/（闭源权重，
  只进本机、不进仓库，按需选择）-> 自动把 sovits.gsvBase / sovits.venvPy 写入 nori.config.json。

  完成后运行 .\install.ps1 完成插件接线；api.py 由 Nori 的 ttsWatch 自动拉起（9880）。

.PARAMETER GsvBase
  安装目标目录。默认 <repo>\GPT-SoVITS（仓库内约定目录，已含内容时跳过 clone）。

.PARAMETER DownloadModels
  同时下载官方预训练默认权重（HuggingFace，约 1GB+，可选）。

.PARAMETER Python
  指定 python 解释器（默认探测 python / py -3 启动器，要求 3.9~3.11）。

.EXAMPLE
  .\install-sovits.ps1
.EXAMPLE
  .\install-sovits.ps1 -DownloadModels
#>
param(
  [string]$GsvBase = '',
  [switch]$DownloadModels,
  [string]$Python = ''
)
$ErrorActionPreference = 'Stop'

$Repo = $PSScriptRoot
if (-not $GsvBase) { $GsvBase = Join-Path $Repo 'GPT-SoVITS' }
if (-not $Python) {
  $Python = ''
  foreach ($exe in @('python', 'py')) {
    $args = if ($exe -eq 'py') { @('-3', '--version') } else { @('--version') }
    try { $v = & $exe @args 2>&1 | Out-String } catch { continue }
    if ($v -match 'Python (\d+)\.(\d+)') {
      $major = [int]$matches[1]; $minor = [int]$matches[2]
      if ($major -eq 3 -and $minor -ge 9 -and $minor -le 11) { $Python = $exe; break }
      Write-Host "  (python '$exe' = $major.$minor，不在 3.9~3.11 范围，继续找)"
    }
  }
  if (-not $Python) {
    throw "未找到可用 Python 3.9~3.11（仅用于运行 GPT-SoVITS api.py + ttsWatch 拉起）。`n请安装后重跑：https://www.python.org/downloads/ （退出时勾选 Add to PATH），或 -Python 指定解释器。"
  }
}
Write-Host "python   : $Python ($(& $Python --version 2>&1))"

# git 检测（clone 用）
try { & git --version 2>&1 | Out-Null } catch { throw '未找到 git（仅 GPT-SoVITS 拉取需要）；请安装 https://git-scm.com/ 后重跑' }

if (-not (Test-Path (Join-Path $GsvBase 'api.py'))) {
  if (Test-Path $GsvBase) {
    Write-Host "==> $GsvBase 存在但缺少 api.py，原地 clone（若目录非空可能报错）"
  } else { New-Item -ItemType Directory $GsvBase -Force | Out-Null }
  Write-Host '==> git clone GPT-SoVITS ...'
  Push-Location $GsvBase
  try {
    & git clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS.git . 
    if ($LASTEXITCODE -ne 0) { throw 'clone 失败（网络？代理？）——可手动 git clone 后重跑' }
  } finally { Pop-Location }
} else {
  Write-Host "==> 已存在 api.py：$GsvBase（跳过 clone）"
}

# venv + 依赖
$venvPy = Join-Path $GsvBase '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
  Write-Host '==> 创建 venv 并安装依赖（torch 等大件，可能很久；网络失败请配置代理后重跑）...'
  & $Python -m venv (Join-Path $GsvBase '.venv')
  if ($LASTEXITCODE -ne 0) { throw 'venv 创建失败' }
  & $venvPy -m pip install --upgrade pip
  & $venvPy -m pip install -r (Join-Path $GsvBase 'requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'pip install 失败（网络？）；重试或手动安装后重跑' }
} else {
  Write-Host "==> venv 已存在：$venvPy（跳过依赖安装）"
}

# torch 验证
Write-Host '==> 验证 torch ...'
$chk = & $venvPy -c "import sys,torch; print(sys.version.split()[0], torch.__version__)" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "  torch 验证失败：$($chk -join ' ')"
  Write-Warning '依赖未就绪；api.py 可能起不来。可重跑本脚本或手动修 venv。'
} else { Write-Host "    ok: $($chk -join ' ')" }

# 可选默认权重（闭源预训练；不入仓库，按需）
$pretrained = Join-Path $GsvBase 'GPT_SoVITS\pretrained_models'
if ($DownloadModels) {
  Write-Host '==> 下载默认权重（HuggingFace，约 1GB+；开源许可限制，仅本机使用）...'
  New-Item -ItemType Directory $pretrained -Force | Out-Null
  $dl = Get-ChildItem $GsvBase -Filter 'download_models*.py' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($dl) {
    Push-Location $GsvBase
    try { & $venvPy $dl.FullName } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Write-Warning '默认权重下载失败（网络/代理？）；可稍后手动下载到 GPT_SoVITS/pretrained_models/' }
  } else {
    Write-Warning "未找到官方下载脚本；请手动下载权重（HuggingFace: RVC-Boss/GPT-SoVITS-pretrained-models）解压到 $pretrained"
  }
} else {
  Write-Host "==> 跳过权重下载。需要时重跑：.\install-sovits.ps1 -DownloadModels"
  Write-Host "    权重落点：$pretrained（缺失时 api.py 推理会失败）"
}

# 写入 nori.config.json 的 sovits 段（存在则仅更新；不存在则生成）
$cfgPath = Join-Path $Repo 'nori.config.json'
$cfg = @{}
if (Test-Path $cfgPath) { try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { /* 保留空对象 */ } }
# 字段级更新 sovits 段（保留用户已有字段，如 t2sWeights / vitsWeights）
if ($null -eq $cfg.sovits) { $cfg.sovits = @{} }
$cfg.sovits.gsvBase = $GsvBase
$cfg.sovits.venvPy  = $VenvPy
[System.IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "==> nori.config.json sovits 已写入（gsvBase, venvPy）；运行 .\install.ps1 完成插件接线"

Write-Host ''
Write-Host 'Done. 下一步：'
Write-Host '  1) .\install.ps1           # 把 sovits 配置接入插件（ttsWatch 自动拉起 api.py -> 9880）'
Write-Host '  2) 首次拉起的冷启动较慢（加载模型）；之后正常'