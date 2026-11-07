# 仅容忍本树扫描队列中瞬时目录消失；其它读取错误和重解析点仍拒绝。
function Get-QaAuditChildren([string]$Directory) {
  $qaCurrent = [IO.Path]::GetFullPath($Directory)
  $qaBoundary = [IO.Path]::GetFullPath($env:QA_REPARSE_WORKTREE)
  if (-not $qaCurrent.StartsWith($qaBoundary + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'QA audit queue path escapes worktree'
  }
  try {
    $qaDirectoryItem = Get-Item -LiteralPath $qaCurrent -Force -ErrorAction Stop
    if ($qaDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'QA audit refuses queue directory reparse points'
    }
    Get-ChildItem -LiteralPath $qaCurrent -Force -ErrorAction Stop
  } catch {
    $qaConfirmedMissingError = ($_.FullyQualifiedErrorId -like 'PathNotFound,*' -and
      $_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound) -or
      ($_.FullyQualifiedErrorId -like 'DirIOError,*' -and
       $_.Exception -is [IO.DirectoryNotFoundException])
    if ($qaConfirmedMissingError -and
        -not (Test-Path -LiteralPath $qaCurrent)) {
      # CLI 原子移动种子目录可能以两种原生 ENOENT 返回；仅当前路径仍不存在才跳过。
      return
    }
    throw
  }
}
