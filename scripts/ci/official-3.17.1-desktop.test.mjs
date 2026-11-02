import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { tsImport } from "tsx/esm/api";

const { resolveCuaOsSupport } = await tsImport(
  "../../packages/desktop/src/main/cuaOsSupport.ts",
  import.meta.url,
);
const { ProviderProvisioningEnvironmentCoordinator } = await tsImport(
  "../../packages/desktop/src/main/providerProvisioningEnvironmentCoordinator.ts",
  import.meta.url,
);

test("retained CUA follows the Electron 44 macOS support floor", () => {
  assert.equal(resolveCuaOsSupport("darwin", "21.6.0").minimumMacOs, "13.0");
  assert.equal(resolveCuaOsSupport("darwin", "22.1.0").kind, "supported");
  assert.equal(resolveCuaOsSupport("win32", "10.0.0").kind, "not-applicable");
});

test("desktop permission IPC keeps the selected old driver instead of an unavailable official Helper", async () => {
  const ipc = await readFile(
    new URL("../../packages/desktop/src/main/desktopCuaPermissionIpc.ts", import.meta.url),
    "utf8",
  );
  assert.match(ipc, /requestMacOSPermissionsFromHost/);
  assert.match(ipc, /@zcode\/zcode-cua\/macos-permissions/);
  assert.doesNotMatch(ipc, /createCuaHelperInstaller|ViaLaunchServices|registerCuaPip/);
});

test("device sync reports and retries only the selected device", async () => {
  let a = 0;
  let b = 0;
  const coordinator = new ProviderProvisioningEnvironmentCoordinator({ now: () => 42 });
  const first = coordinator.register(
    "environment-a",
    "host-a",
    async () => {
      a += 1;
    },
    "source-a",
  );
  const second = coordinator.register(
    "environment-b",
    "host-b",
    async () => {
      b += 1;
    },
    "source-b",
  );
  await Promise.all([first.initialSync, second.initialSync]);
  assert.deepEqual(await coordinator.retry("source-a"), {
    lane: "present",
    running: false,
    lastResult: { at: 42, outcome: "success" },
  });
  assert.equal(a, 2);
  assert.equal(b, 1);
  assert.deepEqual(await coordinator.retry("missing"), { lane: "none" });
  first.dispose();
  second.dispose();
  assert.deepEqual(await coordinator.getLaneStatus("source-a"), { lane: "none" });
});

test("replaced Host cannot publish completion or dispose its successor", async () => {
  const previous = Promise.withResolvers();
  const replacement = Promise.withResolvers();
  let calls = 0;
  const coordinator = new ProviderProvisioningEnvironmentCoordinator();
  const oldHost = coordinator.register("environment", "host", () => previous.promise, "old-source");
  const newHost = coordinator.register(
    "environment",
    "host",
    async () => {
      calls += 1;
      await replacement.promise;
    },
    "new-source",
  );
  oldHost.dispose();
  previous.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal((await coordinator.getLaneStatus("new-source")).running, true);
  assert.deepEqual(await coordinator.getLaneStatus("old-source"), { lane: "none" });
  replacement.resolve();
  await Promise.all([oldHost.initialSync, newHost.initialSync]);
  assert.equal((await coordinator.getLaneStatus("new-source")).running, false);
  newHost.dispose();
});

test("initial provisioning failure does not open the workspace publication barrier", async () => {
  const coordinator = new ProviderProvisioningEnvironmentCoordinator();
  const handle = coordinator.register(
    "environment",
    "host",
    async () => {
      throw new Error("fixture failure");
    },
    "source",
  );
  await assert.rejects(handle.initialSync, /fixture failure/);
  assert.deepEqual(await coordinator.getLaneStatus("source"), { lane: "none" });
  handle.dispose();
});
