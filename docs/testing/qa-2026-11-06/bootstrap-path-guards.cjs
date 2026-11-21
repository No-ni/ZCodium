"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

// 原因：原入口排版后超限；校验依赖由同一入口注入，拒绝边界和调用顺序保持。
exports.createBootstrapPathGuards = function ({ repository, fixtureDirectory, desktopRequire }) {
  function insideWorktree(candidate) {
    if (!candidate || !path.isAbsolute(candidate))
      throw new Error("QA bootstrap requires absolute isolated paths");
    const absolute = path.resolve(candidate);
    const relative = path.relative(repository, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("QA bootstrap path escapes the authorized worktree");
    }
    for (let cursor = absolute; cursor; cursor = path.dirname(cursor)) {
      if (fs.existsSync(cursor)) {
        if (fs.lstatSync(cursor).isSymbolicLink())
          throw new Error("QA bootstrap refuses symbolic links/junctions");
        if (path.resolve(fs.realpathSync.native(cursor)).toLowerCase() !== cursor.toLowerCase()) {
          throw new Error("QA bootstrap refuses redirected ancestors");
        }
      }
      if (cursor === path.dirname(cursor)) break;
    }
    return absolute;
  }

  function auditWindowsReparsePoints(targets) {
    if (process.platform !== "win32") return;
    // 路径通过子进程环境传递，不拼入 PowerShell 代码；只读核对所有祖先与既有子项。
    const enumerationGuard = fs.readFileSync(
      insideWorktree(path.join(fixtureDirectory, "qa-reparse-children.ps1")),
      "utf8",
    );
    const script =
      enumerationGuard +
      "\n$ErrorActionPreference='Stop'; $paths=ConvertFrom-Json $env:QA_BOOTSTRAP_AUDIT_PATHS; foreach($target in $paths) { $cursor=[IO.Path]::GetFullPath($target); while($cursor) { if(Test-Path -LiteralPath $cursor) { $item=Get-Item -LiteralPath $cursor -Force; if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'QA bootstrap refuses reparse points' } }; $cursor=[IO.Path]::GetDirectoryName($cursor) }; if(Test-Path -LiteralPath $target -PathType Container) { $queue=[Collections.Generic.Queue[string]]::new(); $queue.Enqueue($target); while($queue.Count) { foreach($child in Get-QaAuditChildren $queue.Dequeue()) { if($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'QA bootstrap refuses descendant reparse points' }; if($child.PSIsContainer) { $queue.Enqueue($child.FullName) } } } } }";
    execFileSync(
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: {
          ...process.env,
          QA_BOOTSTRAP_AUDIT_PATHS: JSON.stringify(targets),
          QA_REPARSE_WORKTREE: repository,
        },
        windowsHide: true,
        stdio: "pipe",
        timeout: 30_000,
      },
    );
  }

  function validateWdioNodeOptions(value) {
    const options = value?.trim() || "";
    if (!options) return { source: "empty launcher environment", loaderCount: 0 };
    // WDIO CLI 固定注入同一工作树 tsx URL；local-runner 会把它合并两次。
    // 仅放行该确切 importer 及 source-maps，未知 flag/其它路径一律拒绝。
    const loader = insideWorktree(desktopRequire.resolve("tsx"));
    const expected = pathToFileURL(loader).href;
    const tokens = options.split(/\s+/u);
    let loaderCount = 0;
    let sourceMapsCount = 0;
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] === "--import" && tokens[index + 1] === expected) {
        loaderCount += 1;
        index += 1;
      } else if (tokens[index] === "--enable-source-maps") {
        sourceMapsCount += 1;
      } else {
        throw new Error("QA bootstrap refuses unknown Node preload/options");
      }
    }
    if (loaderCount < 1 || loaderCount > 2 || sourceMapsCount > 1) {
      throw new Error("QA bootstrap refuses unexpected WDIO Node options multiplicity");
    }
    auditWindowsReparsePoints([loader]);
    return { source: "audited installed WDIO tsx injection", loader, loaderCount, sourceMapsCount };
  }

  function isolatedPaths() {
    const required = [
      "HOME",
      "USERPROFILE",
      "TEMP",
      "TMP",
      "TMPDIR",
      "APPDATA",
      "LOCALAPPDATA",
      "COREPACK_HOME",
      "PNPM_HOME",
      "npm_config_cache",
      "npm_config_store_dir",
      "npm_config_userconfig",
      "TSX_CACHE_DIR",
      "NODE_COMPILE_CACHE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "ZCODE_E2E_HOME_DIR",
      "ZCODE_E2E_ARTIFACT_DIR",
    ];
    const inherited = required.map((name) => insideWorktree(process.env[name]));
    if (process.env.E2E_PROVIDER_HTTP_MODE !== "replay")
      throw new Error("QA bootstrap requires Provider replay");
    const nodeOptions = validateWdioNodeOptions(process.env.NODE_OPTIONS);
    const home = insideWorktree(process.env.ZCODE_E2E_HOME_DIR);
    const artifacts = insideWorktree(process.env.ZCODE_E2E_ARTIFACT_DIR);
    const workspace = insideWorktree(path.join(home, "ZCodeProject"));
    const database = insideWorktree(path.join(home, ".zcodium", "v2", "tasks-index.sqlite"));
    const settings = insideWorktree(path.join(home, ".zcodium", "v2", "setting.json"));
    const wal = insideWorktree(database + "-wal");
    const shm = insideWorktree(database + "-shm");
    auditWindowsReparsePoints([
      ...new Set([...inherited, workspace, database, settings, wal, shm]),
    ]);
    if (!fs.statSync(workspace).isDirectory()) throw new Error("QA fixture workspace is missing");
    return { home, artifacts, workspace, database, settings, nodeOptions };
  }
  return { insideWorktree, auditWindowsReparsePoints, validateWdioNodeOptions, isolatedPaths };
};
