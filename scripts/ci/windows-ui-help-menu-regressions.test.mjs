import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function sourceBody(path) {
  const text = await readFile(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  return ts.transpileModule(
    file.statements
      .filter((node) => !ts.isImportDeclaration(node))
      .map((node) => node.getText(file).replace(/^export\s+/, ""))
      .join("\n")
      .replaceAll("import.meta.dirname", JSON.stringify("fixture-desktop")),
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } },
  ).outputText;
}
function evaluate(body, ports, expression) {
  return new Function(...Object.keys(ports), body + "\nreturn " + expression + ";")(
    ...Object.values(ports),
  );
}
const envBody = await sourceBody("packages/shared/src/env.ts");
const uiBody = await sourceBody("packages/ui/src/lib/desktopUpdateMenu.ts");
const menuBody = await sourceBody("packages/desktop/src/main/desktopApplicationMenu.ts");
const trayBody = await sourceBody("packages/desktop/src/main/desktopTray.ts");
const actionBody = await sourceBody("packages/ui/src/lib/helpMenuActions.ts");
const ids = new Proxy({}, { get: (_, key) => key });
const matrix = [
  ["production", "", false],
  ["production", "  ", false],
  ["preview", "https://example.invalid", false],
  ["production", "https://example.invalid", true],
];
function policy(flavor, origin) {
  return evaluate(
    envBody,
    {
      __ZCODE_ENV__: "production",
      __ZCODE_PRODUCT_FLAVOR__: flavor,
      __ZCODIUM_UPDATE_ORIGIN__: origin,
      process: { env: {} },
    },
    'typeof shouldEnableDesktopAutoUpdates === "function" ? shouldEnableDesktopAutoUpdates : null',
  );
}
function ports(flavor, origin) {
  return {
    ZCODE_ENV: "production",
    ZCODE_PRODUCT_FLAVOR: flavor,
    ZCODIUM_UPDATE_ORIGIN: origin,
    shouldEnableDesktopAutoUpdates: policy(flavor, origin),
    DesktopCommandIds: ids,
    desktopMenuMessageIds: ids,
    getDesktopMenuMessage: (_, id) => id,
  };
}
function containsUpdate(entries) {
  return entries.some(
    (entry) => entry.label === "helpCheckForUpdates" || containsUpdate(entry.submenu ?? []),
  );
}

test("WINUI15 shared eligibility requires production flavor and a configured own source", () => {
  for (const [flavor, origin, expected] of matrix) {
    const resolve = policy(flavor, origin);
    assert.equal(typeof resolve, "function");
    assert.equal(resolve(), expected, `${flavor}/${JSON.stringify(origin)}`);
  }
});
test("WINUI15 renderer update entry follows source availability", () => {
  for (const [flavor, origin, expected] of matrix) {
    const visible = evaluate(uiBody, ports(flavor, origin), "shouldShowDesktopUpdateEntry");
    assert.equal(visible(), expected, `${flavor}/${JSON.stringify(origin)}`);
  }
});
test("WINUI15 native menus hide unavailable update actions on Windows and macOS", () => {
  for (const platform of ["win32", "darwin"]) {
    for (const [flavor, origin, expected] of matrix) {
      const build = evaluate(
        menuBody,
        {
          ...ports(flavor, origin),
          app: { name: "Fixture", isPackaged: true },
          process: { platform },
          readZCodeStdioTapDevState: () => ({ enabled: false, visible: false }),
          clampDesktopZoomLevel: (value) => value,
          DESKTOP_ZOOM_MIN_LEVEL: -3,
          DESKTOP_ZOOM_MAX_LEVEL: 3,
          CHECK_FOR_UPDATE_MENU_ID: "fixture-update",
          HELP_TOGGLE_DEV_TOOLS_MENU_ID: "fixture-devtools",
          HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID: "fixture-stdio",
        },
        "buildApplicationMenuTemplate",
      );
      assert.equal(
        containsUpdate(build({ currentApplicationLocale: "en-US", executeDesktopCommand() {} })),
        expected,
        `${platform}/${flavor}/${JSON.stringify(origin)}`,
      );
    }
  }
});
test("WINUI15 Windows tray uses the same update eligibility", () => {
  for (const [flavor, origin, expected] of matrix) {
    let menu;
    const create = evaluate(
      trayBody,
      {
        ...ports(flavor, origin),
        app: { isPackaged: true },
        process: { platform: "win32", resourcesPath: "fixture-resources" },
        join: (...parts) => parts.join("/"),
        nativeImage: { createFromPath: () => ({}) },
        Menu: { buildFromTemplate: (entries) => entries },
        Tray: class {
          setToolTip() {}
          setContextMenu(entries) {
            menu = entries;
          }
          on() {}
        },
      },
      "createWindowsDesktopTray",
    );
    create({ getLocale: () => "en-US", logger: { warn() {} } });
    assert.equal(containsUpdate(menu), expected, `${flavor}/${JSON.stringify(origin)}`);
  }
});

test("WINUI16 help actions observe rejected platform calls, localize failures and allow retry", async () => {
  let reject = true;
  const calls = [],
    logs = [],
    toasts = [];
  const fail = (id) => async () => {
    calls.push(id);
    if (reject) throw new Error("E2E_RAW_ERROR_MUST_NOT_BE_LOGGED");
  };
  const create = evaluate(
    actionBody,
    {
      DesktopCommandIds: ids,
      logger: { warn: (...args) => logs.push(args) },
      toast: (message) => toasts.push(message),
      runExportLogsAction: async () => {},
      ZCODE_PRODUCT_DOCS_URL: "https://example.invalid/docs",
    },
    "createHelpMenuActionHandlers",
  );
  for (const locale of ["en-US", "zh-CN"]) {
    const handlers = create({
      platform: {
        openFeedback: fail("feedback"),
        openExternal: fail("docs"),
        openCommunity: fail("community"),
        executeDesktopCommand: (command) => fail(command)(),
      },
      intl: { formatMessage: ({ id }) => `${locale}:${id}` },
    });
    for (const name of [
      "openIssueReport",
      "openProductDocs",
      "openCommunity",
      "openResourceManager",
      "showAbout",
      "checkForUpdates",
    ]) {
      reject = true;
      const before = calls.length;
      await handlers[name]();
      assert.equal(toasts.at(-1), `${locale}:helpMenu.actionFailed`);
      reject = false;
      await handlers[name]();
      assert.equal(calls.length, before + 2);
    }
  }
  assert.equal(logs.length, 12);
  assert.deepEqual(
    calls,
    ["feedback", "docs", "community", "OpenResourceManager", "ShowAbout", "CheckForUpdates"]
      .flatMap((id) => [id, id])
      .concat(
        [
          "feedback",
          "docs",
          "community",
          "OpenResourceManager",
          "ShowAbout",
          "CheckForUpdates",
        ].flatMap((id) => [id, id]),
      ),
  );
  assert.equal(JSON.stringify(logs).includes("E2E_RAW_ERROR"), false);
});
