import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { withFileLock } from "@zcode/shared/node";

/**
 * 跨进程读改写 worker：并发地对同一文件做「读到自己字段 → 加一 → 原子写回」。
 *
 * 由 sharedJsonFileLock.test.ts 以真实子进程启动，用来复现跨进程丢更新。
 */

const [filePath, field, rounds] = process.argv.slice(2);
if (!filePath || !field || !rounds) {
  throw new Error("usage: sharedJsonRmwWorker <filePath> <field> <rounds>");
}

async function readAll(): Promise<Record<string, number>> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as Record<string, number>;
  } catch {
    return {};
  }
}

for (let round = 0; round < Number(rounds); round += 1) {
  // 读改写整体持锁：锁外读会让后写的一方带着旧快照整文件写回，抹掉其他进程刚写入的字段。
  await withFileLock(filePath, async () => {
    const current = await readAll();
    const next = { ...current, [field]: (current[field] ?? 0) + 1 };
    await mkdir(filePath.slice(0, filePath.lastIndexOf("/")), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${round}`;
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`);
    await rename(tempPath, filePath);
  });
}
