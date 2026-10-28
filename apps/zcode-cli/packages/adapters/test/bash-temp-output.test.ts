import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { NodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";
import { BashFileOutput } from "../src/exec/bash-file-output.js";
import type { ExecutionRequest } from "@zcode/contracts";

class FixtureAdapter extends NodeExecutionAdapter {
  protected override async prepareChildSpawn() {
    return {
      command: {
        file: process.execPath,
        // node --test 向子进程传播权限参数；合并输出夹具须禁用额外的 SecurityWarning。
        args: ["--disable-warning=SecurityWarning", "-e", "process.stdout.write('fixture output')"],
        shell: false,
        cwdDialect: "posix",
      },
      cwdDialect: "posix",
      spawnOptions: { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    } as never;
  }
}
const request = (): ExecutionRequest =>
  ({
    command: { mode: "shell", shellProfile: "posix-bash", command: "fixture" },
    outputLimit: { persistOutput: "always" },
    trace: { sessionId: "fixture-session", attributes: { toolCallId: crypto.randomUUID() } },
  }) as ExecutionRequest;

async function temporary(t: any) {
  const root = await mkdtemp(join(tmpdir(), "zcodium-bash-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Bash foreground and background publish temp paths before spawn and remain readable", async (t) => {
  const root = await temporary(t);
  const adapter = new FixtureAdapter({
    outputRootDir: join(root, "data"),
    bashOutputTempDir: root,
  } as never);
  t.after(() => adapter.close());
  const result = await adapter.run(request());
  assert.equal(result.status, "completed");
  assert.equal(result.stdout.text, "fixture output");
  const outputPath = result.stdout.artifactPath!;
  assert.ok(relative(root, outputPath).startsWith("zcodium-bash-"));
  const started = await adapter.start(request());
  assert.ok(relative(root, started.outputPath!).startsWith("zcodium-bash-"));
  const completed = await adapter.waitForBackgroundTask(started.taskId);
  assert.equal(completed?.result?.stdout.artifactPath, started.outputPath);
  await adapter.close();
  assert.equal(await readFile(started.outputPath!, "utf8"), "fixture output");
});

test("only an unavailable temp filesystem falls back to the established output root", async (t) => {
  const root = await temporary(t);
  const blocked = join(root, "not-directory");
  await writeFile(blocked, "fixture");
  const adapter = new FixtureAdapter({
    outputRootDir: join(root, "data"),
    bashOutputTempDir: blocked,
  } as never);
  t.after(() => adapter.close());
  const result = await adapter.run(request());
  assert.equal(result.status, "completed");
  assert.ok(
    relative(join(root, "data"), result.stdout.artifactPath!).startsWith("fixture-session"),
  );
});

test("close during asynchronous file preparation waits, discards and never starts a child", async (t) => {
  const root = await temporary(t);
  const adapter = new FixtureAdapter({
    outputRootDir: join(root, "data"),
    bashOutputTempDir: root,
  } as never);
  const original = BashFileOutput.prototype.prepare;
  let unblock!: () => void;
  let prepared!: () => void;
  const reached = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  BashFileOutput.prototype.prepare = async function () {
    await original.call(this);
    prepared();
    await new Promise<void>((resolve) => {
      unblock = resolve;
    });
  };
  t.after(() => {
    BashFileOutput.prototype.prepare = original;
  });
  let starts = 0;
  const running = adapter.run(request(), {
    onEvent: (event) => {
      if (event.type === "started") starts += 1;
    },
  });
  await reached;
  let closed = false;
  const closing = adapter.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  unblock();
  assert.equal((await running).status, "cancelled");
  await closing;
  assert.equal(starts, 0);
  const paths = await readdir(root, { recursive: true });
  assert.ok(!paths.some((path) => path.endsWith("stdout.log")));
});
