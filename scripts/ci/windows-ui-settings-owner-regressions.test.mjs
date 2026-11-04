import assert from "node:assert/strict";
import test from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

for (const [handler, value, expected] of [
  ["handleTerminalInheritSystemProfileChange", false, { terminalInheritSystemProfile: false }],
  ["handleTerminalFontFamilyChange", " E2E_FONT ", { terminalFontFamily: "E2E_FONT" }],
  [
    "handleIntegratedTerminalShellChange",
    { mode: "auto" },
    { integratedTerminalShell: { mode: "auto" } },
  ],
  ["handleHttpProxyChange", "", { httpProxy: "" }],
  ["handleHttpProxyNoProxyChange", " local, fixture ", { httpProxyNoProxy: "local,fixture" }],
  ["handleHttpProxyCaCertPathChange", "", { httpProxyCaCertPath: "" }],
  ["handleTaskAutoArchiveEnabledChange", true, { taskAutoArchiveEnabled: true }],
  ["handleTaskAutoArchiveOlderThanDaysChange", 30, { taskAutoArchiveOlderThanDays: 30 }],
  ["handleCloseToTrayOnWindowsChange", false, { closeToTrayOnWindows: false }],
  [
    "handleDesktopChromiumHardwareAccelerationChange",
    false,
    { desktopChromiumHardwareAccelerationEnabled: false },
  ],
  [
    "handleEmbeddedBrowserAllowInsecureCertificatesChange",
    false,
    { embeddedBrowserAllowInsecureCertificates: false },
  ],
]) {
  test(`WINUI06 ${handler} writes only to the base Host`, async () => {
    const local = [],
      foreign = [];
    const dependencies = {
      services: { settingService: { update: async (patch) => foreign.push(patch) } },
      localHostServices: {
        settingService: {
          update: async () => {
            throw new Error("DIRECT_SETTINGS_WRITE");
          },
        },
      },
      updateSharedSettings: async (patch) => local.push(patch),
      platform: { syncAppSettings() {} },
      intl: { formatMessage: ({ id }) => id },
      toast() {},
    };
    for (const name of [
      "setTerminalInheritSystemProfile",
      "setTerminalFontFamily",
      "setIntegratedTerminalShell",
      "setHttpProxy",
      "setHttpProxyNoProxy",
      "setHttpProxyCaCertPath",
      "setTaskAutoArchiveEnabled",
      "setTaskAutoArchiveOlderThanDays",
      "setCloseToTrayOnWindows",
      "setDesktopChromiumHardwareAccelerationEnabled",
      "setEmbeddedBrowserAllowInsecureCertificates",
    ])
      dependencies[name] = () => {};
    const save = await loadComponentCallback(
      "packages/ui/src/SettingsPage.tsx",
      handler,
      dependencies,
    );
    await save(value);
    assert.deepEqual(foreign, []);
    assert.deepEqual(local, [expected]);
  });
}
