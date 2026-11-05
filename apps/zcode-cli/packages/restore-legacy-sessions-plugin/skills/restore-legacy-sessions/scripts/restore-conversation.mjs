#!/usr/bin/env node
/** 保留旧会话恢复命令边界；当前两库恢复实现缺失，不读取快照或触碰数据库。 */
const USAGE = `Usage:
  restore-conversation.mjs --snapshot <path> [--task-index <path>] [--cli-db <path>]
  restore-conversation.mjs --snapshot <path> --dry-run

Status: unavailable. Legacy restoration requires a reviewed implementation for
  the current task-index and CLI session stores. Both restore and dry-run fail
  before reading snapshots, opening databases, creating backups or directories.
`;

// 缺失 helper 不代表可以恢复历史写库路径；dry-run 同样不能在没有计划实现时宣称成功。
if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
  console.log(USAGE);
} else {
  console.error("LEGACY_RESTORE_UNAVAILABLE: legacy session restoration is currently unavailable.");
  process.exitCode = 2;
}
