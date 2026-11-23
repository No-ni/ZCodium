param(
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][string]$LinkPath
)
$ErrorActionPreference = 'Stop'
$taskWorkspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskRootPrefix = $taskWorkspaceRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
function Assert-ProjectFixturePath([string]$InputPath) {
  $taskFullPath = [IO.Path]::GetFullPath($InputPath)
  if (-not $taskFullPath.StartsWith($taskRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'PROJECT_TEST_PATH_REJECTED'
  }
  if ($taskFullPath.IndexOfAny([char[]]'*?[]') -ge 0) { throw 'PROJECT_TEST_PATH_REJECTED' }
  $taskAncestor = $taskFullPath
  while ($taskAncestor -and $taskAncestor.StartsWith($taskWorkspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $taskAncestor) {
      $taskItem = Get-Item -LiteralPath $taskAncestor -Force
      if (($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'PROJECT_TEST_PATH_REJECTED'
      }
    }
    if ($taskAncestor.Equals($taskWorkspaceRoot, [StringComparison]::OrdinalIgnoreCase)) { break }
    $taskAncestor = [IO.Path]::GetDirectoryName($taskAncestor)
  }
  return $taskFullPath
}
$taskTarget = Assert-ProjectFixturePath $TargetPath
$taskLink = Assert-ProjectFixturePath $LinkPath
if (-not (Test-Path -LiteralPath $taskTarget) -or (Test-Path -LiteralPath $taskLink)) {
  throw 'PROJECT_TEST_SYMLINK_PRECONDITION_FAILED'
}
New-Item -ItemType SymbolicLink -Path $taskLink -Target $taskTarget | Out-Null
