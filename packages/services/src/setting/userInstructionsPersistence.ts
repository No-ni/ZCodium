import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { USER_INSTRUCTIONS_MAX_BYTES, USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE } from "@zcode/shared";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";
import { maybeThrowInjectedFsFault } from "#src/fs/fsFaultInjection.js";
import { withAtomicFileLock } from "#src/fs/atomicFileUtils.js";

/** 每个实例固定一条CLI指令路径；跨实例由同一文件锁协调，读取等待已接纳保存。 */
export function createUserInstructionsPersistence(filePath: string) {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    async getUserInstructions(): Promise<{ content: string; filePath: string }> {
      await queue;
      try {
        return { content: await readFile(filePath, "utf8"), filePath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", filePath };
        throw error;
      }
    },
    async saveUserInstructions(content: string): Promise<{ filePath: string }> {
      if (Buffer.byteLength(content, "utf8") > USER_INSTRUCTIONS_MAX_BYTES) {
        throw Object.assign(new Error("User instructions exceed the byte limit"), {
          code: USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE,
        });
      }
      const write = async () => {
        // 首次保存的父目录必须在取锁前建立；私有原子替换固定0600，不能因换inode放宽权限。
        maybeThrowInjectedFsFault({ operation: "mkdir", path: dirname(filePath) });
        await mkdir(dirname(filePath), { recursive: true });
        await withAtomicFileLock(filePath, async () => {
          maybeThrowInjectedFsFault({ operation: "writeFile", path: filePath });
          await atomicWritePrivateTextFile(filePath, content);
        });
      };
      const pending = queue.then(write, write);
      queue = pending.catch(() => {});
      await pending;
      return { filePath };
    },
  };
}
