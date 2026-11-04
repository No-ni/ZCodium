import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

test(
  "WINUI01–14/20: desktop chrome, settings snapshots, native events, history and notifications",
  { timeout: 240000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "windows-ui",
      entry: "scripts/ci/fixtures/windows-ui-regressions.html",
      optimizeDepsInclude: [
        "qrcode",
        "border-beam",
        "ansi-to-react",
        "react-jsx-parser",
        "react-pdf",
      ],
    });
    let context;
    const errors = [],
      external = [];
    try {
      const { chromium } = await import("playwright-core");
      const downloads = await assertProjectPath(join(fixture.sandbox.root, "downloads"));
      await mkdir(downloads);
      context = await chromium.launchPersistentContext(
        await assertProjectPath(join(fixture.sandbox.root, "profile")),
        {
          executablePath: await assertProjectPath(process.env.PROJECT_TEST_BROWSER_EXECUTABLE),
          headless: true,
          env: fixture.sandbox.env,
          downloadsPath: downloads,
          args: [
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--disable-breakpad",
            "--no-first-run",
            "--no-default-browser-check",
          ],
        },
      );
      context.setDefaultTimeout(15000);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          ["data:", "blob:", "about:"].includes(url.protocol) ||
          url.origin === new URL(fixture.origin).origin
        )
          await route.continue();
        else {
          external.push(url.origin);
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (/Each child in a list|Encountered two children with the same key/.test(message.text()))
          errors.push(message.text());
      });
      for (const platform of ["windows", "mac"]) {
        await page.goto(`${fixture.url}?platform=${platform}`);
        const back = page.getByTestId("desktop-top-nav-back");
        await back.first().waitFor();
        assert.equal(await back.count(), 1, `${platform}: duplicate back control`);
        const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true });
        assert.equal(await toggle.count(), 1, `${platform}: duplicate sidebar control`);
        await toggle.click();
        await back.click();
        await page.getByRole("button", { name: "Go forward", exact: true }).click();
        assert.deepEqual(
          await page.evaluate(() => [
            window.fixtureCalls.toggle,
            window.fixtureCalls.back,
            window.fixtureCalls.forward,
          ]),
          [1, 1, 1],
        );
        assert.equal(await toggle.count(), 1);
        // 再展开侧栏后新建按钮折叠隐藏，不能留在键盘焦点序列里。
        await toggle.click();
        const newTask = page.locator('button[aria-label="New task"]');
        await newTask.evaluate((button) => button.focus());
        assert.equal(await newTask.evaluate((button) => button === document.activeElement), false);
        await toggle.click();
        await newTask.focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.evaluate(() => window.fixtureCalls.create), 1);
      }
      for (const [platform, width, locale, theme] of [
        ["windows", 1280, "zh-CN", "zai-light"],
        ["windows", 1280, "en-US", "zai-dark"],
        ["web", 390, "zh-CN", "zai-light"],
        ["web", 390, "en-US", "zai-dark"],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `${fixture.url}?view=settings&platform=${platform}&locale=${locale}&theme=${theme}`,
        );
        await page.getByTestId("settings-page").waitFor();
        for (const hidden of ["remoteDevices", "dataSync"])
          assert.equal(await page.getByTestId(`settings-section-nav-${hidden}`).count(), 0);
        await page.getByTestId("settings-section-nav-personalization").click();
        if (platform === "windows") {
          const editor = page.getByTestId("settings-personalization-editor");
          await editor.waitFor();
          await editor.fill("E2E_WINUI_LOCAL_SAVE");
          await page.getByTestId("settings-personalization-save").click();
          await page.waitForFunction(() => window.fixtureCalls.localWrites.length === 1);
          await editor.fill("E2E_UNSAVED");
          await page.getByTestId("settings-personalization-cancel").click();
          assert.equal(await editor.inputValue(), "E2E_WINUI_LOCAL_SAVE");
          assert.equal(await page.evaluate(() => window.fixtureCalls.foreignWrites), 0);
        } else assert.equal(await page.getByTestId("settings-personalization-editor").count(), 0);
        for (const [section, marker] of [
          ["projects", "project-management"],
          ["archives", "archive-management"],
        ]) {
          await page.getByTestId(`settings-section-nav-${section}`).click();
          await page.getByTestId(marker).waitFor();
          const emptyText =
            section === "projects"
              ? locale === "zh-CN"
                ? "还没有项目"
                : "No projects yet"
              : locale === "zh-CN"
                ? "暂无已归档会话"
                : "No archived sessions";
          await page.getByTestId(marker).getByText(emptyText, { exact: true }).waitFor();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await page.screenshot({
            path: await assertProjectPath(
              join(fixture.sandbox.root, `${platform}-${locale}-${theme}-${section}.png`),
            ),
            fullPage: true,
          });
        }
        await page.evaluate(() => window.fixture.intent("remoteDevices"));
        await page.waitForFunction(
          (section) =>
            document
              .querySelector('[data-testid="settings-page"]')
              ?.getAttribute("data-active-section") === section,
          platform === "windows" ? "sourceServers" : "general",
        );
        await page.evaluate(() => window.fixture.intent("dataSync"));
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="settings-page"]')
              ?.getAttribute("data-active-section") === "general",
        );
      }
      await page.goto(`${fixture.url}?view=settings&platform=windows&locale=en-US`);
      await page.getByTestId("settings-section-nav-general").click();
      const proxy = page.getByPlaceholder(/http:\/\/127\.0\.0\.1:7890/);
      await proxy.waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("input")].some(
          (input) => input.value === "http://127.0.0.1:18080",
        ),
      );
      await proxy.fill("http://127.0.0.1:18081");
      await proxy.press("Enter");
      await page.getByTestId("archive-auto-archive-switch").click();
      await page.getByTestId("settings-native-search-switch").click();
      await page.waitForFunction(() => window.fixtureCalls.localSettingsWrites.length >= 3);
      assert.deepEqual(await page.evaluate(() => window.fixtureCalls.foreignSettingsWrites), []);
      assert.equal(await page.evaluate(() => window.fixtureCalls.foreignSettingsReads), 0);
      assert.deepEqual(await page.evaluate(() => window.fixtureCalls.localSettingsWrites), [
        { httpProxy: "http://127.0.0.1:18081" },
        { taskAutoArchiveEnabled: true },
        { nativeSearchEnhancementsEnabled: false },
      ]);
      await page.getByTestId("settings-section-nav-shortcuts").click();
      await page.getByTestId("settings-shortcut-clear-zoomIn").click();
      await page.waitForFunction(
        () =>
          window.fixtureCalls.localSettingsWrites.length > 3 ||
          window.fixtureCalls.foreignSettingsWrites.length > 0,
      );
      assert.deepEqual(await page.evaluate(() => window.fixtureCalls.foreignSettingsWrites), []);
      assert.equal(await page.evaluate(() => window.fixtureCalls.foreignSettingsReads), 0);
      assert.deepEqual(await page.evaluate(() => window.fixtureCalls.localSettingsWrites.at(-1)), {
        shortcutBindings: { zoomIn: [] },
      });
      await page.getByTestId("settings-shortcut-bind-zoomIn-unassigned").waitFor();
      await page.goto(`${fixture.url}?view=settings-race&platform=windows`);
      await page.getByTestId("settings-race-save").click();
      await page.waitForFunction(() => window.fixtureCalls.localSettingsWrites.length === 1);
      assert.equal(await page.getByTestId("settings-race-saved").textContent(), "false");
      await page.evaluate(() => window.fixture.releaseSettingsRead());
      await page.waitForFunction(
        () => document.querySelector('[data-testid="settings-race-saved"]')?.textContent === "true",
      );
      assert.equal(await page.getByTestId("settings-race-value").textContent(), "true");
      assert.equal(await page.evaluate(() => window.fixtureCalls.localSettingsReads), 2);
      assert.equal(await page.evaluate(() => window.fixtureCalls.foreignSettingsReads), 0);
      for (const platform of ["windows", "web"]) {
        await page.goto(`${fixture.url}?view=shortcut-probe&platform=${platform}&locale=en-US`);
        await page.getByTestId("shortcut-probe-label").waitFor();
        await page.waitForFunction(() =>
          /[YU]/.test(
            document.querySelector('[data-testid="shortcut-probe-label"]')?.textContent ?? "",
          ),
        );
        assert.match(await page.getByTestId("shortcut-probe-label").textContent(), /Y/);
        await page.keyboard.press("Control+Shift+y");
        await page.keyboard.press("Control+Shift+u");
        assert.equal(await page.evaluate(() => window.fixtureCalls.keyboard), 1);
        for (const remote of [false, true]) {
          await page.evaluate((remote) => window.fixture.setProbeRemote(remote), remote);
          await page.keyboard.press("Control+Shift+y");
        }
        assert.equal(await page.evaluate(() => window.fixtureCalls.keyboard), 3);
        assert.equal(await page.evaluate(() => window.fixtureCalls.foreignSettingsReads), 0);
        await page.evaluate(() => window.fixture.setView("settings"));
        await page.getByTestId("settings-section-nav-shortcuts").click();
        await page.getByTestId("settings-shortcut-edit-toggleSidebar-0").click();
        await page.keyboard.press("Control+Shift+k");
        await page.waitForFunction(() => window.fixtureCalls.localSettingsWrites.length > 0);
        await page.evaluate(() => window.fixture.setView("shortcut-probe"));
        await page.waitForFunction(() =>
          document.querySelector('[data-testid="shortcut-probe-label"]')?.textContent.includes("K"),
        );
        await page.keyboard.press("Control+Shift+y");
        await page.keyboard.press("Control+Shift+k");
        assert.equal(await page.evaluate(() => window.fixtureCalls.keyboard), 4);
        assert.equal(await page.evaluate(() => window.fixtureCalls.foreignSettingsReads), 0);
        assert.deepEqual(await page.evaluate(() => window.fixtureCalls.foreignSettingsWrites), []);
      }
      await page.goto(`${fixture.url}?view=settings&race=shadow&platform=windows&locale=en-US`);
      await page.getByTestId("settings-section-nav-general").click();
      const autoArchive = page.getByTestId("archive-auto-archive-switch");
      await autoArchive.waitFor();
      await page.waitForFunction(() => window.fixtureCalls.localSettingsReads > 0);
      await page.evaluate(() => window.fixture.beginSettingsInteraction());
      await autoArchive.click();
      await page.waitForFunction(() => window.fixtureCalls.localSettingsWrites.length === 1);
      await page.evaluate(async () => {
        window.fixture.releaseSettingsRead();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      assert.equal(
        await autoArchive.getAttribute("data-state"),
        "checked",
        "late page read reverted the saved setting",
      );
      for (const enabled of [false, true]) {
        await page.evaluate(
          (enabled) => window.fixture.patchLocalSettings({ taskAutoArchiveEnabled: enabled }),
          enabled,
        );
        await page.waitForFunction(
          (enabled) =>
            document
              .querySelector('[data-testid="archive-auto-archive-switch"]')
              ?.getAttribute("data-state") === (enabled ? "checked" : "unchecked"),
          enabled,
        );
      }
      await page.evaluate(() =>
        window.fixture.patchLocalSettings({ httpProxy: "http://127.0.0.1:18082" }),
      );
      await page.waitForFunction(() =>
        [...document.querySelectorAll("input")].some(
          (input) => input.value === "http://127.0.0.1:18082",
        ),
      );
      assert.deepEqual(await page.evaluate(() => window.fixtureCalls.foreignSettingsWrites), []);
      await page.goto(`${fixture.url}?view=root-events&platform=windows&locale=en-US`);
      await page.getByTestId("root-events-locale").waitFor();
      await page.evaluate(() => window.fixtureRoot.emit("notification", "E2E_NOTICE_TASK"));
      assert.deepEqual(await page.evaluate(() => window.fixtureRoot.calls.activated), [
        { path: "/fixture/project", identity: "remote:server:fixture-source:/fixture/project" },
      ]);
      assert.deepEqual(await page.evaluate(() => window.fixtureRoot.storeKeys()), [
        "remote:server:fixture-source:/fixture/project",
      ]);
      await page.evaluate(() => window.fixtureRoot.setLocale("zh-CN"));
      await page.waitForFunction(
        () => document.querySelector('[data-testid="root-events-locale"]')?.textContent === "zh-CN",
      );
      await page.evaluate(() => window.fixtureRoot.emit("update", { kind: "dev-skipped" }));
      await page.getByText("开发环境不检查更新", { exact: true }).waitFor();
      await page.evaluate(() => window.fixtureRoot.setVersion(1));
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="root-events-locale"]')
            ?.getAttribute("data-version") === "1",
      );
      assert.deepEqual(await page.evaluate(() => window.fixtureRoot.listenerCounts()), [1, 1, 1]);
      await page.evaluate(() => window.fixtureRoot.emit("openPath", "/fixture/new"));
      assert.deepEqual(await page.evaluate(() => window.fixtureRoot.calls.opened), [
        { version: 1, path: "/fixture/new" },
      ]);
      await page.evaluate(() => window.fixtureRoot.setAllowed(false));
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="root-events-locale"]')
            ?.getAttribute("data-allowed") === "false",
      );
      await page.evaluate(() => window.fixtureRoot.emit("openPath", "/fixture/blocked"));
      assert.equal(await page.evaluate(() => window.fixtureRoot.calls.opened.length), 1);
      await page.evaluate(() => window.fixtureRoot.unmount());
      await page.waitForFunction(() =>
        window.fixtureRoot.listenerCounts().every((count) => count === 0),
      );
      await page.goto(`${fixture.url}?view=history&platform=windows`);
      const back = page.getByTestId("desktop-top-nav-back");
      const forward = page.getByRole("button", { name: "Go forward", exact: true });
      await back.waitFor();
      assert.equal(await back.isEnabled(), true);
      assert.equal(await forward.isEnabled(), true);
      await page.evaluate(() => window.fixture.setRestart(true));
      await page.waitForFunction(
        () => document.querySelector('[data-testid="desktop-top-nav-back"]')?.disabled,
      );
      assert.equal(await forward.isDisabled(), true);
      await page.evaluate(() => window.fixture.setRestart(false, ""));
      assert.equal(
        await back.isDisabled(),
        true,
        "local same-path state must not unlock remote navigation",
      );
      await page.evaluate(() => window.fixture.setRestart(false));
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="desktop-top-nav-back"]')?.disabled,
      );
      assert.equal(await forward.isEnabled(), true);
      for (const [platform, locale, width] of [
        ["windows", "en-US", 1280],
        ["mac", "zh-CN", 1280],
        ["web", "zh-CN", 390],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `${fixture.url}?view=history&platform=${platform}&locale=${locale}&strict=1`,
        );
        await page.getByTestId("desktop-top-nav-back").waitFor();
        for (const [direction, taskIds, cursor, target] of [
          ["forward", ["current", "gone", "gone", "next"], 0, "next"],
          ["back", ["gone", "previous", "gone", "current", "next", "last"], 3, "previous"],
          ["forward", ["current", "gone", "gone"], 0, "current"],
          ["back", ["gone", "gone", "current", "next"], 2, "current"],
        ]) {
          await page.evaluate(
            ({ taskIds, cursor }) =>
              window.fixtureHistory.seed(
                taskIds,
                cursor,
                taskIds.filter((id) => id !== "gone"),
              ),
            { taskIds, cursor },
          );
          const button =
            direction === "back"
              ? page.getByTestId("desktop-top-nav-back")
              : page.getByRole("button", {
                  name: locale === "zh-CN" ? "前进" : "Go forward",
                  exact: true,
                });
          await button.click();
          await page.waitForFunction(
            (target) => window.fixtureHistory.snapshot().active === target,
            target,
          );
          const result = await page.evaluate(() => window.fixtureHistory.snapshot());
          assert.equal(result.taskIds.includes("gone"), false);
          if (target !== "current") assert.equal(result.taskIds[result.cursor], target);
        }
        await page.screenshot({
          path: await assertProjectPath(
            join(fixture.sandbox.root, `${platform}-history-duplicates.png`),
          ),
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${fixture.url}?platform=windows`);
      await page.waitForFunction(() => window.fixture && window.fixtureCalls.badges.length > 0);
      assert.equal(
        await page.evaluate(() =>
          window.fixtureCalls.badges.some((value) =>
            typeof value === "number" ? value > 0 : value.count > 0,
          ),
        ),
        false,
        "stale Root cache overwrote empty authoritative tree",
      );
      const task = {
        hostId: "local",
        taskId: "same-id",
        workspacePath: "fixture-workspace",
        projectId: null,
        unreadAt: 1,
        archived: false,
        pinned: false,
        createdAt: 1,
        updatedAt: 1,
        title: "Fixture",
        provider: "zcode",
      };
      await page.evaluate(
        async (task) =>
          window.fixture.setTree({
            projects: [],
            tasks: [
              task,
              task,
              { ...task, workspaceIdentity: "other-identity" },
              { ...task, hostId: "remote", pinned: true },
              { ...task, taskId: "archived", archived: true },
              { ...task, taskId: "orphan", projectId: "missing" },
            ],
          }),
        task,
      );
      await page.waitForFunction(() => window.fixtureCalls.badges.at(-1)?.count === 3);
      assert.equal(
        new Set(await page.evaluate(() => window.fixtureCalls.badges.at(-1).taskKeys)).size,
        3,
      );
      const oldKeys = await page.evaluate(() => window.fixtureCalls.badges.at(-1).taskKeys);
      await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
      await page.evaluate(
        async (task) =>
          window.fixture.setTree({
            projects: [{ id: "deleted-project", hostId: "local", deleted: true, roots: [] }],
            tasks: [
              task,
              { ...task, workspaceIdentity: "replacement-identity" },
              { ...task, hostId: "remote", pinned: true },
              { ...task, taskId: "deleted-project-task", projectId: "deleted-project" },
            ],
          }),
        task,
      );
      await page.waitForFunction(() =>
        window.fixtureCalls.badges
          .at(-1)
          ?.taskKeys.some((key) => key.includes("replacement-identity")),
      );
      assert.equal(await page.evaluate(() => window.fixtureCalls.badges.at(-1).count), 3);
      assert.notDeepEqual(
        await page.evaluate(() => window.fixtureCalls.badges.at(-1).taskKeys),
        oldKeys,
      );
      await page.evaluate(() => window.fixture.setNotification(false));
      await page.waitForFunction(() => window.fixtureCalls.badges.at(-1)?.count === 0);
      await page.evaluate(() => window.fixture.setNotification(true));
      await page.waitForFunction(() => window.fixtureCalls.badges.at(-1)?.count === 3);
      await page.evaluate(() => window.fixture.setTree({ projects: [], tasks: [] }));
      await page.waitForFunction(() => window.fixtureCalls.badges.at(-1)?.count === 0);
      await page.goto(`${fixture.url}?platform=web`);
      await page.getByTestId("desktop-top-nav-back").waitFor();
      assert.deepEqual(await page.evaluate(() => window.fixtureCalls.badges), []);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`WINUI evidence: ${fixture.sandbox.root}`);
    } finally {
      await context?.close();
      await fixture.close();
    }
  },
);
