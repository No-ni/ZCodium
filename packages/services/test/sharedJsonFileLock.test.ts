import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { withFileLock } from "@zcode/shared/node";

/**
 * 跨进程读改写丢更新的回归测试。
 *
 * Bug 原因：共享状态文件由多个进程共同写，锁外读、锁外写会让后写方用旧快照整文件覆盖
 * 其他进程刚写入的字段。修复：读改写整体持 withFileLock。
 *
 * 用真实子进程而不是进程内并发：进程内已有各自的串行队列，只有跨进程才能复现丢更新。
 */

const workerPath = fileURLToPath(new URL("./fixtures/sharedJsonRmwWorker.ts", import.meta.url));
const ROUNDS = 12;

function runWorker(filePath: string, field: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", workerPath, filePath, field, String(ROUNDS)],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${field} exited ${code}: ${stderr}`));
    });
  });
}

test("两个进程并发读改写同一 JSON 文件不丢更新", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-shared-json-lock-"));
  const filePath = join(dir, "nested", "config.json");
  try {
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ alpha: 0, beta: 0 }, null, 2)}\n`);

    await Promise.all([runWorker(filePath, "alpha"), runWorker(filePath, "beta")]);

    const result = JSON.parse(await readFile(filePath, "utf-8")) as {
      alpha: number;
      beta: number;
    };
    // 每个字段被自己的 worker 递增 ROUNDS 次。若锁只覆盖写入不覆盖读取，
    // 后写的一方会带着旧快照整文件写回，把对方已递增的值抹掉。
    assert.equal(result.alpha, ROUNDS, `alpha 丢失更新：期望 ${ROUNDS}，实际 ${result.alpha}`);
    assert.equal(result.beta, ROUNDS, `beta 丢失更新：期望 ${ROUNDS}，实际 ${result.beta}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("锁在 operation 抛错时正常释放，后续调用不超时", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-shared-json-lock-err-"));
  const filePath = join(dir, "config.json");
  try {
    await assert.rejects(
      withFileLock(filePath, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    // 前一次调用抛错后锁必须已释放，否则这里会等到 8s 超时。
    await withFileLock(filePath, async () => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
