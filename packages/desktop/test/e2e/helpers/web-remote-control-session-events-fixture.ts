import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import {
  assertProjectPath,
  createProjectTestSandbox,
} from "../../../../../scripts/ci/project-test-sandbox.mjs";

/** 真实自托管 relay → 匿名手机 → 已有 Host attachment，夹具不持有业务状态。 */
export async function prepareWebRemoteControlSessionEventsFixture(options: {
  credentialsFile: string;
  settingsFile: string;
  workspacePath: string;
  webUrl?: string;
}): Promise<() => Promise<void>> {
  await Promise.all([
    assertProjectPath(resolve(options.credentialsFile)),
    assertProjectPath(resolve(options.settingsFile)),
    assertProjectPath(resolve(options.workspacePath)),
  ]);
  const port = options.webUrl ? new URL(options.webUrl).port || "0" : "0";
  if (options.webUrl && new URL(options.webUrl).hostname !== "127.0.0.1")
    throw new Error("MOBILE_FIXTURE_ENDPOINT_REJECTED");
  const sandbox = await createProjectTestSandbox("desktop-mobile-relay");
  const web = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve(import.meta.dirname, "../../../scripts/e2e-mobile-web-server.mjs"),
      port,
    ],
    {
      cwd: resolve(import.meta.dirname, "../../.."),
      env: { ...sandbox.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let origin: string;
  let closing: Promise<void> | undefined;
  const stop = () => {
    closing ??= (async () => {
      if (!web.pid || web.exitCode !== null || web.signalCode !== null) return;
      const exited = once(web, "exit");
      // Windows kill 没有 POSIX signal；子资源都在同一 Node 进程中，退出即释放。
      web.kill();
      await exited;
    })();
    return closing;
  };
  try {
    origin = await new Promise<string>((resolveReady, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("MOBILE_FIXTURE_READY_TIMEOUT")), 60_000);
      const onError = () => finish(new Error("MOBILE_FIXTURE_PROCESS_FAILED"));
      const onExit = () => finish(new Error("MOBILE_FIXTURE_EXITED_BEFORE_READY"));
      const onData = (chunk: Buffer) => {
        output = `${output}${chunk.toString()}`.slice(-2000);
        const match = /MOBILE_FIXTURE_READY (http:\/\/127\.0\.0\.1:\d+\/)\s/u.exec(output);
        if (match?.[1]) finish(undefined, match[1]);
      };
      function finish(error?: Error, value?: string) {
        clearTimeout(timer);
        web.off("error", onError);
        web.off("exit", onExit);
        web.stdout.off("data", onData);
        if (error) reject(error);
        else resolveReady(value!);
      }
      web.once("error", onError);
      web.once("exit", onExit);
      web.stdout.on("data", onData);
      // 不转发 Vite 原始错误文本；失败只由安全状态码报告。
      web.stderr.resume();
    });
    const settings = JSON.parse(await readFile(options.settingsFile, "utf8"));
    await writeFile(options.credentialsFile, "{}", { mode: 0o600 });
    await writeFile(
      options.settingsFile,
      JSON.stringify({
        ...settings,
        webRemoteControlEndpointMode: "custom",
        webRemoteControlCustomEndpointUrl: `${origin.replace("http:", "ws:")}ws`,
        webRemoteControlExternalRelayDevice: undefined,
        webRemoteControlLastEnabledContext: { workspacePath: options.workspacePath },
      }),
    );
  } catch (error) {
    await stop();
    throw error;
  }
  const key = "ZCODIUM_E2E_MOBILE_URL";
  const previous = process.env[key];
  process.env[key] = origin;
  return async () => {
    try {
      await stop();
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  };
}
