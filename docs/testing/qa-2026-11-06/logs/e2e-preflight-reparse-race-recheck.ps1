$ErrorActionPreference = 'Stop'
$qaRepo = 'C:\vibecoding\zcodium'
$qaProbeRoot = Join-Path $qaRepo ('docs\testing\qa-2026-11-06\runtime\qa-reparse-race-' + [Guid]::NewGuid().ToString('N'))
if (-not [IO.Path]::GetFullPath($qaProbeRoot).StartsWith($qaRepo + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Probe escapes worktree' }
$qaCursor = $qaProbeRoot
while ($qaCursor) {
  if ((Test-Path -LiteralPath $qaCursor) -and ((Get-Item -LiteralPath $qaCursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Probe refuses reparse ancestors' }
  $qaCursor = [IO.Path]::GetDirectoryName($qaCursor)
}
New-Item -ItemType Directory -Path $qaProbeRoot | Out-Null
$env:QA_REPARSE_WORKTREE = $qaRepo
. ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $qaRepo 'docs\testing\qa-2026-11-06\qa-reparse-children.ps1'))))
$qaResults = @()
$qaExisting = Join-Path $qaProbeRoot 'existing'
$qaGone = Join-Path $qaProbeRoot 'gone-during-enumeration'
$qaLink = Join-Path $qaProbeRoot 'junction'
New-Item -ItemType Directory -Path $qaExisting,$qaGone | Out-Null
$qaResults += @{ name='existing empty directory'; passed=(@(Get-QaAuditChildren $qaExisting).Count -eq 0) }

# 首次Get-Item仍存在，枚举入口时真实移除空目录，原生Get-ChildItem产生PathNotFound。
$script:qaRemoveAtEnumeration = $qaGone
function Get-ChildItem {
  param([string]$LiteralPath, [switch]$Force, [string]$ErrorAction)
  if ($LiteralPath -eq $script:qaRemoveAtEnumeration) {
    Remove-Item -LiteralPath $LiteralPath -ErrorAction Stop
    $script:qaRemoveAtEnumeration = $null
  }
  Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $LiteralPath -Force -ErrorAction Stop
}
$qaResults += @{ name='directory disappeared after initial Get-Item; native ENOENT skipped'; passed=(@(Get-QaAuditChildren $qaGone).Count -eq 0 -and -not(Test-Path -LiteralPath $qaGone)) }
Remove-Item -LiteralPath Function:\Get-ChildItem

function Get-ChildItem {
  param([string]$LiteralPath, [switch]$Force, [string]$ErrorAction)
  Write-Error 'synthetic path-not-found while directory still exists' -ErrorId PathNotFound -Category ObjectNotFound -ErrorAction Stop
}
$qaRejected = $false
try { Get-QaAuditChildren $qaExisting | Out-Null } catch { $qaRejected = $true }
$qaResults += @{ name='PathNotFound with existing path still rejected'; passed=$qaRejected }
Remove-Item -LiteralPath Function:\Get-ChildItem

function Get-ChildItem {
  param([string]$LiteralPath, [switch]$Force, [string]$ErrorAction)
  Write-Error 'synthetic access denied' -ErrorId PermissionDenied -Category PermissionDenied -ErrorAction Stop
}
$qaRejected = $false
try { Get-QaAuditChildren $qaExisting | Out-Null } catch { $qaRejected = $true }
$qaResults += @{ name='permission error still rejected'; passed=$qaRejected }
Remove-Item -LiteralPath Function:\Get-ChildItem

$qaRejected = $false
try { Get-QaAuditChildren 'C:\Users' | Out-Null } catch { $qaRejected = $true }
$qaResults += @{ name='outside-worktree queue rejected before read'; passed=$qaRejected }
New-Item -ItemType Junction -Path $qaLink -Target $qaExisting | Out-Null
$qaRejected = $false
try { Get-QaAuditChildren $qaLink | Out-Null } catch { $qaRejected = $true }
$qaResults += @{ name='bounded in-worktree junction rejected before enumeration'; passed=$qaRejected }
Remove-Item -LiteralPath $qaLink -ErrorAction Stop
$qaEvidence = @{ capturedAt=[DateTime]::UtcNow.ToString('o'); evidenceKind='Bounded QA-only PowerShell dynamic directory deletion and rejection branch probes; no application launched'; probeRoot=$qaProbeRoot; results=$qaResults }
$qaTarget = Join-Path $qaRepo 'docs\testing\qa-2026-11-06\logs\e2e-preflight-reparse-race-recheck.json'
[IO.File]::WriteAllText($qaTarget, ($qaEvidence | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$qaEvidence | ConvertTo-Json -Depth 8
if (@($qaResults | Where-Object { -not $_.passed }).Count) { exit 1 }
