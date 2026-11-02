import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import { DEFAULT_WORKSPACE, waitForDefaultWorkspaceReady } from "../helpers/desktop-app.js";

import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";

/** 仅验证离线入口与真实侧栏交互；SSH 执行和手机 shared-host 使用各自链路用例。 */
describe("远程单目录项目展示", () => {
  before(async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    const home = process.env.ZCODE_E2E_HOME_DIR;
    // 根因：旧守卫只接受手工运行的目录名，拒绝队列按批次/case 分配的独立 HOME。
    // 本例只验离线缓存，可由普通 runner 执行；仍要求统一隔离 HOME 前缀。
    const isolatedRunnerHome = home && basename(home).startsWith(".e2e-home-");
    if (
      !home ||
      (!basename(home).startsWith("zcode-remote-project-policy-e2e-") && !isolatedRunnerHome)
    )
      throw new Error("isolated HOME required");
    const db = new DatabaseSync(join(home, ".zcodium/v2/tasks-index.sqlite"));
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES('e2e-vpr-local','local','E2E_VPR_LOCAL',0,1,1)",
      ).run();
      db.prepare(
        "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES('e2e-vpr-local',?,0,1),('e2e-vpr-local',?,1,0)",
      ).run(DEFAULT_WORKSPACE, join(DEFAULT_WORKSPACE, "extra"));
      for (const device of ["a", "b"]) {
        const host = `remote:server:e2e-vpr-${device}`;
        // 无线路的离线入口只渲染缓存；用例不得借造假的连接声称 SSH 已验证。
        db.prepare(
          "INSERT INTO hosts(host_id,kind,membership_id,position,target_json) VALUES(?,'server',?,?,?)",
        ).run(
          host,
          `member-${device}`,
          device === "a" ? 1 : 2,
          JSON.stringify({
            kind: "server",
            name: `Device ${device}`,
            url: `http://127.0.0.1:1/${device}`,
          }),
        );
        db.prepare(
          "INSERT INTO remote_project_entries(entry_id,host_id,remote_project_id,cached_name,cached_roots_json,last_synced_at) VALUES(?,?,?,?,?,1)",
        ).run(
          `entry-${device}`,
          host,
          `e2e-vpr-${device}`,
          `E2E_VPR_${device.toUpperCase()}`,
          JSON.stringify([{ rootPath: "/same", isPrimary: true, position: 0 }]),
        );
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    await refreshSidebar();
    try {
      await $('[data-project-id="e2e-vpr-b"]').waitForDisplayed({ timeout: 15_000 });
    } catch (error) {
      console.error("VPR DOM", await browser.execute(() => document.body.innerText));
      await browser.saveScreenshot(join(home, "session-vpr-failure.png"));
      throw error;
    }
  });

  it("VPR01：跨设备离线排序、刷新及移除入口，侧栏不出现 Host 分组", async () => {
    expect(await $('[data-testid="remote-project-host"]').isExisting()).toBe(false);
    expect(await $$('[data-testid="project-device"]')).toHaveLength(2);
    const order = () =>
      browser.execute(() =>
        [...document.querySelectorAll('[data-testid="project-section"] [data-project-id]')].map(
          (row) => row.getAttribute("data-project-id"),
        ),
      );
    const before = await order();
    const coords = await browser.execute(() => {
      const rect = (id: string) =>
        document
          .querySelector(`[data-project-id="${id}"] [data-testid="virtual-project-toggle"]`)!
          .getBoundingClientRect();
      const a = rect("e2e-vpr-a"),
        b = rect("e2e-vpr-b");
      return {
        x: Math.round(b.x + 40),
        from: Math.round(b.y + b.height / 2),
        to: Math.round(a.y + a.height / 2),
      };
    });
    await browser.performActions([
      {
        type: "pointer",
        id: "project-mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x: coords.x, y: coords.from },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 100, x: coords.x, y: coords.from - 8 },
          { type: "pointerMove", duration: 200, x: coords.x, y: coords.to },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await browser.waitUntil(async () => JSON.stringify(await order()) !== JSON.stringify(before));
    const sorted = await order();
    expect(sorted.indexOf("e2e-vpr-b")).toBeLessThan(sorted.indexOf("e2e-vpr-a"));
    await refreshSidebar();
    await $('[data-project-id="e2e-vpr-b"]').waitForDisplayed({ timeout: 45_000 });
    expect(await order()).toEqual(sorted);
    const row = $('[data-project-id="e2e-vpr-b"]');
    // 项目缓存先到、设备状态后到；按真实离线投影断言，不能把行存在当成状态就绪。
    await browser.waitUntil(
      async () => (await row.getAttribute("data-connection-state")) === "offline",
    );
    expect(await row.$('[data-testid="virtual-project-create-task"]').isExisting()).toBe(false);
    const readOrderPreference = () =>
      browser.execute(
        () =>
          JSON.parse(localStorage.getItem("zcode-project-sidebar-preferences") ?? "{}")
            .order as string[],
      );
    const preferenceBefore = await readOrderPreference();
    await row.moveTo();
    await row.$('[data-testid="virtual-project-menu"]').click();
    await $('[data-testid="virtual-project-remove-entry"]').click();
    await row.waitForExist({ reverse: true });
    // 2026-10-15 已裁决保留暂不可见项目排序键；提前删键会让旧目录行跳到列表末尾。
    expect(await readOrderPreference()).toEqual(preferenceBefore);
    expect(await order()).toEqual(sorted.filter((id) => id !== "e2e-vpr-b"));
    await refreshSidebar();
    await $('[data-project-id="e2e-vpr-a"]').waitForDisplayed();
    expect(await row.isExisting()).toBe(false);
    expect(await order()).toEqual(sorted.filter((id) => id !== "e2e-vpr-b"));
  });
});

async function refreshSidebar() {
  await browser.refresh();
  const project = $('[data-testid="project-section"]');
  // 修复原因：欢迎页 API Key 登录已退休，隔离夹具无账号登录态可恢复；
  // 刷新屏障改为等待现有工作区外壳就绪，最后一轮已移除 B，
  // 仍只等稳定的项目分区，不等被测删除对象复活，启动失败直接抛出。
  await waitForDefaultWorkspaceReady(45_000);
  await project.waitForDisplayed({ timeout: 45_000 });
}
