import { lstat, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getE2EAppDataPaths, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { seedCustomAnthropicMessagesProvider } from "#e2e/helpers/custom-openai-provider-store";
import { seedTurboAgentStartupModel } from "#e2e/helpers/model-provider-restart-runtime";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "#e2e/helpers/upstream-replay-server";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  selectUpstreamModel,
  selectUpstreamThoughtLevel,
} from "#e2e/helpers/upstream-provider";
import {
  approveV4Permission,
  getV4ComposerText,
  getV4ConversationState,
  getV4DraftThoughtState,
  selectV4TaskById,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4PermissionDialog,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const NAME = "conversation-session-projectless-workspace";
const paths = getE2EAppDataPaths();
const settingsFile = join(paths.appDataDir, "setting.json");
const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR!;
let replay: UpstreamReplayServer | undefined;

async function currentWorkspace() {
  return browser.execute(() => {
    const bridge = window as Window & {
      __zcodeSessionStoreE2E?: {
        getState(): { getWorkspaceState(path: string): { draftFocusVersion: number } };
      };
    };
    const state = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): {
            activeWorkspacePath: string | null;
            tabs: Array<{ workspacePath?: string; workspacePurpose?: string }>;
          };
        };
      }
    ).__zcodeTabStoreE2E?.getState();
    if (!state) throw new Error("PTW tab store 未就绪");
    const workspace = state.activeWorkspacePath
      ? bridge.__zcodeSessionStoreE2E?.getState().getWorkspaceState(state.activeWorkspacePath)
      : null;
    return {
      path: state.activeWorkspacePath,
      tabs: state.tabs,
      focusVersion: workspace?.draftFocusVersion ?? null,
    };
  });
}

async function assertTaskDirectory(path: string): Promise<void> {
  const repo = resolve(process.cwd(), "../..");
  const home = resolve(paths.homeDir);
  const homeChild = relative(repo, home);
  const child = relative(home, resolve(path));
  if (
    !isAbsolute(path) ||
    !homeChild ||
    homeChild === ".." ||
    homeChild.startsWith(`..${sep}`) ||
    isAbsolute(homeChild) ||
    !child ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  )
    throw new Error("PTW fixture path escaped project home");
  let current = repo;
  for (const segment of relative(repo, resolve(path)).split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink() || relative(current, await realpath(current)))
      throw new Error("PTW fixture rejects reparse points");
  }
  expect(dirname(path)).toBe(join(paths.storageRoot, "workspace"));
  expect(basename(path)).toMatch(/^draft-[0-9a-f-]{36}$/i);
}

async function waitForDraftNavigation(previous: Awaited<ReturnType<typeof currentWorkspace>>) {
  await browser.waitUntil(
    async () => {
      const next = await currentWorkspace();
      return next.path !== previous.path || next.focusVersion !== previous.focusVersion;
    },
    { timeout: 15000, timeoutMsg: "PTW 新建入口未提交草稿导航" },
  );
  await waitForV4Pane((pane) => pane.sessionId === "draft", "任务区加号未打开草稿");
}

async function taskAdd(expectDirectoryError = false) {
  const previous = await currentWorkspace();
  const button = $('[data-testid="virtual-project-new-task"]');
  // 分区操作在 hover 后显示；真实移动鼠标，不绕过可见性直接调用 DOM click。
  await $('[data-testid="conversation-section"]').moveTo();
  await button.waitForClickable({ timeout: 15000 });
  await button.click();
  // 已经是 draft 时 pane 断言会立即通过，必须等待真实 focus/path 提交以验证重复入口。
  if (!expectDirectoryError) await waitForDraftNavigation(previous);
}

async function triggerNativeNewTaskShortcut() {
  const windowId = await browser.electron.execute((electron) => {
    const target = electron.BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes("/renderer/index.html"),
    );
    const menu = electron.Menu.getApplicationMenu()
      ?.items.flatMap((item) => item.submenu?.items ?? [])
      .find((item) => item.accelerator?.toLowerCase() === "cmdorctrl+n");
    if (!target || !menu?.enabled) throw new Error("PTW 原生新建快捷键未就绪");
    target.focus();
    return target.id;
  });
  await browser.waitUntil(
    () =>
      browser.electron.execute(
        (electron, id) => electron.BrowserWindow.fromId(id)?.isFocused() ?? false,
        windowId,
      ),
    { timeout: 5000, timeoutMsg: "PTW 原生快捷键窗口未聚焦" },
  );
  // newTask 的 owner 是 Main 菜单；CDP keys 只进入 Renderer，须走原生 input 通道。
  await browser.electron.execute((electron, id) => {
    const target = electron.BrowserWindow.fromId(id);
    if (!target?.isFocused()) throw new Error("PTW 原生快捷键窗口已失焦");
    const modifiers: Array<"meta" | "control"> =
      process.platform === "darwin" ? ["meta"] : ["control"];
    target.webContents.sendInputEvent({ type: "keyDown", keyCode: "N", modifiers });
    target.webContents.sendInputEvent({ type: "keyUp", keyCode: "N", modifiers });
  }, windowId);
}

async function sendToolTask(marker: string, complete: string) {
  await sendV4Prompt(marker);
  await waitForV4PermissionDialog();
  await approveV4Permission();
  await waitForV4TimelineContaining(complete, 60000);
  await waitForV4ConversationState((state) => state.state === "idle", `${marker} 未完成`);
}

describe("无项目任务目录一致性（manual-review/pending）", () => {
  afterEach(async function () {
    if (this.currentTest?.state === "failed")
      await browser.saveScreenshot(join(artifactDir, "PTW-failure.png"));
  });

  after(async () => {
    await replay?.stop();
    await browser.electron.restoreAllMocks();
    // HOME 与产物交给 WDIO 的退出屏障处理；本用例不递归清理目录。
  });

  it("PTW01–04/07 空启动、草稿复用、任务产物与历史恢复保留独立目录", async function () {
    this.timeout(360000);
    await skipOccupationOnboardingIfPresent();
    await browser.execute(() =>
      window.localStorage.removeItem('zcode-pending-task-draft:v1:["desktop","local",null]'),
    );
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const settings = JSON.parse(await readFile(settingsFile, "utf8"));
        await writeFile(
          settingsFile,
          JSON.stringify({
            ...settings,
            lastActiveWorkspace: null,
            lastWorkspaceSession: [],
            lastActiveTabIndex: 0,
          }),
        );
      },
    });
    await skipOccupationOnboardingIfPresent();
    await waitForV4Pane((pane) => pane.sessionId === "draft", "空启动未进入任务草稿");
    const first = (await currentWorkspace()).path;
    if (!first) throw new Error("PTW01 缺少任务目录");
    await assertTaskDirectory(first);
    expect(
      (await currentWorkspace()).tabs.some(
        (tab) => tab.workspacePath === join(paths.storageRoot, "workspace", "default"),
      ),
    ).toBe(false);
    await browser.saveScreenshot(join(artifactDir, "PTW01-startup.png"));

    replay = await startUpstreamReplayServer({
      artifactPath: join(artifactDir, "projectless-provider.json"),
      fixturePaths: [resolve(`test/e2e/fixtures/upstream/conversation-session/${NAME}.json`)],
      fixtureVariables: {
        projectlessVisualization: join(first, "visualizations", "chart.html").replaceAll("\\", "/"),
      },
    });
    process.env.E2E_PROVIDER_CAPTURE_PATH = replay.artifactPath;
    process.env.E2E_PROVIDER_CAPTURE_MODE = "replay";
    process.env.E2E_PROVIDER_RUNTIME_BASE_URL = replay.baseUrl;
    process.env.E2E_PROVIDER_EXPECTED_HOST = new URL(replay.baseUrl).host;
    process.env.E2E_PROVIDER_EXPECTED_PROTOCOL = "http:";
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await seedCustomAnthropicMessagesProvider({
          baseURL: replay!.baseUrl,
          modelId: UPSTREAM_MODEL,
          providerId: UPSTREAM_PROVIDER_ID,
          providerName: "PTW fixture",
          reasoningLevel: {
            values: ["disabled", "high"],
            map: '{"thinking":reasoningLevel == "high" ? {"type":"enabled","budget_tokens":4096} : {"type":"disabled"}}',
          },
        });
        await seedTurboAgentStartupModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
      },
    });
    await waitForWorkspaceApp(first, 60000);
    await selectUpstreamModel();
    await selectUpstreamThoughtLevel();
    await setV4ComposerText("E2E_PTW_A");
    const selection = await getV4DraftThoughtState(first);
    expect(selection.current).toBe("high");
    await taskAdd();
    expect((await currentWorkspace()).path).toBe(first);
    expect(await getV4ComposerText()).toBe("E2E_PTW_A");
    let previous = await currentWorkspace();
    // 现有 test id 在按钮组容器上；点击真实主按钮才能触发 onCreateTask。
    const globalNew = $('[data-testid="task-new-button"] > button:first-child');
    await globalNew.waitForClickable({ timeout: 15000 });
    await globalNew.click();
    await waitForDraftNavigation(previous);
    expect((await currentWorkspace()).path).toBe(first);
    expect(await getV4ComposerText()).toBe("E2E_PTW_A");
    previous = await currentWorkspace();
    await triggerNativeNewTaskShortcut();
    await waitForDraftNavigation(previous);
    expect((await currentWorkspace()).path).toBe(first);
    expect(await getV4DraftThoughtState(first)).toEqual(selection);
    await sendToolTask("E2E_PTW_A", "PTW_A_DONE");
    const taskA = (await getV4ConversationState()).taskId;
    if (!taskA) throw new Error("PTW02 首条任务未落库");
    expect(resolve((await readFile(join(first, "task-cwd.txt"), "utf8")).trim())).toBe(first);
    await browser.waitUntil(() => $('[data-gen-ui-phase="ready"]').isExisting(), {
      timeout: 30000,
      timeoutMsg: "PTW04 task Gen UI 未通过 Host 授权",
    });
    await browser.saveScreenshot(join(artifactDir, "PTW04-task-gen-ui.png"));

    await taskAdd();
    const second = (await currentWorkspace()).path;
    if (!second) throw new Error("PTW02 第二条任务无目录");
    await assertTaskDirectory(second);
    expect(second).not.toBe(first);
    await expect(stat(join(second, "task-cwd.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await sendToolTask("E2E_PTW_B", "PTW_B_DONE");
    const taskB = (await getV4ConversationState()).taskId;
    if (!taskB) throw new Error("PTW02 第二条任务未落库");
    expect(resolve((await readFile(join(second, "task-cwd.txt"), "utf8")).trim())).toBe(second);
    expect(await readFile(join(first, "visualizations", "chart.html"), "utf8")).toContain(
      "PTW_ARTIFACT_A",
    );
    expect(await readFile(join(second, "visualizations", "chart.html"), "utf8")).toContain(
      "PTW_ARTIFACT_B",
    );

    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const settings = JSON.parse(await readFile(settingsFile, "utf8"));
        delete settings.lastActiveWorkspace;
        settings.lastWorkspaceSession = [first, second].map((workspacePath) => ({
          kind: "local",
          workspacePath,
          workspacePurpose: "conversation",
        }));
        settings.lastActiveTabIndex = 0;
        await writeFile(settingsFile, JSON.stringify(settings));
      },
    });
    await waitForWorkspaceApp(first, 60000);
    await browser.waitUntil(
      async () => (await currentWorkspace()).tabs.some((tab) => tab.workspacePath === second),
      { timeout: 15000, timeoutMsg: "PTW03 旧持久记录的第二个任务目录未恢复" },
    );
    expect(
      (await currentWorkspace()).tabs.some(
        (tab) => tab.workspacePath === join(paths.storageRoot, "workspace", "default"),
      ),
    ).toBe(false);
    await selectV4TaskById(taskA);
    expect((await currentWorkspace()).path).toBe(first);
    await waitForV4TimelineContaining("PTW_A_DONE", 30000);
    await sendV4Prompt("E2E_PTW_CONTINUE_A");
    await waitForV4TimelineContaining("PTW_CONTINUED_A", 60000);
    await waitForV4ConversationState((state) => state.state === "idle", "PTW03 恢复后续聊未完成");
    await selectV4TaskById(taskB);
    expect((await currentWorkspace()).path).toBe(second);
    await waitForV4TimelineContaining("PTW_B_DONE", 30000);
    await browser.saveScreenshot(join(artifactDir, "PTW03-restored-task.png"));

    await taskAdd();
    const missing = (await currentWorkspace()).path;
    if (!missing) throw new Error("PTW07 缺少待发送目录");
    await assertTaskDirectory(missing);
    await setV4ComposerText("E2E_PTW_RETAIN_UNSENT");
    const moved = `${missing}.moved`;
    const movedChild = relative(paths.homeDir, resolve(moved));
    if (
      !movedChild ||
      movedChild === ".." ||
      movedChild.startsWith(`..${sep}`) ||
      isAbsolute(movedChild)
    )
      throw new Error("PTW rename destination escaped fixture home");
    await expect(stat(moved)).rejects.toMatchObject({ code: "ENOENT" });
    // 已逐级核对 source、parent 和缺席 destination；仅移动本 run 内的已知夹具。
    await rename(missing, moved);
    await taskAdd(true);
    expect((await currentWorkspace()).path).toBe(missing);
    expect(await getV4ComposerText()).toBe("E2E_PTW_RETAIN_UNSENT");
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(moved)).isDirectory()).toBe(true);
    await browser.waitUntil(async () => (await $("body").getText()).includes("ENOENT"), {
      timeout: 10000,
      timeoutMsg: "PTW07 新建失败未展示目录错误",
    });
    await browser.saveScreenshot(join(artifactDir, "PTW07-missing-draft-directory.png"));
  });
});
