import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import {
  clearAppData,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "./helpers/desktop-app.js";
import {
  PROVIDER_READINESS_HISTORY_SESSION_ID,
  PROVIDER_READINESS_HISTORY_TITLE,
} from "./helpers/provider-readiness-history-fixture.js";

const AGENT_METRIC_PROBE_SKIPPED_MARKER =
  "agent_metric_probe action=skipped reason=main_process_external_probe_disabled";
const AGENT_METRIC_PROBE_SPAWN_MARKER = "agent_metric_probe action=spawn";
/**
 * 性能红线（docs/monitoring/process-resource-telemetry.md）：全链路禁止 PowerShell / WMI / CIM。
 * PRT-024 在 PERF-RES-01 原断言之上再加一条运行时证据——worker 专属 runtime log 里
 * 不能出现 powershell，任何进程真的起过 PowerShell 都会在日志里留痕。
 */
const POWERSHELL_MARKER = "powershell";
// 只有 Windows 才有 PowerShell 这条回归路径，macOS 与 Linux 明确 skip。
const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

windowsDescribe("Windows Agent 指标采集 main process 门禁", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PERF-RES-01: 真实 Agent 注册后的资源采样日志只记录 skipped，不启动外部 probe", async function () {
    this.timeout(90000);

    // 退休依据：1c07c42c「refactor(startup): remove official account restoration」已删除
    // 官方账号恢复、WelcomeScreen 与 API Key 登录表单，TID_LOGIN_* 常量同步从
    // @zcode/shared/test-ids 移除；产品改为本地匿名启动，直接进入默认 workspace。
    // 原登录兜底会把 renderer target 切换失败误报成“没有 API Key 配置入口”，
    // 因此只保留既有 waitForDefaultWorkspaceReady，真实启动失败直接抛出。
    await waitForDefaultWorkspaceReady(30000);
    await waitForSeededHistory();

    const runtimeLogDir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim();
    if (!runtimeLogDir) {
      throw new Error("当前 E2E worker 没有配置 desktop runtime log 目录");
    }

    let desktopLogs = "";
    await browser.waitUntil(
      async () => {
        desktopLogs = await readDesktopRuntimeLogs(runtimeLogDir);
        return desktopLogs.includes(AGENT_METRIC_PROBE_SKIPPED_MARKER);
      },
      {
        timeout: 45000,
        interval: 250,
        timeoutMsg:
          "真实 Agent 注册后跨过资源采样周期，main 日志仍未记录禁用外部 probe 的 skipped 审计",
      },
    );

    // Bug 根因：Agent PID 接入资源采样后，旧实现会在 Electron main process
    // 每 10 秒同步启动 PowerShell。E2E 只接受显式 skipped，任何 spawn 审计都失败。
    await browser.pause(500);
    desktopLogs = await readDesktopRuntimeLogs(runtimeLogDir);
    expect(desktopLogs).toContain(AGENT_METRIC_PROBE_SKIPPED_MARKER);
    expect(desktopLogs).not.toContain(AGENT_METRIC_PROBE_SPAWN_MARKER);
    // PRT-024：跨过采样周期后的 runtime log 不含 powershell。断言点选在测试体内、
    // App 关闭之前——退出时的进程树回收走 Host 的 windowsProcessListAsync（按需 CIM，
    // 已在红线豁免清单内），不属于遥测链路，不能把它的收尾日志算进来。
    expect(desktopLogs.toLowerCase()).not.toContain(POWERSHELL_MARKER);
  });
});

async function waitForSeededHistory(): Promise<void> {
  const itemTestId = testId(TID_TASK_ITEM, PROVIDER_READINESS_HISTORY_SESSION_ID);
  await waitForTestIdByDom(itemTestId, {
    timeout: 30000,
    timeoutMsg: "provider 未就绪时预置历史行没有出现在侧栏",
  });
  const title = await browser.execute((targetTestId) => {
    return document
      .querySelector<HTMLElement>(`[data-testid="${targetTestId}"]`)
      ?.innerText.replace(/\s+/g, " ")
      .trim();
  }, itemTestId);
  expect(title).toContain(PROVIDER_READINESS_HISTORY_TITLE);
}

async function readDesktopRuntimeLogs(runtimeLogDir: string): Promise<string> {
  try {
    const entries = await readdir(runtimeLogDir, { withFileTypes: true });
    const logFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map((entry) => entry.name)
      .sort();
    const contents = await Promise.all(
      logFiles.map((fileName) => readFile(join(runtimeLogDir, fileName), "utf8")),
    );
    return contents.join("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}
