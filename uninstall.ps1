#requires -Version 5.1
<#
.SYNOPSIS
  Uninstall the Nori desktop-pet plugin (@bubblesalt/dsh-nori-pet) from a dsh
  profile using the official dsh plugin API.

.DESCRIPTION
  `dsh plugin --profile <Profile> remove` (official: removes the dependency and
  its dsh.profile.bundles entry), then removes the config overlay entry from the
  profile's cordis.patch.yml (kept a valid top-level array), then removes the
  staging junction under %LOCALAPPDATA%\dsh-links and any leftover link junction
  under the profile's node_modules (dsh plugin remove may leave it dangling),
  plus the DEEPSEEK_NORI_API_KEY credentials ref if present. Never deletes repo
  sources. Idempotent; -DryRun only reports what would change.

.PARAMETER Profile
  Target dsh profile name. Default web.

.PARAMETER DryRun
  Report only; make no changes (the dsh plugin remove itself is skipped).

.PARAMETER KeepStagingLink
  Keep the %LOCALAPPDATA%\dsh-links junction (default: removed).

.EXAMPLE
  .\uninstall.ps1 -DryRun
.EXAMPLE
  .\uninstall.ps1
#>
param(
  [string]$Profile = 'web',
  [switch]$DryRun,
  [switch]$KeepStagingLink
)
$ErrorActionPreference = 'Stop'

$Pkg     = '@bubblesalt/dsh-nori-pet'
$PkgShort = 'dsh-nori-pet'
# 判定"某个 patch 条目是不是我们自己的"：只认**列 0 的**条目顶层 `- id:` 行。
# ⚠ 绝不能按子串 'dsh-nori-pet' 匹配——那会把"注释里提到该名字 / 配置值里含该名字 /
#   块标量里有该名字"的**其它插件条目**，乃至名字以它开头的**兄弟包**
#   （如 @someone/dsh-nori-pet-extras）整块删掉，属静默数据丢失（已实测复现）。
# ⚠ 这里**不能**写前导 `\s*`：`^\s*-\s*id:` 会命中别的条目里**嵌套**的 `- id: dsh-nori-pet`
#   （例如宿主条目里的 insert: 列表），于是把宿主条目整块删掉（已实测复现）。
#   锚定列 0 与本文件的分块方式 `'(?m)^(?=- )'` 保持一致。
# ⚠ 必须容忍"冒号前有空格"（`- id : 'x'`，合法 YAML）与锚点（`- &a id: 'x'`）：
#   漏认会让"卸载完成"变成假的（条目仍在 patch 里）。列 0 锚 + 块内 id 行数恰好为 1
#   这两道保险已兜住放宽后的风险。
$OursEntryRx = "(?m)^-\s*(?:&\S+\s+)?['""]?id['""]?\s*:\s*(?:&\S+\s+|![^\s]+\s+)?['""]?(?:@[\w.-]+/)?$([regex]::Escape($PkgShort))['""]?\s*(?:#.*)?$"
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfRoot = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path $ProfRoot)) { throw "profile not found: $ProfRoot (use -Profile)" }

function Write-U8($Path, $Content) {
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

$removed = @()

# ---- 1) official dsh plugin remove -----------------------------------------
Write-Host '==> dsh plugin remove (official API)'
if (-not $DryRun) {
  & dsh plugin --profile $Profile remove $Pkg
  if ($LASTEXITCODE -ne 0) { throw 'dsh plugin remove failed (see output above)' }
}
$removed += "dsh plugin remove (profile dependency + bundles + link)"

# ---- 2) config overlay entry cleanup (cordis.patch.yml) ---------------------
Write-Host '==> cordis.patch.yml: dsh-nori-pet overlay entry'
$patchPath = Join-Path $ProfRoot 'cordis.patch.yml'
# ⚠ 必须在 if (Test-Path) **之前**初始化：它原来只在块内初始化，而在块外（汇总行与最后那条
#   Write-Warning）被读取 —— patch 文件不存在时就是"读未定义变量"（当前输出恰好正确，纯属
#   运气：$null 为假）。Set-StrictMode 下会直接抛错。
$leftoverStale = $false
if (Test-Path $patchPath) {
  $content = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
  $blocks = @($content -split '(?m)^(?=- )' | Where-Object { $_.Trim() -ne '' })
  # 只删"**整块就是一个条目、且该条目是我们自己的**"的块。两道保险：
  #  ① $OursEntryRx 锚定列 0 的 `- id:`（不带前导 \s*），避免命中别的条目里嵌套的
  #     `- id: dsh-nori-pet` 而删掉宿主条目；
  #  ② 块内 `- id:` 行数必须**恰好为 1**。上面按列 0 分块，若用户用**缩进写法**或
  #     **流式数组** `[{id: ...}, {...}]` 写顶层数组，整份文件会落进同一个块，
  #     此时"删掉匹配到的那个块"等于删掉**所有**插件的条目（已实测复现，静默数据丢失）。
  $keep   = @($blocks | Where-Object {
    # ⚠ -cmatch（大小写敏感）：dsh 装载器按**小写** entry.id 建表，`- ID:` 不是我们的条目；
    #   默认 -match 大小写不敏感，与下面大小写敏感的 [regex]::Matches 口径不一致，
    #   会自相矛盾（实测 `- ID: 'dsh-nori-pet'` → 匹配=真、计数=0）。
    if (-not ($_ -cmatch $OursEntryRx)) { return $true }
    # ⚠ 计数只数**列 0** 的 `- id:`（与 $OursEntryRx 锚点一致）：带上前导 `\s*` 会把块内
    #   **嵌套**的 `- id: xxx` 也算进来，于是我们自己的块被判成"不止一条"→ 不删（该删的没删）。
    #   去掉后，缩进写法/流式数组的计数仍为 0 → 照样走"保留 + 警告"的安全路径。
    $entryIds = ([regex]::Matches($_, '(?m)^-\s*(?:&\S+\s+)?[''"]?id[''"]?\s*:\s*\S')).Count
    return ($entryIds -ne 1)
  })
  # 该删却没删干净时必须出声，不能静默放过：否则"卸载完成"是假的——patch 里仍留着
  # 指向已删插件的 id: 条目（dsh plugin remove 已经把包注销了，这一行再也解析不到）。
  # 判定条件刻意与"是否删了东西"解耦：即便删掉了我们的正常条目，只要**改写后**的
  # 文本里仍有一处 `id:` 指名本包（缩进写法 / 流式数组 / 包在别的条目的 insert: 里），
  # 就要警告（旧写法只在"一条都没删"时警告，于是这种半成品残留是静默的）。
  # 结尾用**分隔符前瞻**而不是 `$`：流式写法 `{id: '@bubblesalt/dsh-nori-pet'}` 后面紧跟 `}`，
  # 用 `$` 会漏掉（实测 H3 因此在该警告时静默）。分隔符集合刻意不含 `-`，
  # 这样兄弟包 `dsh-nori-pet-extras` 不会被误报。
  # ⚠ 三处放宽都是为了"别漏报"（漏报 = 静默报 Uninstall done，最坏）：
  #   · `['""]?id['""]?`：JSON 写法 `[{"id": "@bubblesalt/dsh-nori-pet"}]` 是合法 YAML，
  #     旧式 `id\s*:` 被键名后的引号挡住 → 实测整条残留零警告 + Uninstall done；
  #   · `(?:&\S+\s+)?`：值带锚点 `- id: &nori 'dsh-nori-pet'` 同样漏过（实测）；
  #   · `^[^#\r\n]*?`：只在**非注释行**上判定，`# 注意：id: dsh-nori-pet …` 这类纯提示
  #     注释不再误报（误报多了真警告就没人看了）。
  $keptText = ($keep -join '')
  $leftoverRx = "(?m)^[^#\r\n]*?(?<![\w$])['""]?id['""]?\s*:\s*(?:&\S+\s+)?(?:![^\s']+\s+)?['""]?(?:@[\w.-]+/)?$([regex]::Escape($PkgShort))['""]?(?=[\s,'""\]\}#]|$)"
  if ($keptText -cmatch $leftoverRx) {
    $leftoverStale = $true
    Write-Warning "cordis.patch.yml 改写后仍有一处 id: 指向 '$PkgShort'（可能用了缩进写法、流式数组，或该名字包在别的条目的 insert: 里），本脚本没能安全删除它。请手动检查：$patchPath"
  }
  # ⚠ 剥独立 `[]` 占位行这一步，以前写在 `if ($keep.Count -ne $blocks.Count)` **里面** ——
  #   即"只有确实删掉了我们的条目才执行"，恰好漏掉它真正针对的那批文件：旧版 uninstall
  #   无条件追加 `[]` 留下的 "<别的插件条目> + 独立 []" 组合。那是**两个根节点**的非法 YAML
  #   （js-yaml: "end of the stream or a document separator is expected"），整份用户 patch 层
  #   直接失效；而再跑一次 uninstall 什么都不做、还打印 Uninstall done、关卡也不跑（实测）。
  #   改为**无条件**剥离，并以"文本是否真的变了"决定要不要写盘（没有可清理内容时仍是纯幂等）。
  $stripped = @($keep | ForEach-Object { $_ -replace '(?m)^\[\s*\]\s*(?:#.*)?$', '' } | Where-Object { $_.Trim() -ne '' })
  # ⚠ 但"整份文件就只有 []" 不是残留，是**合法的空 overlay**（也有用户就这么写）。旧写法会把
  #   它当残留：多写一个 .bak、把 `[]`（无尾换行）改成 `[]\n`，还报 done: … overlay entry —— 
  #   明明什么都没删。这里认定为"无可清理内容"→ 纯幂等跳过（不进清理分支）。
  $onlyEmptyArray = ($content.Trim() -match '^\[\s*\]$')
  $residue = ($stripped.Count -ne $keep.Count) -or ((($stripped -join '') -cne $keptText))
  if ($onlyEmptyArray -and ($stripped.Count -eq 0) -and (-not $leftoverStale)) { $residue = $false }
  if ($residue) { $keep = $stripped }
  if (($keep.Count -ne $blocks.Count) -or $residue) {
    if ($residue -and ($keep.Count -eq $blocks.Count)) { $removed += 'cordis.patch.yml: 历史 [] 占位行（旧版遗留，会让整份文件非法）' }
    else { $removed += 'cordis.patch.yml: overlay entry' }
    if (-not $DryRun) {
      # 结果必须仍是合法的顶层 YAML 数组。
      # 关键：**只有"不剩任何条目行"时才能补 `[]`** —— 若还有别的插件条目，再追加 `[]`
      # 会让顶层出现第二个节点、整份文件变成非法 YAML
      # （js-yaml: "end of the stream or a document separator is expected"），
      # dsh 的用户 patch 层会直接失效。
      # 判定依据必须是"是否还剩**条目行**"，而不是"是否还剩非注释文本"：
      # 只剩 `---` 文档头（或 %YAML 指令）时，若照抄会写出 "---\n" → 解析成 null（不是数组），
      # 比旧代码的 "---\n[]\n" 更糟。故改为按 `^\s*- ` 判定。
      # 独立 `[]` 行已在上面无条件剥掉（与 install.ps1 对称）：只剥**列 0** 的，
      # 带前导 `\s*` 的宽版本会把别的插件条目里**嵌套的**空序列一并删掉（已实测 → list: null）。
      $head = ($keep -join '').TrimEnd()
      # 沿用文件原有的行尾风格：保留块是从原内容切出来的（带 CRLF），若这里写死 "`n"
      # 就会得到"CRLF 文件末尾夹一个裸 LF"的混合行尾（YAML 合法，但没必要）。
      $eol = if ($content -match "`r`n") { "`r`n" } else { "`n" }
      # 判定用 `^\s*- `（允许缩进）而不是 `^- `：若"残留区"里只有嵌套的 `- xxx`
      # （顶层根本不是序列），补 `[]` 会写出"映射 + 数组"两个节点 → 非法 YAML，
      # 比不补更糟。宽松判定在这里是"不要弄得更糟"的那一侧。
      if ($head -match '(?m)^\s*- ') {
        # 仍有其它条目：原样保留，绝不追加 []
        $newText = $head + $eol
      } elseif ($head) {
        # 只剩注释/文档头：补一个空数组占位，保持顶层是 YAML 数组
        $newText = $head + $eol + '[]' + $eol
      } else {
        $newText = '[]' + $eol
      }

      # 写盘前校验 + 备份 + 原子替换（与 install.ps1 对称）。
      # 旧写法直接覆盖 $patchPath 且**不做任何校验**：本脚本没有 install.ps1 那样的
      # js-yaml 关卡，一旦写出非法 YAML（例如残留 `[] # was empty` 这种注释形式），
      # 用户整份 profile patch 层失效，而脚本还报"卸载成功"。
      $tmpPatch = "$patchPath.tmp"
      Write-U8 $tmpPatch $newText
      $jsyaml = ''
      $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
      # $dshCmd.Source 为空（dsh 是别名/函数）时 Split-Path -Parent '' 会抛错
      if ($dshCmd -and $dshCmd.Source) {
        $dshDir = Split-Path $dshCmd.Source -Parent
        foreach ($c in @(
          (Join-Path $dshDir 'node_modules\@deepseek-ai\dsh\node_modules\js-yaml'),
          (Join-Path $dshDir 'node_modules\js-yaml')
        )) {
          if (Test-Path $c) { $jsyaml = $c; break }
        }
      }
      if ($jsyaml) {
        # 后置条件断言：结果必须是顶层数组、**每个元素都是对象**、且不再有任何条目指名本包。
        # "每个元素都是对象"这条是补的：dsh 的 Loader patch 是对象数组，字符串元素说明文件
        # 已经被写坏（例如多行字符串被换行截断后，列 0 的 `- xxx` 被当成条目）。
        # ⚠ schema 必须与 dsh 对齐：dsh 装载 patch 用 cordis-plugin-include 里的
        #   `yaml.JSON_SCHEMA.extend(JsExpr)`（自定义 !!js 标量），而 dsh 自带的
        #   cordis.patch.yml（base/headless/web-app）本身就在用 !!js。上一版这里用 js-yaml
        #   **默认** schema → 用户 patch 里有一处合法 !!js（哪怕属于别的插件）就会抛
        #   "unknown tag !<tag:yaml.org,2002:js>"，**永久**卸载不了，且报错指错方向。
        $jsGate = "const fs=require('fs');const y=require(process.argv[1]);const Js=new y.Type('tag:yaml.org,2002:js',{kind:'scalar',resolve:d=>typeof d==='string',construct:d=>({__jsExpr:d})});const sch=y.JSON_SCHEMA.extend(Js);let p;try{p=y.load(fs.readFileSync(process.argv[2],'utf8'),{schema:sch});}catch(e){console.log('PARSE_FAIL: '+String(e.message).split('\n')[0]);process.exit(7);}if(!Array.isArray(p)){console.log('NOT_ARRAY');process.exit(3);}if(!p.every(e=>e&&typeof e==='object'&&!Array.isArray(e))){console.log('BAD_ELEMENTS');process.exit(6);}if(p.some(e=>e.id===process.argv[3])){console.log('ID_LEFT');process.exit(4);}console.log('overlay valid after uninstall: entries='+p.length);"
        # EAP 是 Stop，node 往 stderr 写 YAMLException 时直接 2>&1 会变成终止性 NativeCommandError
        $eapPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { $gateOut = (& node -e $jsGate $jsyaml $tmpPatch $Pkg 2>&1 | Out-String).Trim(); $gateCode = $LASTEXITCODE }
        finally { $ErrorActionPreference = $eapPrev }
        if ($gateCode -ne 0) {
          Remove-Item $tmpPatch -Force -ErrorAction SilentlyContinue
          $why = switch ($gateCode) {
            3 { 'overlay 顶层不是数组（dsh 的 Loader patch 要求"对象数组"）' }
            4 { "清理后仍有 id=$Pkg 的条目——最可能的原因：该文件的顶层序列是**缩进写法**或**流式写法**（`  - id:` / `[{id: …}]`），本脚本只认列 0 的 `- ` 切块，改不动它。为免误删你的其它条目，这里选择整份不落地" }
            6 { 'overlay 里存在**不是条目对象**的元素（字符串/标量）——该文件可能已被写坏' }
            7 { "overlay 不是本校验器能解析的 YAML：$gateOut" }
            default { "未知校验失败（exit $gateCode）：$gateOut" }
          }
          throw "overlay validation failed (js-yaml, exit $gateCode)：$why；已放弃写入，$patchPath 保持原样。请手工检查该文件。"
        }
        # ⚠ 成功时也要打出来（与 install.ps1 对称）：改成"捕获输出"后，"overlay valid after
        #   uninstall: entries=N" 就此消失，用户失去了"校验确实跑过"的可见证据。
        Write-Host "    $gateOut"
      } else {
        # ⚠ 这里以前**什么都不说**（install.ps1 至少有一条警告）：校验被跳过后仍会照写，
        #   而本脚本末尾无条件打印 "Uninstall done"。没有校验就等于没有安全网，必须出声。
        Write-Warning 'js-yaml 未在 dsh 安装目录找到，跳过 overlay 结构校验（不阻塞卸载）——本次 overlay 未被校验，请自行确认 profile/cordis.patch.yml 仍是合法的对象数组。'
      }
      Copy-Item $patchPath "$patchPath.bak" -Force
      try {
        Move-Item $tmpPatch $patchPath -Force
      } catch {
        # 原子替换失败：原文件没动，但别把 .tmp 留在 profile 目录里冒充正常文件。
        # 备份**故意保留**（它等于未改动的原文件，删备份比留垃圾更危险）。
        Remove-Item $tmpPatch -Force -ErrorAction SilentlyContinue
        throw "overlay 写入失败（$patchPath 未被改动，原文件保持原样；备份保留在 $patchPath.bak）：$($_.Exception.Message)"
      }
      # 说明清楚：这只是 cordis.patch.yml 的备份。`dsh plugin remove` 在此之前已经改过
      # profile 的 package.json / dsh.profile.bundles 与 node_modules 链接，那些不在备份范围内。
      Write-Host "    backup (仅 cordis.patch.yml): $patchPath.bak"
    }
  }
}

# ---- 3) staging junction cleanup -------------------------------------------
Write-Host '==> staging junction (%LOCALAPPDATA%\dsh-links)'
$StagingLink = Join-Path $env:LOCALAPPDATA 'dsh-links\dsh-nori-pet'
if (-not $KeepStagingLink -and (Test-Path $StagingLink)) {
  $removed += "staging junction: $StagingLink"
  if (-not $DryRun) {
    $fi = Get-Item $StagingLink -Force
    $fi.Delete()
  }
}

# ---- 3b) profile node_modules link cleanup ---------------------------------
# dsh plugin remove 会清 dependencies/bundles 声明，但 profile node_modules 下的 link
# junction 可能残留（悬空：target 已被上一步删掉的 staging link）。这里主动删除该包
# 对应路径；scope 目录删空后一并移除。只删 junction 本体（LinkType 校验），不碰 target。
Write-Host '==> profile node_modules link'
$nmRoot = Join-Path $ProfRoot 'node_modules'
$scopeName, $bareName = $Pkg -split '/', 2
$nmLink = if ($scopeName -like '@*') { Join-Path (Join-Path $nmRoot $scopeName) $bareName } else { Join-Path $nmRoot $Pkg }
if (Test-Path $nmLink) {
  $it = Get-Item $nmLink -Force
  if ($it.LinkType -eq 'Junction') {
    $removed += "node_modules link: $nmLink"
    if (-not $DryRun) { $it.Delete() }
  } else {
    Write-Host "    $nmLink 存在但不是 junction，跳过（不删除非链接内容）"
  }
  if ($scopeName -like '@*') {
    $scopeDir = Join-Path $nmRoot $scopeName
    if ((Test-Path $scopeDir) -and -not (Get-ChildItem $scopeDir -Force -ErrorAction SilentlyContinue)) {
      $removed += "空 scope 目录: $scopeDir"
      if (-not $DryRun) { Remove-Item $scopeDir -Force }
    }
  }
}

# ---- 4) credentials cleanup: DEEPSEEK_NORI_API_KEY ref ----------------------
# 移除安装脚本写入的改写层专用 key ref（DEEPSEEK_NORI_API_KEY），保留其他 key 不动。
Write-Host '==> credentials: remove DEEPSEEK_NORI_API_KEY ref'
$CredPath = Join-Path $DshHome '.credentials.yaml'
if (Test-Path $CredPath) {
  $lines = @([System.IO.File]::ReadAllLines($CredPath, [System.Text.Encoding]::UTF8))
  $kept = @($lines | Where-Object { $_ -notmatch '^\s*DEEPSEEK_NORI_API_KEY\s*:' })
  if ($kept.Count -ne $lines.Count) {
    $removed += 'credentials: DEEPSEEK_NORI_API_KEY ref'
    if (-not $DryRun) {
      # 行尾沿用原文件（与 install.ps1 对称）：写死 `n 会把 CRLF 的凭据文件整份改成 LF
      $credEol = "`n"
      $credRaw = [System.IO.File]::ReadAllText($CredPath, [System.Text.Encoding]::UTF8)
      if ($credRaw -match "`r`n") { $credEol = "`r`n" } elseif ($credRaw -match "`r") { $credEol = "`r" }
      Write-U8 $CredPath (($kept -join $credEol) + $credEol)
    }
  } else {
    Write-Host '    no DEEPSEEK_NORI_API_KEY ref found; nothing to remove'
  }
}

Write-Host ''
if ($DryRun) {
  Write-Host '[DryRun] would:'
  $removed | ForEach-Object { Write-Host "  - $_" }
  Write-Host ''
  Write-Host 'Nothing changed.'
} else {
  # ⚠ 残留条目时不能说"干净卸载"：上面那条警告之后如果这里无条件打印 Uninstall done，
  #   用户看到的就是"成功"，而 cordis.patch.yml 里那条指向本包的条目还在（dsh 会静默跳过它，
  #   于是"卸载了但配置层还有幽灵条目"）。保留"不误删别人条目"的安全取舍（删缩进的
  #   `- id:` 可能删掉别的插件 config 里嵌套的同名对象），但必须把"没删干净"说清楚。
  if ($leftoverStale) {
    Write-Host 'Uninstall done (official API, idempotent) —— 但未完全干净：'
  } else {
    Write-Host 'Uninstall done (official API, idempotent).'
  }
  $removed | ForEach-Object { Write-Host "  - done: $_" }
  if ($leftoverStale) {
    Write-Warning "未完成项：cordis.patch.yml 里仍有一条指向 $PkgShort 的条目（见上方警告）。dsh 装载时会静默跳过它，但请手工删除以免留下幽灵条目。"
  }
  Write-Host '  - Restart dsh for a fully clean state.'
}