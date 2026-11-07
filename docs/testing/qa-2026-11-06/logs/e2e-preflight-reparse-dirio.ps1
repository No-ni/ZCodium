$ErrorActionPreference = 'Stop'
$qaWorktree = 'C:\vibecoding\zcodium'
$qaProbeRoot = Join-Path $qaWorktree ('docs\testing\qa-2026-11-06\runtime\qa-dirio-probe-' + [Guid]::NewGuid().ToString('N'))
if (-not [IO.Path]::GetFullPath($qaProbeRoot).StartsWith($qaWorktree + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Probe escapes worktree' }
$qaAncestor = $qaProbeRoot
while ($qaAncestor) {
  if ((Test-Path -LiteralPath $qaAncestor) -and ((Get-Item -LiteralPath $qaAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Probe refuses reparse ancestors' }
  $qaAncestor = [IO.Path]::GetDirectoryName($qaAncestor)
}
New-Item -ItemType Directory -Path $qaProbeRoot | Out-Null
$env:QA_REPARSE_WORKTREE = $qaWorktree
. ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $qaWorktree 'docs\testing\qa-2026-11-06\qa-reparse-children.ps1'))))
$qaResults = @()
$script:qaRemoveDuringEnumeration = $true
$script:qaExpectedException = [IO.DirectoryNotFoundException]::new('synthetic native directory disappearance')
function Get-ChildItem {
  [CmdletBinding()]
  param([string]$LiteralPath, [switch]$Force)
  if ($script:qaRemoveDuringEnumeration) { Remove-Item -LiteralPath $LiteralPath -ErrorAction Stop }
  $qaError = [Management.Automation.ErrorRecord]::new($script:qaExpectedException, 'DirIOError', [Management.Automation.ErrorCategory]::ReadError, $LiteralPath)
  $PSCmdlet.ThrowTerminatingError($qaError)
}
$qaGone = Join-Path $qaProbeRoot 'gone'
New-Item -ItemType Directory -Path $qaGone | Out-Null
$qaResults += @{name='DirectoryNotFoundException/DirIOError after initial Get-Item and removal accepted'; passed=(@(Get-QaAuditChildren $qaGone).Count -eq 0 -and -not(Test-Path -LiteralPath $qaGone))}
$script:qaRemoveDuringEnumeration = $false
$qaExisting = Join-Path $qaProbeRoot 'existing'
New-Item -ItemType Directory -Path $qaExisting | Out-Null
$qaRejected = $false
try { Get-QaAuditChildren $qaExisting | Out-Null } catch { $qaRejected = $true }
$qaResults += @{name='DirectoryNotFoundException with existing path rejected'; passed=$qaRejected}
$script:qaRemoveDuringEnumeration = $true
$script:qaExpectedException = [IO.IOException]::new('synthetic other IO failure')
$qaOther = Join-Path $qaProbeRoot 'other-error'
New-Item -ItemType Directory -Path $qaOther | Out-Null
$qaRejected = $false
try { Get-QaAuditChildren $qaOther | Out-Null } catch { $qaRejected = $true }
$qaResults += @{name='Other IOException with missing path and DirIOError rejected'; passed=$qaRejected}
Remove-Item -LiteralPath Function:\Get-ChildItem
$qaEvidence = @{capturedAt=[DateTime]::UtcNow.ToString('o'); probeRoot=$qaProbeRoot; evidenceKind='QA guard exception classification probes; synthetic native error record, not UI acceptance'; results=$qaResults}
$qaTarget = Join-Path $qaWorktree 'docs\testing\qa-2026-11-06\logs\e2e-preflight-reparse-dirio.json'
[IO.File]::WriteAllText($qaTarget, ($qaEvidence | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
$qaEvidence | ConvertTo-Json -Depth 6
if (@($qaResults | Where-Object { -not $_.passed }).Count) { exit 1 }
