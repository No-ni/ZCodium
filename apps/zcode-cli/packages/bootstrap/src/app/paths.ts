import { basename, join } from "node:path";
import { type ProjectId } from "@zcode/contracts";
import { resolveProjectMemoryRoot, projectIdFromDirectory as deriveProjectIdFromDirectory } from "@zcode/core";

export function getCliStorageRoot(storageRoot: string): string {
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

/** 子代理输出目录（output.txt、metadata.json）的根；runtime 写入与子代理投影读取共用。 */
export function getSubagentOutputRootDir(cliStorageRoot: string): string {
  return join(cliStorageRoot, "agents");
}

export function getPluginStorageRoot(cliStorageRoot: string): string {
  return join(cliStorageRoot, "plugins");
}

export function getProjectMemoryRoot(
  cliStorageRoot: string,
  workingDirectory: string,
  workspaceIdentity?: string,
): string {
  return resolveProjectMemoryRoot({
    cliStorageRoot,
    workspaceIdentity,
    workspacePath: workingDirectory,
  });
}

export function projectIdFromDirectory(directory: string): ProjectId {
  // 保留 Bootstrap 的空值历史契约，其余输入与 Core 落盘共享唯一派生 owner。
  return deriveProjectIdFromDirectory(directory, "default");
}
