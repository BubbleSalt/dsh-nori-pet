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
if (Test-Path $patchPath) {
  $content = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
  $blocks = @($content -split '(?m)^(?=- )' | Where-Object { $_.Trim() -ne '' })
  $keep   = @($blocks | Where-Object { $_ -notmatch 'dsh-nori-pet' })
  if ($keep.Count -ne $blocks.Count) {
    $removed += 'cordis.patch.yml: overlay entry'
    if (-not $DryRun) {
      # result must stay a top-level YAML array (dsh requires it); append [] after any comment
      $head = ($keep -join '').TrimEnd()
      if ($head) { Write-U8 $patchPath ($head + "`n[]`n") }
      else       { Write-U8 $patchPath "[]`n" }
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
    if (-not $DryRun) { Write-U8 $CredPath (($kept -join "`n") + "`n") }
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
  Write-Host 'Uninstall done (official API, idempotent).'
  $removed | ForEach-Object { Write-Host "  - done: $_" }
  Write-Host '  - Restart dsh for a fully clean state.'
}