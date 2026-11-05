#!/usr/bin/env node
/** 保留旧会话扫描命令边界；当前快照解析实现缺失，禁止猜测存储内容。 */
const USAGE = `Usage:
  scan-legacy-sessions.mjs summary [--json]
  scan-legacy-sessions.mjs agents [--json]
  scan-legacy-sessions.mjs workspaces --agent <provider> [--json]
  scan-legacy-sessions.mjs conversations --agent <provider> --workspace <path> [--json]

Status: unavailable. Legacy snapshot scanning requires a reviewed implementation.
Historical options: --legacy-dir <path>, --task-index <path>, --cli-db <path>,
  --agent <provider>, --workspace <path>, --query <text>, --conversation <id>,
  --limit <n>, --json. No source or database is accessed by this command.
`;

// 旧 helper 已在双脚本替换时删除；帮助不能因静态导入失败，实操也不能伪造空扫描。
if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
  console.log(USAGE);
} else {
  console.error("LEGACY_SCAN_UNAVAILABLE: legacy session scanning is currently unavailable.");
  process.exitCode = 2;
}
