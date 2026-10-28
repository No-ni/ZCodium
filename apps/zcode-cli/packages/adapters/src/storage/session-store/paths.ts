import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";

export function getDefaultSessionDbPath(): string {
  return join(homedir(), ZCODE_USER_DATA_DIR_NAME, "cli", "db", "db.sqlite");
}

export async function ensureParentDir(filePath: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (filePath === ":memory:") return;
  const parent = dirname(filePath);
  maybeThrowStorageFsFault({ operation: "mkdir", path: parent });
  // 唯一异步 startup 在打开连接前建目录；同步 constructor 不再隐藏 existsSync/mkdirSync 初始化路径。
  await mkdir(parent, { recursive: true });
  signal?.throwIfAborted();
}
