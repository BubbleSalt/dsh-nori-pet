#requires -Version 5.1
<#
.SYNOPSIS
  One-click installer for the Nori desktop-pet plugin (@bubblesalt/dsh-nori-pet)
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

# ⚠ 辅助函数必须在首次调用之前定义：PowerShell 以 -File 执行脚本时**不做**函数提升
#   （实测 PS 5.1 与 PS 7 均抛 CommandNotFoundException），配合上面的 Stop 偏好即为
#   终止性错误。曾致首次安装的交互引导在写配置那一步整段中断、配置文件从未生成。
function Write-U8($Path, $Content) {
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

# JSON 字符串字面量：必须先转义反斜杠、再转义双引号。
# 手拼 JSON 只转义 `"` 时，用户粘贴的 Windows 路径（C:\repo\...）会拼出非法转义
# （\v 直接报错、\r 被静默吞成回车）→ 生成的 nori.config.json 无法解析。
function JsonStr($v) {
  # 顺序很重要：先转义反斜杠，再转义双引号，最后转义控制字符。
  # 若先做控制字符（会插入 \uXXXX），后面的反斜杠转义会把插入的反斜杠再翻倍 → 产出非法 JSON。
  $s = ($v -replace '\\', '\\') -replace '"', '\"'
  # 控制字符（U+0000–U+001F）按 JSON 规范必须写成 \uXXXX。PowerShell 的 ConvertFrom-Json 会
  # **宽容接受**裸 TAB，但插件侧用的是 Node 的 JSON.parse，它会报
  # "Bad control character in string literal"，用户填的答案被静默丢弃 —— 正是本函数要消灭的那类 bug。
  $s = [regex]::Replace($s, '[\u0000-\u001f]', [System.Text.RegularExpressions.MatchEvaluator] {
    param($m) '\u' + ('{0:x4}' -f [int][char]$m.Value)
  })
  return '"' + $s + '"'
}

$Repo     = $PSScriptRoot
$Pkg      = '@bubblesalt/dsh-nori-pet'
$PkgShort = 'dsh-nori-pet'
# 判定"某个 patch 条目是不是我们自己的"：只认**列 0 的**条目顶层 `- id:` 行。
# ⚠ 绝不能按子串 'dsh-nori-pet' 匹配——那会把"注释里提到该名字 / 配置值里含该名字 /
#   块标量里有该名字"的**其它插件条目**，乃至名字以它开头的**兄弟包**
#   （如 @someone/dsh-nori-pet-extras）整块删掉，属静默数据丢失（已实测复现）。
# ⚠ 这里**不能**写前导 `\s*`：`^\s*-\s*id:` 会命中别的条目里**嵌套**的 `- id: dsh-nori-pet`
#   （例如宿主条目里的 insert: 列表），于是把宿主条目整块删掉（已实测复现）。
#   锚定列 0 与本文件的分块方式 `'(?m)^(?=- )'` 保持一致。
# ⚠ 必须容忍"冒号前有空格"（`- id : 'x'`，合法 YAML）与锚点（`- &a id: 'x'`）：
#   漏认的后果是**写入重复条目**并在 js-yaml 关卡硬报错（已实测 ARRAY(n=2) mine=2）。
#   列 0 锚 + 块内 id 行数恰好为 1 这两道保险已经兜住了放宽后的风险。
$OursEntryRx = "(?m)^-\s*(?:&\S+\s+)?['""]?id['""]?\s*:\s*(?:&\S+\s+|![^\s]+\s+)?['""]?(?:@[\w.-]+/)?$([regex]::Escape($PkgShort))['""]?\s*(?:#.*)?$"
$DshHome  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfRoot = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path $ProfRoot)) { throw "profile not found: $ProfRoot (use -Profile)" }

# ---- 0) load nori.config.json（配置外置；文件缺失/损坏则重新走配置引导）----
$ConfigPath = Join-Path $Repo 'nori.config.json'
$cfgFile = @{}
$cfgLoaded = $false
if (Test-Path $ConfigPath) {
  try {
    $cfgRaw = Get-Content $ConfigPath -Raw -Encoding UTF8
    $cfgFile = $cfgRaw | ConvertFrom-Json
    # 只有**对象**才算有效配置：
    #  · 空文件 / 字面量 null 会被解析成 $null（不抛错）；
    #  · 顶层是数组/标量（如 `[1,2]`、`123`）也不是配置——数组经 PSObject 会暴露
    #    Count/Length 等**适配器属性**，会被下面的 Count≠0 误判成"已有配置"，
    #    于是引导同样再也不出现（与损坏 JSON 是同一类陷阱，实测 [1,2] → NeedGuide=False）。
    #  · ⚠ 还要看**原文首字符**：PowerShell 7 的 ConvertFrom-Json 会把**单元素数组**展开，
    #    `[{"modelDir":null}]` 于是变成一个 PSCustomObject，类型判定完全看不出它是数组
    #    （2 元素才变 Object[]）——判定随数组**元素个数**摇摆。JSON 对象文档不可能以 `[`
    #    开头，所以直接用原文拦，两个引擎行为一致（实测 PS7 下该文件曾骗过引导判定）。
    #  · ⚠ 千万不要写成 `if ([string]$cfgRaw.TrimStart().StartsWith('['))`：那会被解析成
    #    `[string](<bool>)` → 得到字符串 'False'，而**非空字符串在 PowerShell 里为真** →
    #    分支永远命中，连正常配置都被当成数组（实测：正常配置被误判、引导判定全反）。
    #    同时用 IsNullOrWhiteSpace 挡住空文件（Get-Content -Raw 对 0 字节文件返回 $null，
    #    直接 .TrimStart() 会抛 "You cannot call a method on a null-valued expression"，
    #    被 catch 兜成"解析失败"——结论虽然对，提示文案是错的）。
    if ((-not [string]::IsNullOrWhiteSpace($cfgRaw)) -and $cfgRaw.TrimStart().StartsWith('[')) {
      Write-Warning 'nori.config.json 顶层是数组（原文以 [ 开头），将重新进入配置引导。'
      $cfgFile = @{}
    } elseif ($null -eq $cfgFile) {
      $cfgFile = @{}
    } elseif (($cfgFile -is [System.Collections.IDictionary]) -or ($cfgFile -is [System.Management.Automation.PSCustomObject])) {
      $cfgLoaded = $true
    } else {
      Write-Warning "nori.config.json 顶层不是对象（实际是 $($cfgFile.GetType().Name)），将重新进入配置引导。"
      $cfgFile = @{}
    }
  } catch {
    Write-Warning "nori.config.json 解析失败，将重新进入配置引导（不会被这个坏文件永久卡住）：$($_.Exception.Message)"
    $cfgFile = @{}
  }
}

# ---- 0b) 模型预检：Nori Live2D 模型不存在则拒绝安装 ----
# modelDir 允许是**相对路径**。相对值必须相对**仓库**解析，绝不能相对调用者的 CWD：
# 否则从别的目录运行（`& C:\path\dsh-nori-pet\install.ps1`）就会得到"模型缺失"的误导性中止 ——
# 模型明明在仓库里，报错却让人去检查模型目录（已实测复现：沙箱内模型存在、配置写
# "modelDir":"Nori_web"，仅因 CWD 不同即抛 模型缺失）。
# 触发条件不夸大：本脚本自己**不写** modelDir（引导只写 refAudio/refPrompt/sovits/reframe；
# nori.config.example.json 给的是空串 ""，走默认探测那一支）。所以受影响的是**手写过相对
# modelDir 的配置**——但这写法很自然：overlay 的 assetsDir 用的正是 'Nori_web' 这种相对写法，
# 而且本函数的报错文案本身就在引导用户去"仓库 Nori_web/ 目录"。
function Resolve-ModelDir([string]$v) {
  if (-not $v) { return '' }
  if ([System.IO.Path]::IsPathRooted($v)) { return $v }
  return (Join-Path $Repo $v)
}
# 优先用配置的 modelDir，否则探测仓库 Nori_web。缺失即抛错，避免"引导填半天最后才发现模型缺失"。
$preModelDir = if ([string]$cfgFile.modelDir) { Resolve-ModelDir ([string]$cfgFile.modelDir) } else { Join-Path $Repo 'Nori_web' }
# ⚠ Test-Path 会抛，不是只会返回 False：`a:b`（驱动器相对）→ "找不到驱动器"，
#   UNC `\\…` → 真的发起 SMB 连接、失败时抛 "Access to the path … is denied"（实测，且对不可达
#   主机要等 1.5 秒）。EAP=Stop 下这些都会盖掉本意要给的"Nori 模型缺失"提示。
$preProbeOk = $false; $preProbeErr = ''
try { $preProbeOk = [bool](Test-Path (Join-Path $preModelDir 'Nori.model3.json')) } catch { $preProbeErr = $_.Exception.Message }
if (-not $preProbeOk) {
  # 模型是第三方 IP（仓库不分发）：缺了**不再硬停** —— 桌宠会进入"纸片人模式"（气泡 + 语音正常，
  # 表情/动作不可用）。装了模型后再重跑本脚本即可启用；想用自己的模型就改 nori.config.json 的 model 段。
  Write-Host ""
  Write-Warning "未找到模型（$preModelDir 下没有 Nori.model3.json）：继续安装，桌宠将进入纸片人模式。"
  Write-Warning "  · 想用 Nori 原版模型：把模型放进 Nori_web/（含 Nori.model3.json）后重跑本脚本"
  Write-Warning "  · 想用自己的模型：放进任意目录，并在 nori.config.json 配 model.file / model.emotions"
  if ($preProbeErr) { Write-Warning "  · 探测该路径时报错：$preProbeErr" }
}

# ---- 0c) 配置引导：nori.config.json 缺失/为空时，交互式生成并让用户填写 ----
# 仅当文件不存在或解析为空对象才触发；已填配置则跳过，不打扰。
# 非交互环境（stdin 被重定向，如 CI/脚本调用）自动跳过询问，全部走默认约定。
function Confirm-Prompt($label, $default) {
  $suffix = if ($default) { '[Y/n]' } else { '[y/N]' }
  $r = (Read-Host "  $label $suffix").Trim().ToLower()
  if ($r -eq '') { return $default }
  return ($r -in @('y', 'yes', '是', '1'))
}
# ⚠ 判断"是否已有配置"**必须**用显式标志 $cfgLoaded，不能写成
#   `@($cfgFile.PSObject.Properties).Count -eq 0`：解析失败时 $cfgFile 退化成 @{}，
#   而哈希表经 PSObject 暴露 7 个**适配器属性**（Count/Keys/Values/IsReadOnly/
#   IsFixedSize/IsSynchronized/SyncRoot）→ Count≠0 → 引导再也不出现，
#   用户被永久卡死在这个坏文件上（已实测：corrupt=Hashtable props=7 NeedGuide=False）。
$cfgProps = if ($cfgLoaded) { @($cfgFile.PSObject.Properties) } else { @() }
$NeedConfigGuide = (-not $cfgLoaded) -or ($cfgProps.Count -eq 0)
$Interactive = -not [Console]::IsInputRedirected
if ($NeedConfigGuide) {
  Write-Host ''
  Write-Host '==> 未检测到 nori.config.json 配置（或为空）。'
  if (-not $Interactive) {
    Write-Host '    非交互环境（stdin 重定向），跳过配置询问，全部走默认约定。'
    Write-Host "    之后可手动生成：Copy-Item nori.config.example.json nori.config.json 后编辑，再重跑本脚本。"
  } else {
    Write-Host '    将逐项询问并生成配置（直接回车 = 默认；Y/n 类问题回车=括号内默认）。'
    Write-Host '    完整可配置项见 nori.config.example.json；生成后可随时编辑再重跑。'
    Write-Host ''
    $aRefAudio  = Read-Host '  ① 参考音频 wav 路径（声线；回车=自动探测 voice/ 目录）'
    $aRefPrompt = Read-Host '  ② 参考音频转写文本（与 wav 配套；回车=默认"你好,初次见面,我的名字是Nori"）'
    # ③ GPT-SoVITS 安装询问（体积提示）；同意则调用 install-sovits.ps1 自动部署并写配置
    $aInstallSovits = Confirm-Prompt '  ③ 是否安装 GPT-SoVITS 语音引擎（基础依赖约 2~3GB，含 torch 等大件；需要 Python 3.9~3.11 与 git，耗时取决于网络）？' $false
    $aGsvBase = ''
    $aVenvPy = ''
    if ($aInstallSovits) {
      $aDlModels = Confirm-Prompt '    同时下载官方默认权重（HuggingFace，另需约 1GB+，可选）？' $false
      $sovitsScript = Join-Path $Repo 'install-sovits.ps1'
      if (-not (Test-Path $sovitsScript)) {
        Write-Warning '    install-sovits.ps1 缺失，无法自动安装；可稍后手动运行它。'
      } else {
        Write-Host '    ==> 运行 install-sovits.ps1（clone + venv + 依赖，自动写入 sovits 配置）...'
        try {
          if ($aDlModels) { & $sovitsScript -DownloadModels } else { & $sovitsScript }
          Write-Host '    install-sovits.ps1 完成（sovits 配置已写入 nori.config.json）'
        } catch {
          Write-Warning "    install-sovits.ps1 执行失败：$($_.Exception.Message)；主安装继续（可稍后手动运行 install-sovits.ps1）"
        }
      }
    } else {
      $aGsvBase = Read-Host '  ④ GPT-SoVITS 根目录 gsvBase（外部已有部署时填；回车=未配置，语音暂不可用）'
      $aVenvPy  = Read-Host '  ⑤ venv python 路径（回车=<gsvBase>/.venv/Scripts/python.exe）'
    }
    # ⚠ ③ 选 yes 时，gsvBase/venvPy 是 install-sovits.ps1 写进 nori.config.json 的，
    #   而 $aGsvBase/$aVenvPy 只在 else 分支被赋值、这里仍是空串。若不读回来，
    #   下面第 157 行的整体覆盖会把刚写好的 sovits 段冲掉 → $SovitsConfigured 为 false
    #   → patch 里没有 gsvBase/venvPy → 用户看着"语音引擎装好了"却始终没有声音。
    if (-not $aGsvBase.Trim() -and -not $aVenvPy.Trim() -and (Test-Path $ConfigPath)) {
      try {
        $probe = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($probe.sovits) {
          $aGsvBase = [string]$probe.sovits.gsvBase
          $aVenvPy  = [string]$probe.sovits.venvPy
          if ($aGsvBase -or $aVenvPy) { Write-Host "  已从 install-sovits.ps1 写入的配置读回 sovits 路径" }
        }
      } catch {
        # 不能静默：读不回来还继续，就会用空值重建配置，把 install-sovits.ps1 刚写好的
        # gsvBase/venvPy 丢掉（那正是这段读回代码要防的事）。
        Write-Warning "读回 nori.config.json 的 sovits 失败，将按空值写入（可能丢失 gsvBase/venvPy）：$($_.Exception.Message)"
      }
    }
    # ⑥ 改写层开关（进配置，reframe: true/false 写入 patch）
    $aReframe = Confirm-Prompt '  ⑥ 是否启用 Nori 口吻改写层（assistant 输出先经 LLM 改写再朗读）？' $true
    $aApiKey  = Read-Host '  ⑦ 改写层 DeepSeek apiKey（回车=回退 dsh 内置 llm）'
    # 组装最小结构 JSON（手写字符串保留中文，不依赖 ConvertTo-Json 的 \u 转义）
    # ⚠ 值一律经 JsonStr（转义 \ 与 "）：直接拼会因未转义反斜杠产出非法 JSON。
    $pairs = @()
    if ($aRefAudio.Trim())  { $pairs += "`"refAudio`": $(JsonStr $aRefAudio.Trim())" }
    if ($aRefPrompt.Trim()) { $pairs += "`"refPrompt`": $(JsonStr $aRefPrompt.Trim())" }
    if ($aGsvBase.Trim() -or $aVenvPy.Trim()) {
      $sov = @()
      if ($aGsvBase.Trim()) { $sov += "`"gsvBase`": $(JsonStr $aGsvBase.Trim())" }
      if ($aVenvPy.Trim())  { $sov += "`"venvPy`": $(JsonStr $aVenvPy.Trim())" }
      $pairs += "`"sovits`": { $($sov -join ', ') }"
    }
    $refSub = @("`"reframe`": $(if ($aReframe) { 'true' } else { 'false' })")
    if ($aApiKey.Trim()) { $refSub += "`"apiKey`": $(JsonStr $aApiKey.Trim())" }
    $pairs += "`"reframe`": { $($refSub -join ', ') }"
    $json = "{ $($pairs -join ', ') }"
    # 写前自检（硬中止）：宁可不写，也不能留下一个解析不了的配置把用户填的答案静默丢掉。
    try { $null = $json | ConvertFrom-Json }
    catch { throw "内部错误：生成的配置不是合法 JSON，已中止（未写入 $ConfigPath）：$($_.Exception.Message)" }
    # 先写临时文件 → 读回校验 → 再原子替换。
    # 旧写法是"直接覆盖、失败才报错"：中止时盘上已留下一个坏配置，而且下一轮
    # $NeedConfigGuide 会因该文件存在而判定"已有配置"（解析失败时 $cfgFile 退化成 @{}，
    # 哈希表的适配器属性让 Count≠0）→ 引导再也不出现，用户被卡死在这个坏文件上。
    $tmpPath = "$ConfigPath.tmp"
    Write-U8 $tmpPath $json
    try { $cfgFile = Get-Content $tmpPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch {
      Remove-Item $tmpPath -Force -ErrorAction SilentlyContinue
      throw "生成的配置读回解析失败，已中止（未改动 $ConfigPath）：$($_.Exception.Message)"
    }
    # 目标若是个**目录**，Move-Item -Force 会"成功"地把 tmp 塞进目录里（PS 5.1 实测），
    # 脚本随后还打印"配置已生成"，而盘上根本没有配置文件。显式拦掉。
    if (Test-Path $ConfigPath -PathType Container) {
      Remove-Item $tmpPath -Force -ErrorAction SilentlyContinue
      throw "$ConfigPath 是一个目录，不是文件。请先移走/删除该目录再重跑。"
    }
    Move-Item $tmpPath $ConfigPath -Force
    Write-Host "  配置已生成: $ConfigPath"
    Write-Host '  （后续可直接编辑此文件，或对照 nori.config.example.json 增删项）'
  }
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

# ---- 1) resolve model / core ----------------------------------------------
# 资产约定：模型/语音放仓库内占位目录（Nori_web/、voice/）；Live2D Core 是官方通用文件，
# 仓库内不存在时自动下载官方 CDN（live2dcubismcore.min.js -> cubism_sdk/Core/live2dcubismcore.js）。
$ModelGiven = ($ModelDir -ne '')
# 同一处相对路径陷阱（见 0b 的注释）：配置里的相对 modelDir 也要相对仓库解析，
# 否则 0b 放行、这里再抛，症状一样是"仓库里明明有模型却说取不到"。
$ModelDir = Resolve-ModelDir $ModelDir
if (-not $ModelDir) {
  $probe = Join-Path $Repo 'Nori_web'
  if (Test-Path (Join-Path $probe 'Nori.model3.json')) { $ModelDir = $probe }
}
# ⚠ Test-Path 会抛而不是返回 False（驱动器相对 `a:b`、UNC 网络路径），见 0b 处的说明。
$modelProbeOk = $false; $modelProbeErr = ''
try { $modelProbeOk = [bool](Test-Path (Join-Path $ModelDir 'Nori.model3.json')) } catch { $modelProbeErr = $_.Exception.Message }
if (-not $ModelDir -or -not $modelProbeOk) {
  # 同上：模型缺失不阻断安装。配置里仍写默认 'Nori_web'，用户之后把模型放进去重跑即可。
  Write-Warning "model dir unavailable（$ModelDir）$(if ($modelProbeErr) { "：$modelProbeErr" }) —— 继续安装，桌宠进入纸片人模式"
}
# 模型完整性校验（只查不改，保证安装效果一致）：只适配原版 Nori_web——睡眠动作
# 00_Sleep 在 Idle 组（idle 池一员），缺失时睡眠会退化（不出错但不闭眼），提示换回原版。
try {
  $m3 = Get-Content (Join-Path $ModelDir 'Nori.model3.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $idleNames = @($m3.FileReferences.Motions.Idle | ForEach-Object { [IO.Path]::GetFileName($_.File) })
  if (-not (($idleNames -match 'Sleep|EyeClosed').Count -gt 0)) {
    Write-Warning '模型 Idle 组缺少睡眠动作（00_Sleep/EyeClosed）；睡眠会退化，请使用 Nori_web 原版模型'
  }
} catch {
  # 校验失败不阻断（模型能用则照装）。
  # ⚠ 这里**不能**图省事写 `/* 校验失败不阻断 */`：PowerShell 没有 /* */ 注释语法，
  #    它会被当成命令名 `/*` 执行 → CommandNotFoundException；本脚本 EAP=Stop，
  #    于是"不阻断"变成"直接中止安装"（已实测，PS 5.1 与 7 都一样）。
}
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
# 写入 patch 的值：**尽量写成仓库相对路径**——主机（src/index.ts resolveConfigPath）对相对
# assetsDir 一律以仓库根为基准解析，绝对路径则原样用（见 1031-1038 行注释）。
# ⚠ 这里曾经直接写 `$ModelDir`，而 $ModelDir 已被 Resolve-ModelDir 解析成绝对路径 →
#   配置里被烤进机器专属路径（用户移动/重命名仓库后失效），而缺省分支写的却是相对的 'Nori_web'，
#   同一份配置两种风格（对显式 modelDir 与缺省调用者的行为还不一致）。
#   不为空的相对结果才用，反例：modelDir 恰好等于仓库根本身（Substring 后为空串）。
# ⚠⚠ 前缀判定**必须带上分隔符**，不能只写 StartsWith($Repo)：兄弟目录只共享字符串前缀，
#   实测仓库 `…\pre` + 模型 `…\pre-ext\Nori_web` → 算出 `'-ext\Nori_web'` 这种残缺相对路径，
#   主机按仓库根解析后指向不存在的目录 → 桌宠资源 404，而安装照报成功。
#   所以必须是 "$RepoRoot\" / "$RepoRoot/" 前缀；等值（模型就是仓库根）也不相对化。
$RepoRoot = $Repo.TrimEnd([char[]]('\', '/'))
$CfgModel = if ($ModelGiven) {
  $rel = ''
  foreach ($sep in @('\', '/')) {
    if ($ModelDir.StartsWith($RepoRoot + $sep, [System.StringComparison]::OrdinalIgnoreCase)) {
      $rel = $ModelDir.Substring(($RepoRoot + $sep).Length).TrimStart([char[]]('\', '/'))
      break
    }
  }
  if ($rel) { $rel } else { $ModelDir }
} else { 'Nori_web' }
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
# 只重写"**整块就是一个条目、且该条目是我们自己的**"的块（与 uninstall.ps1 对称）。两道保险：
#  ① $OursEntryRx 锚定列 0 的 `- id:`（不带前导 \s*），避免命中别的条目里嵌套的
#     `- id: dsh-nori-pet` 而删掉宿主条目；
#  ② 块内 `- id:` 行数必须**恰好为 1**。若用户用**缩进写法**或**流式数组**写顶层数组，
#     整份文件会落进同一个块，此时删掉"匹配到的那个块"等于删掉**所有**插件的条目。
#     宁可留下旧条目 + 警告，也不能静默清空别人的配置。
$keep   = @($blocks | Where-Object {
  # ⚠ 必须用 -cmatch（大小写敏感）：dsh 装载器是按**小写** entry.id 建表的
  #   （dsh-app-boot: `if (entry.id) entryMap.set(entry.id, entry)`），所以 `- ID:` 那条
  #   根本不是我们的条目，不该被当作"我们的块"处理。默认的 -match 是**大小写不敏感**的，
  #   而下面的计数用 [regex]::Matches（大小写敏感）——两边口径不一致就会自相矛盾
  #   （实测 `- ID: 'dsh-nori-pet'` → 匹配=真、计数=0）。
  if (-not ($_ -cmatch $OursEntryRx)) { return $true }
  # ⚠ 计数只数**列 0** 的 `- id:`（与 $OursEntryRx 的锚点一致），不能带前导 `\s*`：
  #   带上就会把块内**嵌套**的 `- id: xxx` 也算进来（例如 config 里的 routeTable 列表），
  #   于是"我们的块"被判成"不止一个条目"→ 不删、再追加一条重复 → 被自己的
  #   「恰好一条」断言卡死（实测 exit=1 overlay validation failed，且每次重跑都一样）。
  #   去掉前导 \s* 后：缩进写法/流式数组的计数仍为 0 → 照样走"保留 + 警告"那条安全路径。
  $entryIds = ([regex]::Matches($_, '(?m)^-\s*(?:&\S+\s+)?[''"]?id[''"]?\s*:\s*\S')).Count
  return ($entryIds -ne 1)
})
# 与 uninstall.ps1 对称：判定条件与"是否删了东西"解耦——只要**改写后**的文本里仍有
# 一处 `id:` 指名本包，就会出现重复条目，必须出声（旧写法只在"一条都没删"时警告）。
# 结尾用分隔符前瞻而非 `$`：流式写法 `{id: 'x'}` 后面紧跟 `}`，用 `$` 会漏掉；
# 分隔符集合不含 `-`，兄弟包 `dsh-nori-pet-extras` 不会被误报。
# ⚠ 三处放宽都是为了"别漏报"（漏报 = 静默报成功，最坏）：
#   · `['""]?id['""]?`：JSON 写法 `{"id": "@bubblesalt/dsh-nori-pet"}` 也是合法 YAML，
#     旧式 `id\s*:` 被键名后的引号挡住 → 实测整条残留**零警告**；
#   · `(?:&\S+\s+)?`：值上带锚点 `- id: &nori 'dsh-nori-pet'` 同样漏过；
#   · `^[^#\r\n]*?`：只在**非注释行**上判定——`# 注意：id: dsh-nori-pet 那条是旧的`
#     这种纯提示性注释不该喊狼来了（误报会让真警告失去意义）。锚定行首故不受影响。
$keptText = ($keep -join '')
$leftoverRx = "(?m)^[^#\r\n]*?(?<![\w$])['""]?id['""]?\s*:\s*(?:&\S+\s+)?(?:![^\s']+\s+)?['""]?(?:@[\w.-]+/)?$([regex]::Escape($PkgShort))['""]?(?=[\s,'""\]\}#]|$)"
if ($keptText -cmatch $leftoverRx) {
  Write-Warning "cordis.patch.yml 里仍有一处 id: 指向 '$PkgShort'，本脚本没能安全改写它（可能用了缩进写法、流式数组，或该名字包在别的条目的 insert: 里）——即将写入的条目可能与之重复。请手动检查：$patchPath"
}
# 剥掉**顶层**（列 0）的独立 `[]` 占位行——历史上旧版 uninstall 无条件追加过它，留下的坏文件。
# ⚠ 必须锚定列 0：写成 `^\s*\[\s*\]\s*$` 会把别的插件条目里**嵌套的**空序列
#   （如 `  config:\n    list:\n      []`）一并删掉，静默改掉别人的配置（已实测 → list: null）。
# 允许行尾注释：`[] # was empty` 这种残留同样会让整份文件变成非法 YAML。
$keep   = @($keep | ForEach-Object { $_ -replace '(?m)^\[\s*\]\s*(?:#.*)?$', '' } | Where-Object { $_.Trim() -ne '' })

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

# 单引号 YAML 标量。⚠ 但**含换行的值必须换成双引号 + \n 转义**：
# personaPrompt / refPrompt 这类文本值天然可能多行，而单引号标量里的裸换行会让
#   (a) 续行落在**列 0** —— 若该行以 `- ` 开头，本脚本下一轮切块 `(?m)^(?=- )` 就把它
#       当成新条目：实测 personaPrompt 写 "- 保持简短 / - 不要自称AI" 时，三轮安装把
#       overlay 从 2 条撑到 6 条，数组里多了字符串元素，而每轮都报 entries=N + Install done；
#   (b) YAML 折叠把换行**变成空格**（实测 js-yaml 读回来是 "…宠物。 - 保持简短 - 不要自称AI"），
#       即使用户没写 `- `，值也被静默改掉。
# 双引号标量把 \n 写成转义序列 → 整条配置只占一行，绝不与切块器打架，且原值可无损还原。
function Y($v) {
  $s = [string]$v
  # YAML c-printable 之外的控制字符（含 DEL 与 C1 段）
  $ctrl = '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]'
  if ($s -match "[`r`n]" -or $s -match $ctrl) {
    $e = $s -replace '\\', '\\'
    $e = $e -replace '"', '\"'
    # ⚠ CR 与 LF 必须**分别**转义，不能把 CRLF 一律压成 \n：那样读回来是 LF，值被静默改写
    #   （实测 "l1`r`nl2" 往返后变成 "l1`nl2"）。YAML 双引号标量支持 \r，可以无损。
    $e = $e -replace "`r", '\r'
    $e = $e -replace "`n", '\n'
    $e = $e -replace "`t", '\t'
    # ⚠ 剩下的控制字符**必须**转成 \uXXXX。上一版的致命自相矛盾：判断条件里列出了
    #   0x00-0x08/0x0B/0x0C/0x0E-0x1F（意思是"这些得走双引号分支"），分支里却只转义了
    #   \ " CR LF TAB —— 于是 VT/FF/NUL/ESC/BEL 被**原样**写进双引号标量，js-yaml 直接抛
    #   "expected valid JSON character" / "null byte is not allowed in input"，install 从一份
    #   普通的 nori.config.json 起就永久卡死（且报的是"条目数不对"这种错误诊断）。
    $e = [regex]::Replace($e, $ctrl, [System.Text.RegularExpressions.MatchEvaluator] { param($m) '\u' + ([int][char]$m.Value).ToString('x4') })
    return '"' + $e + '"'
  }
  return "'" + ($s -replace "'", "''") + "'"
}
$cfg = @()
$cfg += "    assetsDir: $(Y $CfgModel)"
$cfg += "    coreFile: $(Y $CfgCore)"
$cfg += "    ttsUrl: $(Y $TtsUrl)"
$cfg += "    refPrompt: $(Y $RefPrompt)"
if ($RefAudio) { $cfg += "    refAudio: $(Y $RefAudio)" }
if ($GsvBase) { $cfg += "    gsvBase: $(Y $GsvBase)" }
if ($VenvPy)  { $cfg += "    venvPy: $(Y $VenvPy)" }

# 顶层运行时参数（可选）：nori.config.json 同名字段 → patch 键。
# 值类型按 Config schema（src/index.ts）：布尔/字符串按类型处理，其余数值（int/double/decimal）
# 裸写保留原值（含小数 0.9/1.2；0/负数视为未设置跳过）。allowedOrigins 为字符串数组。
# 未填的键跳过 → 插件用源码默认。
foreach ($k in @('maxSentence', 'detailMaxChars', 'summaryEnabled', 'summaryWaitMs', 'reframeDelayMs', 'ttsTemperature', 'ttsTopK', 'ttsSpeedFactor', 'ttsWatch', 'ttsWatchIntervalMs', 'personaPrompt', 'personaReframe')) {
  $v = $cfgFile.$k
  if ($null -eq $v) { continue }
  if ($v -is [bool]) { $cfg += "    ${k}: $(if ($v) { 'true' } else { 'false' })"; continue }
  if ($v -is [string]) { if ($v -eq '') { continue }; $cfg += "    ${k}: $(Y $v)"; continue }
  if ($v -le 0) { continue }  # 0/负数 → 未设置，跳过（防 '0' 字符串被 z.number 拒绝）
  $cfg += "    ${k}: $v"
}
$Origins = $cfgFile.allowedOrigins
if ($Origins -is [array] -and $Origins.Count -gt 0) {
  $cfg += '    allowedOrigins:'
  foreach ($o in $Origins) { if ([string]$o -ne '') { $cfg += "      - $(Y ([string]$o))" } }
}

# 改写层配置（可选）：nori.config.json 的 reframe 段 → patch 里的 `reframe` **对象**。
# ⚠ schema 已把 reframe 从"一串顶层 reframeXxx 键"改成单个对象（src/config.ts 的 z.object）：
#   顶层再写 reframeModel 之类属于未知键，会让整份 config 校验失败、插件根本挂不上。
# 键名与 src/config.ts 的 reframe 对象一致（baseUrl/model/maxTokens/...），不再接受旧前缀名
$ReframeCfg = $cfgFile.reframe
if ($ReframeCfg) {
  $ReframeKeys = @('baseUrl', 'model', 'maxTokens', 'timeoutMs', 'maxInput', 'trace', 'provider', 'apiKeyRef')
  $rfLines = @()
  foreach ($k in $ReframeKeys) {
    $v = $ReframeCfg.$k
    if ($null -eq $v) { continue }
    if ($v -is [bool]) {
      $rfLines += "      ${k}: $(if ($v) { 'true' } else { 'false' })"
      continue
    }
    # ⚠ 数值判定要覆盖 Int64（pwsh 的 ConvertFrom-Json 产物）：只认 [int]/[double] 会掉进字符串分支，
    #   写出 `timeoutMs: '60000'` → z.number 拒绝 → 整份 config 校验失败（历史坑）
    if ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [single] -or $v -is [decimal]) {
      $d = [double]$v
      if ($d -gt 0 -and [math]::Abs($d - [math]::Round($d)) -lt 1e-9) {
        $rfLines += "      ${k}: $([long][math]::Round($d))"
      }
      continue
    }
    $sv = [string]$v
    if ($sv -eq '') { continue }
    $rfLines += "      ${k}: $(Y $sv)"
  }
  if ($rfLines.Count -gt 0) {
    $cfg += '    reframe:'
    $cfg += $rfLines
  }
}

# 改写开关是独立字段 reframeEnabled（reframe 是参数对象，两者不可同名）
if ($null -ne $cfgFile.reframeEnabled) {
  $cfg += "    reframeEnabled: $(if ($cfgFile.reframeEnabled) { 'true' } else { 'false' })"
}

# 改写层专用 key（可选）：nori.config.json 的 reframe.apiKey → 写入 dsh credentials 的
# DEEPSEEK_NORI_API_KEY ref（与源码默认 reframeApiKeyRef=DEEPSEEK_NORI_API_KEY 一致，
# 插件 resolve 到即直连官方 API，否则回退 dsh llm）。逐行更新该 ref，不动其他 key；
# 未填 apiKey 则保持现有 credentials 不变。卸载时 uninstall.ps1 移除该 ref。
$ReframeKey = [string]$ReframeCfg.apiKey
if ($ReframeKey) {
  $CredPath = Join-Path $DshHome '.credentials.yaml'
  if (-not (Test-Path $DshHome)) { New-Item -ItemType Directory $DshHome -Force | Out-Null }
  $lines = @()
  # 行尾沿用原文件的（与 patch 写入同理）：旧写法一律用 `n 拼回去，会把 CRLF 的凭据文件
  # 整份改成 LF。⚠ 仍然用 ReadAllLines 拆行（它认得 CRLF/LF/单独 CR 三种），只把"拼接用的
  # 行尾"改成从原文探测 —— 换成自己 -split 会因为不认单独 CR 而把整份文件粘成一行、进而
  # 把 API key 追加到错误位置（那是比行尾严重得多的问题）。
  $credEol = "`n"
  $credExists = Test-Path $CredPath
  if ($credExists) {
    $credRaw = [System.IO.File]::ReadAllText($CredPath, [System.Text.Encoding]::UTF8)
    if ($credRaw -match "`r`n") { $credEol = "`r`n" }
    elseif ($credRaw -match "`r") { $credEol = "`r" }
    $lines = @([System.IO.File]::ReadAllLines($CredPath, [System.Text.Encoding]::UTF8))
  }
  $keyLine = '  DEEPSEEK_NORI_API_KEY: ' + $ReframeKey
  # ⚠ 旧写法是**无条件追加到最后一行**：它默认"文件里必有 refs:，且 refs: 是最后一个顶层键"。
  #   两种情况都会把整份凭据库写坏（实测）：
  #     ① 没有 refs: 段（如只有 version: 1）→ 追加出 "version: 1\n  KEY: sk-…" →
  #        js-yaml: bad indentation of a mapping entry → **整个凭据库不可解析**；
  #     ② refs: 后面还有别的顶层段 → 我们的 key 被塞进**后面那个段**里（缩进恰好合法，静默错位，
  #        dsh 的 credentials 服务永远解析不到 → API key 形同没写）。
  #   现在：定位顶层 refs: 行 → 有就在它**正下方**插入/就地更新；没有就补一个 refs: 段。
  $refsIdx = -1; $hit = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($refsIdx -lt 0 -and $lines[$i] -match '^refs\s*:\s*(#.*)?$') { $refsIdx = $i }
    if ($lines[$i] -match '^\s*DEEPSEEK_NORI_API_KEY\s*:') { $hit = $i; break }
  }
  if ($hit -ge 0) {
    $lines[$hit] = $keyLine                      # 已存在 → 就地替换（位置不变，不会挪段）
  } elseif ($refsIdx -ge 0) {
    $lines = @($lines[0..$refsIdx]) + @($keyLine) + $(if ($refsIdx + 1 -lt $lines.Count) { @($lines[($refsIdx + 1)..($lines.Count - 1)]) } else { @() })
  } else {
    # 没有 refs: 段：空文件/不存在 → 补上标准头部；已有其它内容 → 末尾另起一个顶层 refs: 段
    if (-not $credExists -or ($lines -join '').Trim() -eq '') { $lines = @('version: 1', 'refs:') }
    else { $lines = @($lines) + @('', 'refs:') }
    $lines += $keyLine
  }
  Write-U8 $CredPath (($lines -join $credEol) + $credEol)
  Write-Host "credentials: DEEPSEEK_NORI_API_KEY -> $CredPath"
} else {
  Write-Host 'credentials: reframe.apiKey 未填，跳过（现有 DEEPSEEK_NORI_API_KEY 保持不变）'
}

# Loader PatchOptions 格式（dsh-app-boot applyEntryPatches）：顶层数组条目 = {id, name?, config?, ...}，
# config 子键缩进 4 空格。禁止 update:/insert: 包装（非法字段会被静默跳过 → patch 从未生效：
# 曾致 refAudio 从未注入，直连 9880 正常但 /api/speak 一直 502 tts http 400）。
# 插件行本身由 bundle 层装配，这里只重写该行的 config（restate 全部字段，patch 是整块替换）。
# ⚠ 行尾必须沿用原文件（与 uninstall.ps1 对称）：旧写法在这里硬编码 `n，而 $keep 里的保留块
#   带着原文件的 CRLF —— 结果是"保留块 CRLF、我们这条裸 LF"的混合行尾（实测写完 15 处裸 LF）。
#   YAML 合法，但没有理由制造混合行尾；别处（uninstall）已经这么做了，install 漏了。
$eol = if ($content -match "`r`n") { "`r`n" } else { "`n" }
$entry = "- id: '$Pkg'$eol  config:$eol" + ($cfg -join $eol)

$out = @()
if ($keep.Count -gt 0) { $out += ($keep -join '') }
$out += $entry
$patchText = ($out -join $eol) + $eol

# ---- 5) 写盘前校验 + 备份 + 原子替换 ---------------------------------------
# ⚠ 顺序很重要：旧写法是"先覆盖 $patchPath，再用 js-yaml 校验"，一旦校验失败就已经
#   把 profile 的 patch 层写坏了，而且 install.ps1 从不留备份（uninstall.ps1 留）——
#   此时 dsh plugin add 早已执行、credentials 也已写入，脚本却以非零码退出，
#   用户以为"什么都没发生"。现在改为：先写临时文件 → 校验临时文件 → 备份 → 原子替换。
#   校验不过就整份不落地，profile 保持原样。
# 探测 dsh CLI 自带 js-yaml（不写死 npm 全局根路径；找不到则跳过校验，仅给警告）
$jsyaml = ''
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
# ⚠ $dshCmd.Source 可能为空（dsh 被解析成别名/函数时）：Split-Path -Parent '' 会抛
#   "Cannot bind argument to parameter 'Path' because it is an empty string"，
#   EAP=Stop 下会在**最后一步**中止安装（前面全都成功了）。
if ($dshCmd -and $dshCmd.Source) {
  $dshDir = Split-Path $dshCmd.Source -Parent
  foreach ($c in @(
    (Join-Path $dshDir 'node_modules\@deepseek-ai\dsh\node_modules\js-yaml'),
    (Join-Path $dshDir 'node_modules\js-yaml')
  )) {
    if (Test-Path $c) { $jsyaml = $c; break }
  }
}
$tmpPatch = "$patchPath.tmp"
Write-U8 $tmpPatch $patchText
# ⚠ 有 js-yaml 不代表有 node：校验器本身是 `node -e`。node 不在 PATH 时旧写法会在这里抛
#   "术语 'node' 不会被识别为…"（EAP=Stop）→ **安装死在最后一步**（此时 dsh plugin add 与
#   凭据写入都已经发生），而且 $gateCode 根本没机会赋值、exit 码→诊断的 switch 也跑不到，
#   与"找不到 js-yaml 就大声警告并跳过"的既定策略自相矛盾。这里把 node 也一起探测。
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$jsyaml = if ($nodeCmd) { $jsyaml } else { '' }
if ($jsyaml) {
  # 校验**我们这条**条目，不是 p[0]。我们的条目是 append 在最后的，别的插件条目可能排在前头，
  # 用 p[0] 等于在校验别人的条目（旧写法：多条目 patch 下这个校验基本没有意义）。
  # 顺带断言两件事：
  #  ① "恰好一条 id=<我们>"：若因缩进/流式写法没能清掉旧条目，这里立刻暴露，而不是留两条重复 id；
  #  ② **每个元素都必须是对象**：dsh 的 Loader patch 是"对象数组"，出现字符串元素说明文件
  #     已经被写坏了。旧写法只数我们自己的条目，于是实测这种坏文件（多行字符串被换行截断 →
  #     列 0 的 `- xxx` 被下一轮切块器当成新条目）会被判为"valid … entries=4"并报 Install done，
  #     用户的 patch 数组里就静静躺着字符串垃圾。注意这里**只要求是对象**、不要求带 id：
  #     真实环境里可能存在靠 name 等字段、没有小写 id 的条目（装载器会跳过它们），
  #     要求带 id 会把这类合法文件误判成坏文件而阻断安装。
  # ⚠ 必须用 **dsh 自己那套 schema** 解析：dsh 装载 patch 用的是
  #   cordis-plugin-include 里的 `yaml.JSON_SCHEMA.extend(JsExpr)`（自定义 !!js 标量类型，
  #   见 dsh-base/dsh-headless/dsh-web-app 自带的 cordis.patch.yml，它们自己就在用 !!js）。
  #   上一版这里用 js-yaml 的**默认** schema → 用户 patch 里只要有一处合法的 !!js
  #   （哪怕属于别的插件，或从 dsh 自带文件抄来的），校验就抛
  #   "unknown tag !<tag:yaml.org,2002:js>"，install/uninstall **永久**卡死，
  #   而且报出来的原因是"条目数不对"——完全指错方向。
  #   现在：schema 与 dsh 对齐（只多认 !!js，不放松任何结构要求），并且把失败原因
  #   分门别类打出来（exit 3/4/5/6/7 各对应一条准确诊断）。
  $jsGate = "const fs=require('fs');const y=require(process.argv[1]);const Js=new y.Type('tag:yaml.org,2002:js',{kind:'scalar',resolve:d=>typeof d==='string',construct:d=>({__jsExpr:d})});const sch=y.JSON_SCHEMA.extend(Js);let p;try{p=y.load(fs.readFileSync(process.argv[2],'utf8'),{schema:sch});}catch(e){console.log('PARSE_FAIL: '+String(e.message).split('\n')[0]);process.exit(7);}if(!Array.isArray(p)){console.log('NOT_ARRAY');process.exit(3);}if(!p.every(e=>e&&typeof e==='object'&&!Array.isArray(e))){console.log('BAD_ELEMENTS');process.exit(6);}const m=p.filter(e=>e.id===process.argv[3]);if(m.length!==1){console.log('ID_COUNT: '+m.length);process.exit(4);}if(!m[0].config||typeof m[0].config!=='object'||Array.isArray(m[0].config)){console.log('NO_CONFIG');process.exit(5);}console.log('overlay valid: id='+m[0].id+' entries='+p.length);"
  # ⚠ EAP 是 Stop，而 node 会往 stderr 写 YAMLException：直接 2>&1 会变成**终止性**
  #   NativeCommandError（实测），必须把偏好临时降下来再取输出。
  $eapPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $gateOut = (& node -e $jsGate $jsyaml $tmpPatch $Pkg 2>&1 | Out-String).Trim(); $gateCode = $LASTEXITCODE }
  finally { $ErrorActionPreference = $eapPrev }
  if ($gateCode -ne 0) {
    Remove-Item $tmpPatch -Force -ErrorAction SilentlyContinue
    $why = switch ($gateCode) {
      3 { 'overlay 顶层不是数组（dsh 的 Loader patch 要求"对象数组"）' }
      4 { "overlay 里 id=$Pkg 的条目不是恰好一条——最可能的原因：该文件的顶层序列是**缩进写法**或**流式写法**（`  - id:` / `[{id: …}]`），本脚本只认列 0 的 `- ` 切块，改不动它。为免误删你的其它条目，这里选择整份不落地" }
      5 { "id=$Pkg 的条目缺少 config 段" }
      6 { 'overlay 里存在**不是条目对象**的元素（缺 id 的字符串/标量）——常见原因：多行文本值曾被换行截断，或该文件是历史坏文件' }
      7 { "overlay 不是本校验器能解析的 YAML：$gateOut" }
      default { "未知校验失败（exit $gateCode）：$gateOut" }
    }
    throw "overlay validation failed (js-yaml, exit $gateCode)：$why；已放弃写入，$patchPath 保持原样。请手工清理该文件后重跑。"
  }
  # ⚠ 成功时也要把 node 的那行打出来：改成"捕获输出"之后，用户再也看不到
  #   "overlay valid: id=… entries=N" 了 —— 前一版是直接把 node 的 stdout 透到控制台。
  #   校验悄悄发生而没有任何可见证据，等于把"校验过了"这条信息弄丢了（自测时才发现）。
  Write-Host $gateOut
} else {
  if (-not $nodeCmd) {
    Write-Warning 'node 不在 PATH（校验器是 node 脚本），跳过 overlay 结构校验（不阻塞安装）——本次 overlay 未被校验，请自行确认 profile/cordis.patch.yml 仍是合法的对象数组。'
  } else {
    Write-Warning 'js-yaml 未在 dsh 安装目录找到，跳过 overlay 结构校验（不阻塞安装）——本次 overlay 未被校验，请自行确认 profile/cordis.patch.yml 仍是合法的对象数组。'
  }
}
if (Test-Path $patchPath) {
  Copy-Item $patchPath "$patchPath.bak" -Force
  Write-Host "overlay backup: $patchPath.bak"
}
try {
  Move-Item $tmpPatch $patchPath -Force
} catch {
  # 原子替换失败（例如目标被别的进程占着）：原文件没动，但别把 .tmp 留在 profile 目录里
  # 冒充正常文件。备份**故意保留**（它等于未改动的原文件，删备份比留垃圾更危险）。
  Remove-Item $tmpPatch -Force -ErrorAction SilentlyContinue
  throw "overlay 写入失败（$patchPath 未被改动，原文件保持原样；备份保留在 $patchPath.bak）：$($_.Exception.Message)"
}
Write-Host "overlay written: $patchPath"

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
  Write-Warning '未检测到授权人设文本（persona\prompt.txt）：Nori 口吻改写层将关闭，桌宠直接朗读原始输出。（改写任务指令 reframe.txt 随仓库提供；缺的只是授权的人设文本。）'
  Write-Host '  - 把已授权的人设文本放入 persona\ 目录（模板见 persona\.gitkeep 说明），重跑本脚本即可生效。'
}