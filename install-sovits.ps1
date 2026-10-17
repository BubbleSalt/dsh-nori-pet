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

# 早检 nori.config.json：本脚本末尾要写它，但前面要先跑 clone + venv + pip（可能几十分钟）。
# JSON 若已损坏，宁可在动手之前就中止，也不要让用户等一小时才看到报错。
$cfgPath = Join-Path $Repo 'nori.config.json'
# ⚠ 目录必须先拦：若该路径是**目录**，下面第一句 ReadAllText 会抛原始 .NET 异常
#   （UnauthorizedAccessException "Access to the path ... is denied"），而 try/catch 那层会被
#   兜成"解析失败"—— 用户按提示去查 JSON 语法，永远查不出问题（配置根本没被读到）。
#   实测：末尾那句 `$cfgPath 是一个目录` 的守卫此时**不可达**，是死代码。这里补在入口处。
if (Test-Path $cfgPath -PathType Container) {
  throw "$cfgPath 是一个目录，不是文件。请先移走/删除该目录再重跑（未做任何改动）。"
}
if (Test-Path $cfgPath) {
  $probeRaw = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8)
  # 空文件 / 纯空白：PS 5.1 的 ConvertFrom-Json 对空串**不抛错**而是返回 $null，
  # 只用 try/catch 会漏掉，于是照样白等一小时才在最后一步失败。这里显式拦掉。
  if ([string]::IsNullOrWhiteSpace($probeRaw)) {
    throw "nori.config.json 是空文件，已在开始安装前中止（未做任何改动）。请删除它后重跑 .\install.ps1 重新生成。"
  }
  try { $probeObj = $probeRaw | ConvertFrom-Json }
  catch {
    throw "nori.config.json 解析失败，已在开始安装前中止（未做任何改动）：$($_.Exception.Message)`n    常见原因：多余的逗号、未转义的反斜杠。修好该文件后重跑；或删除它再跑 .\install.ps1 重新生成。"
  }
  # 语法合法但**顶层不是对象**（如 `[1,2]`、`123`）同样不能接受。末尾的合并逻辑本来就会因此
  # 中止，但那要等 clone + venv + pip 全跑完（可能几十分钟）——与本脚本开头"宁可在动手之前
  # 就中止"的承诺自相矛盾。这里一并拦掉，报错文案与末尾保持一致的关键词（顶层）。
  if ($null -eq $probeObj -or -not (($probeObj -is [System.Collections.IDictionary]) -or ($probeObj -is [System.Management.Automation.PSCustomObject]))) {
    $actual = if ($null -eq $probeObj) { 'null' } else { $probeObj.GetType().Name }
    throw "nori.config.json 顶层不是对象（实际是 $actual），已在开始安装前中止（未做任何改动）。期望形如 {`"sovits`":{...}} 的 JSON 对象；修好该文件后重跑，或删除它再跑 .\install.ps1 重新生成。"
  }
}
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
# 同一个 NativeCommandError 陷阱（见下面 torch 验证处的长注释）：解释器往 stderr 写一个字
# 就足以让 EAP='Stop' 把这里变成终止性错误，且报错信息与"python 不可用"毫无关系。
$prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try { $pyVer = (& $Python --version 2>&1 | Out-String).Trim() } finally { $ErrorActionPreference = $prevEap }
Write-Host "python   : $Python ($pyVer)"

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
# ⚠ 必须临时降级 $ErrorActionPreference：本脚本是 EAP='Stop'，而"原生命令写 stderr + `2>&1`"
#   在 Stop 之下会被 PowerShell 当成**终止性**错误（NativeCommandError）抛出。后果不是
#   "少一条警告"，而是**下面那个 Write-Warning 分支永远走不到**，脚本直接在 torch 验证处
#   死掉 —— 此时 sovits.gsvBase/venvPy 还没写进 nori.config.json，用户看到的是一个
#   NativeCommandError 堆栈而不是"依赖未就绪"。已实测复现（venv 里没装 torch 即触发）。
$prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try { $chk = & $venvPy -c "import sys,torch; print(sys.version.split()[0], torch.__version__)" 2>&1 }
finally { $ErrorActionPreference = $prevEap }
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
# （$cfgPath 已在脚本开头定义并做过早检）
$cfg = @{}
if (Test-Path $cfgPath) {
  # 解析失败必须中止。旧实现的真实症状是**最后一步硬中止**（不是静默清空）：
  # 本脚本 $ErrorActionPreference='Stop'，而旧代码的 catch 体 `/* 保留空对象 */` 根本不是
  # PowerShell 注释（`/*` 会被当成命令名）→ CommandNotFoundException；即便不写那行，
  # `$cfg.sovits = @{}` 对 PSCustomObject 也会抛 "property cannot be found"。
  # 代价是：用户等完 clone+venv+pip 才在最后一步失败（本脚本前面的早检就是为了消掉这个代价）。
  # 另注：只有在 EAP=Continue 时旧代码才会把配置清空（已实测 242→132 字节），那不是本脚本的默认行为。
  try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch {
    throw "nori.config.json 解析失败，已中止（未修改该文件）：$($_.Exception.Message)`n    常见原因：多余的逗号、未转义的反斜杠。修好该文件后重跑；或删除它再跑 .\install.ps1 重新生成。"
  }
  Copy-Item $cfgPath "$cfgPath.bak" -Force
}
# 字段级更新 sovits 段（保留用户已有字段，如 t2sWeights / vitsWeights）。
# ⚠ 不能写 `$cfg.sovits = @{}`：当 $cfg 是 ConvertFrom-Json 得到的 PSCustomObject 且原本
#   没有 sovits 键时，给不存在的属性赋值在 PS 5.1 会抛 "property cannot be found"
#   （install.ps1 生成的极简配置正好可能没有该键）。故按类型分别处理。
# ⚠ 也不能对"非对象"的值取 PSObject.Properties：字符串/数组的**适配器成员**（Length、Count、
#   IsReadOnly…）会被当成配置字段写进用户的 config，且每次重跑都再污染一遍。故只认
#   IDictionary / PSCustomObject，其余一律中止。
$sov = [ordered]@{}   # 有序：保持与 nori.config.example.json 一致的字段顺序，便于 diff
# ⚠ 顶层类型判定必须在**读 $cfg.sovits 之前**：
#   顶层若是数组，`$cfg.sovits` 会走"成员枚举"返回一个**非 null 的空数组**，
#   于是先撞上下面"sovits 不是对象（实际是 Object[]）"那条分支 —— 中止是对的，
#   但诊断信息指向错误的字段，用户会去改 sovits 而不是改顶层结构（已实测 S10）。
$TopIsDict = $cfg -is [System.Collections.IDictionary]
$TopIsPsc  = $cfg -is [System.Management.Automation.PSCustomObject]
if (-not ($TopIsDict -or $TopIsPsc)) {
  # 对数组做 Add-Member 会作用到**每个元素**上，把文件写成 [ {...sovits}, {...sovits} ]。
  # $null 单独说：空/纯空白文件经 ConvertFrom-Json 得到 $null，取 .GetType() 会抛
  # "You cannot call a method on a null-valued expression"，把真实原因盖掉。
  $actual = if ($null -eq $cfg) { 'null（空文件？）' } else { $cfg.GetType().Name }
  throw "nori.config.json 顶层不是对象（实际是 $actual），已中止。本脚本只支持 { ... } 形式的配置对象。"
}
if ($null -ne $cfg.sovits) {
  if ($cfg.sovits -is [System.Collections.IDictionary]) {
    foreach ($k in @($cfg.sovits.Keys)) { $sov[$k] = $cfg.sovits[$k] }
  } elseif ($cfg.sovits -is [System.Management.Automation.PSCustomObject]) {
    foreach ($p in $cfg.sovits.PSObject.Properties) { $sov[$p.Name] = $p.Value }
  } else {
    throw "nori.config.json 的 `"sovits`" 不是对象（实际是 $($cfg.sovits.GetType().Name)），已中止以免写坏配置。请改成 { `"gsvBase`": ... } 形式后重跑。"
  }
}
$sov['gsvBase'] = $GsvBase
$sov['venvPy']  = $VenvPy
$sovObj = [pscustomobject]$sov
if ($TopIsDict) {
  $cfg['sovits'] = $sovObj
} else {
  # ⚠ 不能无条件 Add-Member -Force：属性已存在时 -Force 会把该属性**删掉重加到末尾**，
  #   于是配置文件里 sovits 的位置被搬到最后一个键 —— 语义没变，但每次运行都产生一次
  #   无意义的顺序 diff（本例注释明确在意字段顺序以便 diff）。已存在就原地改值。
  $existing = $cfg.PSObject.Properties['sovits']
  if ($existing) { $existing.Value = $sovObj }
  else { $cfg | Add-Member -NotePropertyName 'sovits' -NotePropertyValue $sovObj }
}
# -Depth 20：默认 4 层会把更深的子树静默转换成 "@{...}" 字符串（数据损坏）。
# 写盘同样走"临时文件 → 读回解析 → 原子替换"，与 install.ps1 的加固级别对齐：
# 旧写法直接覆盖，崩溃/杀软锁文件会留下截断的 nori.config.json（虽有 .bak 可救，但没必要）。
$jsonText = $cfg | ConvertTo-Json -Depth 20
$tmpCfg = "$cfgPath.tmp"
[System.IO.File]::WriteAllText($tmpCfg, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
try { $null = [System.IO.File]::ReadAllText($tmpCfg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
catch {
  Remove-Item $tmpCfg -Force -ErrorAction SilentlyContinue
  throw "生成的 sovits 配置读回解析失败，已中止（未改动 $cfgPath）：$($_.Exception.Message)"
}
if (Test-Path $cfgPath -PathType Container) {
  Remove-Item $tmpCfg -Force -ErrorAction SilentlyContinue
  throw "$cfgPath 是一个目录，不是文件。请先移走/删除该目录再重跑。"
}
Move-Item $tmpCfg $cfgPath -Force
Write-Host "==> nori.config.json sovits 已写入（gsvBase, venvPy）；运行 .\install.ps1 完成插件接线"
if (Test-Path "$cfgPath.bak") { Write-Host "    backup: $cfgPath.bak" }

Write-Host ''
Write-Host 'Done. 下一步：'
Write-Host '  1) .\install.ps1           # 把 sovits 配置接入插件（ttsWatch 自动拉起 api.py -> 9880）'
Write-Host '  2) 首次拉起的冷启动较慢（加载模型）；之后正常'