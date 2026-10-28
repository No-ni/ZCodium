import { disposeServiceResourcesAndWait, getAppConfigDir } from "@zcode/services/node";
import {
  ZCODE_VERSION,
  SERVICE_AUTHORITY_MODE_ENV,
  formatLogPrefix,
  safeLogArgs,
} from "@zcode/shared";
import type { HelloMessage } from "@zcode/shared";
import { createStdioTransport } from "./stdio.js";
import { waitForStdioAck } from "./stdio-ack.js";
import { startStdioProcess } from "./stdio-lifecycle.js";
import { createStdioServices } from "./stdioServices.js";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";

// In stdio mode, all logging goes to stderr
const log = (...args: unknown[]) =>
  console.error(formatLogPrefix("zcode-server:stdio", process.pid), ...args);
const stderrOutput = console.error.bind(console);
const stderrConsoleLog = (...args: unknown[]) =>
  stderrOutput(JSON.stringify({ kind: "zcodium.diagnostic", args: safeLogArgs(args) }));

// stdio 模式下 stdout 只能承载 RPC 帧。
// 之前 services 里的 info/debug 日志仍会走 console.log / console.info，
// 一旦把普通文本写进 stdout，就会直接污染协议流，表现成远程调用一直 pending / loading。
// 这里在 entry 层统一把普通 console 输出重定向到 stderr，确保所有服务日志都不会再打坏 RPC。
console.log = stderrConsoleLog;
console.info = stderrConsoleLog;
console.warn = stderrConsoleLog;
console.debug = stderrConsoleLog;
console.error = stderrConsoleLog;

// --version flag: print version and exit (used by deploy version check)
if (process.argv.includes("--version")) {
  process.stdout.write(ZCODE_VERSION + "\n");
  process.exit(0);
}

async function main() {
  // Phase 1: Send hello message
  const hello: HelloMessage = {
    type: "zcode-hello",
    version: ZCODE_VERSION,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
  };
  process.stdout.write(JSON.stringify(hello) + "\n");

  // Phase 2: Wait for hello-ack
  const ack = await waitForStdioAck(process.stdin);
  log(`client connected: ${ack.clientId} (v${ack.version})`);

  // Phase 3: Initialize services and start stdio RPC server
  await startStdioProcess({
    stdin: process.stdin,
    signalSource: process,
    log,
    createTransport: createStdioTransport,
    prepare: () =>
      materializeBundledZCodeBuiltinProviderConfig({
        environmentConfigRoot: getAppConfigDir(),
        content: readBundledZCodeBuiltinProviderConfig(),
      }),
    createRuntime: (zcodeBuiltinProviderConfigFilePath, transport) => {
      const { authorityModeParseResult, services } = createStdioServices({
        env: process.env,
        zcodeBuiltinProviderConfigFilePath,
      });
      if (authorityModeParseResult.invalidRawValue) {
        log(
          `${SERVICE_AUTHORITY_MODE_ENV}=${authorityModeParseResult.invalidRawValue} 非法，按默认本机 Environment 权威模式启动`,
        );
      }
      return {
        stopRpc: transport.stop,
        ready: () => {
          transport.attachServices(services);
          transport.ready();
        },
        // Desktop Host 已经会等待 disposeServiceResourcesAndWait，远端 stdio
        // entry 却仍直接 process.exit，导致其托管的 workspace Agent 来不及完成进程树清理。
        // 远端 server 也是 ServiceCollection owner，退出前必须遵守同一异步回收契约。
        dispose: () => disposeServiceResourcesAndWait(services),
      };
    },
    exit: (code) => process.exit(code),
    ready: () => log("stdio mode ready"),
  });
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
