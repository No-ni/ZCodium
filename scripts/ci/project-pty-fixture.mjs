import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertProjectPath, projectRoot } from "./project-test-sandbox.mjs";

/** 原生终端只承载键盘/屏幕 IPC；真正的 CLI 继承项目文件门禁。 */
export async function createProjectPtyFixture(file, args, options) {
  await assertProjectPath(file);
  const cwd = await assertProjectPath(options.cwd);
  const configPath = join(cwd, `pty-fixture-${randomUUID()}.json`);
  await writeFile(configPath, JSON.stringify({ file, args, options }), { flag: "wx" });
  const helper = spawn(
    process.execPath,
    [join(projectRoot, "scripts/test/project-pty-host.mjs"), configPath],
    {
      cwd: projectRoot,
      env: { ...process.env, NODE_OPTIONS: "" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const ready = Promise.withResolvers(),
    closed = Promise.withResolvers();
  const dataListeners = [],
    exitListeners = [],
    buffer = [];
  let pending = "",
    stderr = "",
    exitEvent,
    closePromise;
  const exit = (event) => {
    exitEvent = event;
    for (const listener of exitListeners) listener(event);
  };
  helper.stdout.setEncoding("utf8");
  helper.stderr.setEncoding("utf8");
  helper.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  helper.stdout.on("data", (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const message = JSON.parse(line);
      if (message.type === "ready") ready.resolve();
      else if (message.type === "data") {
        if (dataListeners.length) for (const listener of dataListeners) listener(message.data);
        else buffer.push(message.data);
      } else if (message.type === "exit") exit({ exitCode: message.exitCode });
    }
  });
  helper.on("error", (error) => ready.reject(error));
  helper.on("close", (code) => {
    ready.reject(new Error("PTY_FIXTURE_EXITED_BEFORE_READY: " + stderr));
    if (!exitEvent) exit({ exitCode: code ?? 1 });
    closed.resolve();
  });
  try {
    await ready.promise;
  } catch (error) {
    helper.kill();
    await closed.promise;
    await unlink(configPath);
    throw error;
  }
  return {
    onData(listener) {
      dataListeners.push(listener);
      for (const data of buffer.splice(0)) listener(data);
    },
    onExit(listener) {
      exitListeners.push(listener);
      if (exitEvent) listener(exitEvent);
    },
    write(data) {
      if (!exitEvent) helper.stdin.write(JSON.stringify({ type: "write", data }) + "\n");
    },
    kill() {
      if (!exitEvent && !helper.stdin.destroyed)
        helper.stdin.write(JSON.stringify({ type: "kill" }) + "\n");
    },
    close() {
      return (closePromise ??= (async () => {
        if (!exitEvent && !helper.stdin.destroyed)
          helper.stdin.write(JSON.stringify({ type: "kill" }) + "\n");
        await closed.promise;
        await unlink(configPath);
      })());
    },
  };
}
