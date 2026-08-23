#requires -Version 5.1
<#
.SYNOPSIS
  Uninstall the Nori desktop-pet plugin (@dsh-external/dsh-nori-pet) from a dsh
  profile using the official dsh plugin API.

.DESCRIPTION
  `dsh plugin --profile <Profile> remove` (official: removes the dependency,
  its node_modules link and the dsh.profile.bundles entry), then removes the
  config overlay entry from the profile's cordis.patch.yml (kept a valid
  top-level array), then removes the staging junction under
  %LOCALAPPDATA%\dsh-links. Never deletes repo sources. Idempotent;
  -DryRun only reports what would change.

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

$Pkg     = '@dsh-external/dsh-nori-pet'
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