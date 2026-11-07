param(
  [string]$RunId = 'qa-menu-20261106-smoke',
  [string]$Specs = './test/e2e/smoke.test.ts',
  [switch]$Bootstrap,
  [string]$Grep = '',
  [switch]$OpenSidePane,
  [string]$ReplayFixtures = '',
  [switch]$SafeTerminal,
  [switch]$SafeGit,
  [switch]$GroupedTarget
)

$ErrorActionPreference = 'Stop'
$qaWorkspace = 'C:\vibecoding\zcodium'
$qaRuntime = Join-Path $qaWorkspace ('docs\testing\qa-2026-11-06\runtime\' + $RunId)
if ($RunId -notmatch '^qa-[a-z0-9-]+$') { throw 'Invalid QA run id' }
if ($SafeGit -and $RunId -ne 'qa-menu-20261106-local-supplement-retry') { throw 'SafeGit requires its reviewed unique run' }
if ($GroupedTarget -and (-not $Bootstrap -or $RunId -ne 'qa-menu-20261106-grp-pin-grouped' -or
    $Specs -ne './test/e2e/conversation-session/conversation-session-task-groups.test.ts' -or
    $Grep -ne '(?:^| )GRP04/05/06：组内首发、三视图菜单、置顶/归档和恢复保持成员$')) {
  throw 'GroupedTarget requires its reviewed canonical case and unique run'
}
if (($SafeGit -or $GroupedTarget) -and (Test-Path -LiteralPath $qaRuntime)) { throw 'Final QA controls require a new runtime' }

function Assert-QaPath([string]$Candidate) {
  $qaResolved = [IO.Path]::GetFullPath($Candidate)
  if (-not $qaResolved.StartsWith($qaWorkspace + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'QA path escapes workspace'
  }
  $qaAncestor = $qaResolved
  while ($qaAncestor -and $qaAncestor.Length -ge $qaWorkspace.Length) {
    if (Test-Path -LiteralPath $qaAncestor) {
      $qaItem = Get-Item -LiteralPath $qaAncestor -Force
      if ($qaItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw ('QA path has reparse point: ' + $qaAncestor)
      }
    }
    $qaAncestor = [IO.Path]::GetDirectoryName($qaAncestor)
  }
}

foreach ($qaSpec in $Specs.Split(',')) {
  $qaSpecPath = [IO.Path]::GetFullPath((Join-Path (Join-Path $qaWorkspace 'packages\desktop') $qaSpec))
  Assert-QaPath $qaSpecPath
  if (-not ($qaSpecPath.EndsWith('.test.ts') -and (Test-Path -LiteralPath $qaSpecPath -PathType Leaf))) {
    throw 'QA spec must be an existing workspace .test.ts file'
  }
}
$qaReviewedReplayFixtures = @()
if ($ReplayFixtures) {
  # 混合 pending/canonical 批次必须显式覆盖 case-local；common-only 会抑制自动选择。
  $env:QA_REPARSE_WORKTREE = $qaWorkspace
  $qaEnumerationGuard = Join-Path $qaWorkspace 'docs\testing\qa-2026-11-06\qa-reparse-children.ps1'
  Assert-QaPath $qaEnumerationGuard
  . $qaEnumerationGuard
  foreach ($qaFixture in $ReplayFixtures.Split(',')) {
    if (-not $qaFixture.Trim()) { throw 'Empty QA replay fixture path' }
    $qaFixturePath = [IO.Path]::GetFullPath((Join-Path (Join-Path $qaWorkspace 'packages\desktop') $qaFixture.Trim()))
    Assert-QaPath $qaFixturePath
    if (-not ($qaFixturePath.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $qaFixturePath -PathType Leaf))) {
      throw 'QA replay fixture must be an existing workspace .json file'
    }
    $qaReviewedReplayFixtures += $qaFixturePath
  }
  foreach ($qaFixtureParent in ($qaReviewedReplayFixtures | ForEach-Object { [IO.Path]::GetDirectoryName($_) } | Select-Object -Unique)) {
    $qaQueue = [Collections.Generic.Queue[string]]::new()
    $qaQueue.Enqueue($qaFixtureParent)
    while ($qaQueue.Count) {
      foreach ($qaChild in Get-QaAuditChildren $qaQueue.Dequeue()) {
        if ($qaChild.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'QA replay fixture tree contains reparse point' }
        if ($qaChild.PSIsContainer) { $qaQueue.Enqueue($qaChild.FullName) }
      }
    }
  }
}
Assert-QaPath $qaRuntime
if (Test-Path -LiteralPath $qaRuntime) {
  foreach ($qaEntry in Get-ChildItem -LiteralPath $qaRuntime -Recurse -Force) {
    if ($qaEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Existing QA runtime has reparse point' }
  }
}

foreach ($qaBuildTarget in @('out', '.e2e-cache', 'bundled-agents')) {
  $qaBuildPath = Join-Path $qaWorkspace ('packages\desktop\' + $qaBuildTarget)
  Assert-QaPath $qaBuildPath
  if (Test-Path -LiteralPath $qaBuildPath) {
    foreach ($qaEntry in Get-ChildItem -LiteralPath $qaBuildPath -Recurse -Force) {
      if ($qaEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw ('Build target contains reparse point: ' + $qaEntry.FullName)
      }
    }
  }
}
foreach ($qaName in @('tool-home','app-home','tmp','appdata','localappdata','corepack','pnpm-home','npm-cache','cache','evidence','network','bin')) {
  $qaPath = Join-Path $qaRuntime $qaName
  Assert-QaPath $qaPath
  New-Item -ItemType Directory -Path $qaPath -Force | Out-Null
}

# 子进程必须继承工作树内的用户目录和临时目录，不能回落真实用户配置。
foreach ($qaEnvName in [Environment]::GetEnvironmentVariables('Process').Keys) {
  if ($qaEnvName -match '^(ZCODE_|E2E_PROVIDER_|QA_BOOTSTRAP_|QA_SAFE_GIT_)' -or ($SafeGit -and $qaEnvName -match '^GIT_')) {
    [Environment]::SetEnvironmentVariable($qaEnvName, $null, 'Process')
  }
}
$qaBindings = @{
  HOME='tool-home'; USERPROFILE='tool-home'; TEMP='tmp'; TMP='tmp'; TMPDIR='tmp';
  APPDATA='appdata'; LOCALAPPDATA='localappdata'; COREPACK_HOME='corepack';
  PNPM_HOME='pnpm-home'; npm_config_cache='npm-cache'; XDG_CACHE_HOME='cache';
  XDG_CONFIG_HOME='tool-home'; XDG_DATA_HOME='tool-home';
  ZCODE_E2E_HOME_DIR='app-home'; ZCODE_E2E_ARTIFACT_DIR='evidence';
  ZCODE_E2E_NETWORK_CAPTURE_DIR='network'; ZCODE_E2E_CERT_CACHE_DIR='cache'
  E2E_IMAGE_ACTION_SCREENSHOTS='evidence\image-actions'; E2E_IMAGE_COPY_SCREENSHOTS='evidence\image-copy'
}
foreach ($qaBinding in $qaBindings.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($qaBinding.Key, (Join-Path $qaRuntime $qaBinding.Value), 'Process')
}
# 既有归档等用例明确只接受 E2E HOME 前缀；保持该防护，给新 run 使用规范名称。
$qaAppHome = Join-Path $qaRuntime ('.e2e-home-' + $RunId)
Assert-QaPath $qaAppHome
New-Item -ItemType Directory -Path $qaAppHome -Force | Out-Null
$env:ZCODE_E2E_HOME_DIR = $qaAppHome
$env:ZCODE_E2E_RUN_ID = $RunId
$env:ZCODE_ENV = 'production'
$env:E2E_PROVIDER_HTTP_MODE = 'replay'
$env:ZCODE_E2E_KEEP_HOME_ON_FAIL = '1'
$env:ZCODE_E2E_MAX_INSTANCES = '1'
if ($Grep) { $env:ZCODE_E2E_MOCHA_GREP = $Grep }
if ($OpenSidePane) { $env:QA_BOOTSTRAP_OPEN_SIDE_PANE = '1' }
if ($GroupedTarget) { $env:QA_BOOTSTRAP_GROUPED_TARGET = '1' }
$env:COREPACK_DEFAULT_TO_LATEST = '0'
$env:COREPACK_ENABLE_AUTO_PIN = '0'
$env:COREPACK_ENABLE_NETWORK = '0'
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = 'false'
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
$env:PNPM_HOME = Join-Path $qaRuntime 'pnpm-home'
$env:NODE_OPTIONS = ''
$env:NODE_COMPILE_CACHE = Join-Path $qaRuntime 'cache\node-compile'
$env:TSX_CACHE_DIR = Join-Path $qaRuntime 'cache\tsx'
$env:npm_config_store_dir = Join-Path $qaRuntime 'cache\pnpm-store'
$env:npm_config_userconfig = Join-Path $qaRuntime 'tool-home\.npmrc'
[IO.File]::WriteAllText($env:npm_config_userconfig, '', [Text.UTF8Encoding]::new($false))
if ($SafeGit) {
  # 合成 Git 只读取本 run 空配置；实际 Host 继承和 repo local 配置由 suite 再验。
  $qaGitRoot = Join-Path $qaRuntime 'git-isolation'
  Assert-QaPath $qaGitRoot
  New-Item -ItemType Directory -Path $qaGitRoot | Out-Null
  foreach ($qaGitDir in @('templates', 'hooks')) {
    $qaGitPath = Join-Path $qaGitRoot $qaGitDir
    Assert-QaPath $qaGitPath
    New-Item -ItemType Directory -Path $qaGitPath | Out-Null
  }
  foreach ($qaGitFile in @('global.gitconfig', 'system.gitconfig', 'attributes')) {
    $qaGitPath = Join-Path $qaGitRoot $qaGitFile
    Assert-QaPath $qaGitPath
    $qaGitStream = [IO.File]::Open($qaGitPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $qaGitStream.Dispose()
  }
  $env:GIT_CONFIG_GLOBAL = Join-Path $qaGitRoot 'global.gitconfig'
  $env:GIT_CONFIG_SYSTEM = Join-Path $qaGitRoot 'system.gitconfig'
  $env:GIT_CONFIG_NOSYSTEM = '1'
  $env:GIT_TEMPLATE_DIR = Join-Path $qaGitRoot 'templates'
  $env:QA_SAFE_GIT_WORKTREE = $qaWorkspace
  $env:QA_SAFE_GIT_ROOT = $qaGitRoot
}
if ($SafeTerminal) {
  # PTY 会加载 profile；先限制模块和缓存入口，suite 再按真实继承环境拒绝外树 profile。
  $qaSystemModuleRoots = @('C:\Program Files\PowerShell\7\Modules', 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules')
  foreach ($qaModuleRoot in $qaSystemModuleRoots) {
    if (-not (Test-Path -LiteralPath $qaModuleRoot -PathType Container)) { throw 'Required installed PowerShell module root missing' }
    $qaCursor = $qaModuleRoot
    while ($qaCursor) {
      $qaItem = Get-Item -LiteralPath $qaCursor -Force -ErrorAction Stop
      if ($qaItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installed PowerShell module ancestor is a reparse point' }
      $qaCursor = [IO.Path]::GetDirectoryName($qaCursor)
    }
    foreach ($qaEntry in Get-ChildItem -LiteralPath $qaModuleRoot -Recurse -Force -ErrorAction Stop) {
      if ($qaEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installed PowerShell module tree contains reparse point' }
    }
  }
  $env:PSModulePath = $qaSystemModuleRoots -join ';'
  $env:PSModuleAnalysisCachePath = Join-Path $qaRuntime 'cache\pwsh-module-analysis'
  Assert-QaPath $env:PSModuleAnalysisCachePath
  $env:POWERSHELL_TELEMETRY_OPTOUT = '1'
  $env:QA_SAFE_TERMINAL_WORKTREE = $qaWorkspace
  $qaTerminalProbe = @'
$ErrorActionPreference='Stop'
$qaRoot=$env:QA_SAFE_TERMINAL_WORKTREE
$qaKnown=@('C:\Program Files\PowerShell\7\Modules','C:\Windows\System32\WindowsPowerShell\v1.0\Modules')
function Assert-QaTerminalAncestor([string]$qaPath) {
  $qaCursor=[IO.Path]::GetFullPath($qaPath)
  while($qaCursor) {
    if(Test-Path -LiteralPath $qaCursor) {
      if((Get-Item -LiteralPath $qaCursor -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'QA terminal refuses redirected startup path' }
    }
    $qaCursor=[IO.Path]::GetDirectoryName($qaCursor)
  }
}
$qaShell=(Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if($qaShell -ne 'C:\Program Files\PowerShell\7\pwsh.exe') { throw 'QA terminal PATH resolves an unexpected shell' }
Assert-QaTerminalAncestor $qaShell
$qaProfiles=@(@{label='AllUsersAllHosts';path=$PROFILE.AllUsersAllHosts},@{label='AllUsersCurrentHost';path=$PROFILE.AllUsersCurrentHost},@{label='CurrentUserAllHosts';path=$PROFILE.CurrentUserAllHosts},@{label='CurrentUserCurrentHost';path=$PROFILE.CurrentUserCurrentHost})
$qaProfileMarkers=@()
foreach($qaProfile in $qaProfiles) {
  Assert-QaTerminalAncestor $qaProfile.path
  $qaInside=$qaProfile.path.StartsWith($qaRoot+'\',[StringComparison]::OrdinalIgnoreCase)
  $qaExists=Test-Path -LiteralPath $qaProfile.path
  if($qaExists -and -not $qaInside) { throw 'QA terminal refuses an existing external profile' }
  $qaProfileMarkers += [pscustomobject]@{label=$qaProfile.label;exists=$qaExists;inWorktree=$qaInside}
}
$qaModuleMarkers=@()
foreach($qaModule in $env:PSModulePath.Split(';') | Where-Object { $_ }) {
  Assert-QaTerminalAncestor $qaModule
  $qaInside=$qaModule.StartsWith($qaRoot+'\',[StringComparison]::OrdinalIgnoreCase)
  $qaKnownSystem=$qaKnown -contains $qaModule
  $qaMissingSystem=($qaModule -eq 'C:\Program Files\PowerShell\Modules') -and -not(Test-Path -LiteralPath $qaModule)
  if(-not($qaInside -or $qaKnownSystem -or $qaMissingSystem)) { throw 'QA terminal refuses an unknown module search root' }
  $qaModuleMarkers += [pscustomobject]@{inWorktree=$qaInside;auditedSystem=$qaKnownSystem;knownMissingSystem=$qaMissingSystem}
}
[pscustomobject]@{passed=$true;version=$PSVersionTable.PSVersion.ToString();shellMatches=$true;profiles=$qaProfileMarkers;modules=$qaModuleMarkers;scope='prelaunch NoProfile probe only; actual Host/PTY must be checked by suite'} | ConvertTo-Json -Depth 7 -Compress
'@
  $qaTerminalResult = & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -Command $qaTerminalProbe | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $qaTerminalResult.passed) { throw 'QA terminal prelaunch environment audit failed' }
  $qaTerminalEvidence = Join-Path $qaRuntime 'evidence\qa-terminal-prelaunch.json'
  Assert-QaPath $qaTerminalEvidence
  [IO.File]::WriteAllText($qaTerminalEvidence, ($qaTerminalResult | ConvertTo-Json -Depth 7), [Text.UTF8Encoding]::new($false))
}
if ($Specs.Replace('\', '/').Contains('/manual-review/')) {
  $env:ZCODE_E2E_MANUAL_REVIEW = '1'
  # 全局菜单候选不发送模型请求；pending replay 仍需显式选择已有公共空前置夹具。
  $env:E2E_PROVIDER_REPLAY_FIXTURE_PATH = Join-Path $qaWorkspace 'packages\desktop\test\e2e\fixtures\upstream\common.json'
}
if ($qaReviewedReplayFixtures.Count) {
  $env:E2E_PROVIDER_REPLAY_FIXTURE_PATH = $qaReviewedReplayFixtures -join ','
}

# 内层 runner 使用 pnpm；明确经 corepack 执行本仓固定版本。
$qaPnpmShim = Join-Path $qaRuntime 'bin\pnpm.cmd'
[IO.File]::WriteAllText($qaPnpmShim, '@"C:\Program Files\nodejs\corepack.cmd" pnpm %*' + "`r`n", [Text.UTF8Encoding]::new($false))
$env:PATH = (Join-Path $qaRuntime 'bin') + ';' + $env:PATH

# 复用本工作树已有的固定工具缓存；不触碰真实用户缓存，也不重新下载驱动。
$qaCorepackSource = Join-Path $qaWorkspace '.run-logs\qa-2026-11-06\validation\corepack'
Assert-QaPath $qaCorepackSource
if (-not (Test-Path -LiteralPath (Join-Path $env:COREPACK_HOME 'v1\pnpm\10.33.2'))) {
  foreach ($qaEntry in Get-ChildItem -LiteralPath $qaCorepackSource -Recurse -Force) {
    if ($qaEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Corepack source has reparse point' }
  }
  Copy-Item -LiteralPath (Join-Path $qaCorepackSource 'v1') -Destination $env:COREPACK_HOME -Recurse
}
$qaDriverSource = Join-Path $qaWorkspace '.run-logs\project-only-validation\projectless-validation-runner-fvBROx\children\projectless-electron-ZT90vR\temp\chromedriver\win64-152.0.7977.130\chromedriver-win64\chromedriver.exe'
Assert-QaPath $qaDriverSource
$qaDriverDir = Join-Path $env:TEMP 'chromedriver\win64-152.0.7977.130\chromedriver-win64'
Assert-QaPath $qaDriverDir
New-Item -ItemType Directory -Path $qaDriverDir -Force | Out-Null
$env:CHROMEDRIVER_PATH = Join-Path $qaDriverDir 'chromedriver.exe'
Copy-Item -LiteralPath $qaDriverSource -Destination $env:CHROMEDRIVER_PATH
$env:ZCODE_E2E_SOURCE_EVIDENCE = '1'
Set-Location -LiteralPath $qaWorkspace
$qaLog = Join-Path $qaWorkspace ('docs\testing\qa-2026-11-06\logs\e2e-' + $RunId + '.log')
Assert-QaPath $qaLog
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($qaLog)) -Force | Out-Null
# pnpm 会把单独 -- 原样传给内层 WDIO，导致其后 mochaOpts 被当作位置参数而忽略。
$qaArguments = @('--filter', '@zcode/desktop', 'test:e2e', '--shards=1')
foreach ($qaSpec in $Specs.Split(',')) {
  # WDIO 的 CLI spec 是数组；逗号串只适用于仓库自定义 selector，不能作为单个文件参数。
  $qaArguments += @('--spec', $qaSpec)
}
if ($Bootstrap) {
  $qaBootstrapPath = Join-Path $qaWorkspace 'docs\testing\qa-2026-11-06\qa-project-bootstrap.cjs'
  Assert-QaPath $qaBootstrapPath
  if (-not (Test-Path -LiteralPath $qaBootstrapPath -PathType Leaf)) { throw 'QA bootstrap hook is missing' }
  # 只扩展真实 UI 夹具前置，正式 spec 仍各自选择 replay；保留原 renderer preflight。
  $qaArguments += '--mochaOpts.require=../../docs/testing/qa-2026-11-06/qa-project-bootstrap.cjs'
}
& corepack pnpm @qaArguments 2>&1 | Tee-Object -FilePath $qaLog
$qaExitCode = $LASTEXITCODE
[IO.File]::WriteAllText($qaLog + '.exit-code.txt', [string]$qaExitCode, [Text.UTF8Encoding]::new($false))
exit $qaExitCode
