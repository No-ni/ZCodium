import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  TID_SSH_DIALOG,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  sourceServerDirectorySchema,
  type ConnectionProfile,
  type SourceServerRecord,
} from "@zcode/shared";
import { clearAppData, seedSettings, clickTestIdByDom } from "../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";
import { waitForRendererAfterColdRestart } from "../helpers/ssh-remote-lifecycle.js";

const CASE_MARKER = "E2E_REMOTE_OFFLINE_ICONS";
const SOURCE_ID = "b2d3aeee-9c83-4d03-b62b-40dbed84d389";

describe(`${CASE_MARKER}: 离线设备连接按钮`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RUI-SIMPLE-11 设置页已识别和 pending SSH/Docker 均有可访问连接按钮，键盘可进入对应向导", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    // 修复原因：生产 SourceServerDirectory 只读 settings.sourceServerDirectory，
    // 旧顶层 sourceServers / connectionProfiles 与 sourceServerDirectoryMigrationVersion
    // 已不再被播种或读取，继续写旧字段只会让设置页读到空目录。
    // 修复原因：profile 合同的线路类型只由 target.kind 表达，旧 transport /
    // lifecycleState 已从合同删除；server 记录只保留
    // sourceServerId / displayName / version / lastOnlineAt / preferredProfileId，
    // 旧 installState / declaredWorkspaces / hostname 一并移除。
    // 真实 seed 前先用生产 schema 严格校验，缺字段就在当前进程失败。
    const seededAt = Date.now();
    const knownProfileId = "297c6971-47a3-40ca-8767-678b50889922";
    const pendingSshProfileId = "d41c3adc-c998-4052-b2aa-04adf90beb5e";
    const pendingDockerProfileId = "2c47f140-7116-4a1f-a7b6-098771cfe19d";
    const profiles: ConnectionProfile[] = [
      {
        profileId: knownProfileId,
        generation: 1,
        sourceServerId: SOURCE_ID,
        displayName: "E2E known",
        configurationMode: "target",
        createdAt: seededAt,
        target: { kind: "ssh", host: "127.0.0.1", port: 1, username: "e2e" },
      },
      {
        profileId: pendingSshProfileId,
        generation: 1,
        displayName: "E2E pending SSH",
        configurationMode: "target",
        createdAt: seededAt,
        target: {
          kind: "ssh",
          host: "127.0.0.1",
          port: 2,
          username: "e2e",
          sshConfigAlias: "E2E pending SSH",
        },
      },
      {
        profileId: pendingDockerProfileId,
        generation: 1,
        displayName: "e2e-pending-docker",
        configurationMode: "target",
        createdAt: seededAt,
        target: { kind: "docker", container: "e2e-pending-docker" },
      },
    ];
    // 三个 profile 一组 server：只有 known profile 通过 sourceServerId 关联该 server，
    // server 的 preferredProfileId 回指 known profile；两条 pending 不关联 server。
    const servers: SourceServerRecord[] = [
      {
        sourceServerId: SOURCE_ID,
        displayName: "E2E known",
        version: "3.17.1",
        preferredProfileId: knownProfileId,
        lastOnlineAt: seededAt,
      },
    ];
    const sourceServerDirectory = sourceServerDirectorySchema.parse({
      schemaVersion: 1,
      generation: 1,
      servers,
      profiles,
    });
    await seedSettings({
      remoteStartupAutoReconnectEnabled: false,
      sourceServerDirectory,
      sourceServerWorkspaceHistory: [],
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/e2e/known",
          workspaceIdentity: `remote:server:${SOURCE_ID}:/e2e/known`,
          target: { kind: "ssh", host: "127.0.0.1", port: 1, username: "e2e" },
          lastOpenedAt: Date.now(),
          lastConnectionStatus: "failed",
        },
        {
          kind: "remote",
          workspacePath: "/e2e/ssh",
          workspaceIdentity: "remote:ssh:127.0.0.1:2:e2e:/e2e/ssh",
          target: {
            kind: "ssh",
            host: "127.0.0.1",
            port: 2,
            username: "e2e",
            sshConfigAlias: "E2E pending SSH",
          },
          lastOpenedAt: Date.now(),
          lastConnectionStatus: "failed",
        },
        {
          kind: "remote",
          workspacePath: "/e2e/docker",
          workspaceIdentity: "remote:docker:e2e-pending-docker:/e2e/docker",
          target: { kind: "docker", container: "e2e-pending-docker" },
          lastOpenedAt: Date.now(),
          lastConnectionStatus: "failed",
        },
      ],
    });
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForRendererAfterColdRestart(CASE_MARKER);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"), { timeout: 15_000 });
    // 未连通记录现在默认折叠且用连接行展示，旧 case 按设备卡的 p 标题读取会漏掉它们。
    const unfinished = $("[data-unfinished-connections]");
    await unfinished.waitForDisplayed();
    expect(await unfinished.getAttribute("open")).toBeNull();
    await unfinished.$("summary").click();
    await browser.waitUntil(async () => (await readActions()).length === 3, {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 三条已保存连接未出现`,
    });
    const actions = await readActions();
    expect(actions.map((item) => item.name).sort()).toEqual(
      ["E2E known", "E2E pending SSH", "e2e-pending-docker"].sort(),
    );
    expect(actions.every((item) => item.label === "连接" && !item.disabled)).toBe(true);
    // 在同一轮观测中聚焦目标设备卡连接按钮，再发送真实键盘事件。
    await browser.waitUntil(
      async () => {
        const focused = await browser.execute(() => {
          const card = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-testid="settings-page"] p, [data-testid="settings-page"] span',
            ),
          )
            .find((item) => item.textContent?.trim() === "E2E pending SSH")
            ?.closest("div.group\\/line, section");
          const button = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
            (item) => item.innerText.trim() === "连接",
          );
          if (!button) return false;
          if (document.activeElement !== button) button.focus();
          return document.activeElement === button;
        });
        if (focused) await browser.keys("Enter");
        return browser.execute(
          (dialogTestId) => Boolean(document.querySelector(`[data-testid="${dialogTestId}"]`)),
          TID_SSH_DIALOG,
        );
      },
      {
        timeout: 20_000,
        interval: 1_000,
        timeoutMsg: `${CASE_MARKER}: 键盘没有触发既有 workspace 连接动作(弹窗未打开)`,
      },
    );
  });
});

function readActions() {
  return browser.execute(() =>
    ["E2E known", "E2E pending SSH", "e2e-pending-docker"].flatMap((name) => {
      // 设置页外层也包含所有标题，只取标题最近的设备卡，避免重复或点到其他设备。
      const row = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="settings-page"] p, [data-testid="settings-page"] span',
        ),
      )
        .find((item) => item.textContent?.trim() === name)
        ?.closest("div.group\\/line, section");
      const action = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (item) => item.innerText.trim() === "连接",
      );
      return action ? [{ name, label: action.innerText.trim(), disabled: action.disabled }] : [];
    }),
  );
}
