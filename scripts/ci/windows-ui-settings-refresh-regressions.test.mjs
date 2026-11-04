import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const text = await readFile("packages/ui/src/hooks/useSettingService.ts", "utf8");
const source = ts.createSourceFile("settings.ts", text, ts.ScriptTarget.Latest, true);
const js = ts.transpileModule(
  source.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => statement.getText(source).replace(/^export\s+/, ""))
    .join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } },
).outputText;

function load(services = {}) {
  return new Function(
    "useServices",
    "usePlatform",
    "useState",
    "useEffect",
    "useCallback",
    js +
      "\nreturn { refresh: refreshSharedSettings, snapshot: getSettingsSnapshot, key: resolveSettingsCacheKey, update: updateSettingsAndRefreshSnapshot, hook: useSettings, acquire: acquirePlatformSettingsSubscription };",
  )(
    () => services,
    () => ({ syncAppSettings() {} }),
    (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    () => {},
    (callback) => callback,
  );
}
function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}
function fixture() {
  const old = deferred();
  let value = { nativeSearchEnhancementsEnabled: true },
    reads = 0;
  const service = {
    get: () => (++reads === 1 ? old.promise : Promise.resolve({ ...value })),
    update: async (patch) => {
      value = { ...value, ...patch };
    },
  };
  const api = load({ settingService: service });
  const key = api.key(undefined, service);
  const initial = api.refresh(key, () => service.get());
  return { api, key, service, initial, old, reads: () => reads };
}

for (const path of ["hook", "helper"]) {
  test(`WINUI11 ${path} save refreshes after a pending old read`, async () => {
    const run = fixture();
    const patch = { nativeSearchEnhancementsEnabled: false };
    let settled = false;
    const save = (
      path === "hook"
        ? run.api.hook().update(patch)
        : run.api.update({ settingService: run.service, patch })
    ).then(() => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false);
    run.old.resolve({ nativeSearchEnhancementsEnabled: true });
    await save;
    assert.equal(run.reads(), 2);
    assert.equal(run.api.snapshot(run.key).settings.nativeSearchEnhancementsEnabled, false);
  });
}
test("WINUI11 concurrent committed saves share the post-write read", async () => {
  const run = fixture();
  const hook = run.api.hook();
  const saves = [
    hook.update({ nativeSearchEnhancementsEnabled: false }),
    hook.update({ keepAwakeWhileRunning: true }),
  ];
  await flush();
  run.old.resolve({ nativeSearchEnhancementsEnabled: true });
  await Promise.all(saves);
  assert.equal(run.reads(), 2);
  assert.deepEqual(run.api.snapshot(run.key).settings, {
    nativeSearchEnhancementsEnabled: false,
    keepAwakeWhileRunning: true,
  });
});
test("WINUI11 save stays pending until the new read completes", async () => {
  const run = fixture();
  const fresh = deferred();
  const originalGet = run.service.get;
  run.service.get = () => {
    originalGet();
    return fresh.promise;
  };
  let settled = false;
  const save = run.api
    .hook()
    .update({ nativeSearchEnhancementsEnabled: false })
    .then(() => {
      settled = true;
    });
  await flush();
  run.old.resolve({ nativeSearchEnhancementsEnabled: true });
  await flush();
  assert.equal(settled, false);
  assert.equal(run.reads(), 2);
  fresh.resolve({ nativeSearchEnhancementsEnabled: false });
  await save;
  assert.equal(run.api.snapshot(run.key).settings.nativeSearchEnhancementsEnabled, false);
});
test("WINUI11 a later commit during the post-write read gets a newer read", async () => {
  const run = fixture();
  run.old.resolve({ nativeSearchEnhancementsEnabled: true });
  await run.initial;
  const fresh = deferred();
  const originalGet = run.service.get;
  run.service.get = () => {
    const latest = originalGet();
    return run.reads() === 2 ? fresh.promise : latest;
  };
  const first = run.api.hook().update({ nativeSearchEnhancementsEnabled: false });
  await flush();
  const second = run.api.hook().update({ keepAwakeWhileRunning: true });
  await flush();
  fresh.resolve({ nativeSearchEnhancementsEnabled: false });
  await Promise.all([first, second]);
  assert.equal(run.reads(), 3);
  assert.deepEqual(run.api.snapshot(run.key).settings, {
    nativeSearchEnhancementsEnabled: false,
    keepAwakeWhileRunning: true,
  });
});
test("WINUI11 CAS failure reloads current facts before rejecting", async () => {
  const run = fixture();
  const failure = new Error("E2E_CAS_CONFLICT");
  run.service.update = async () => {
    throw failure;
  };
  const save = assert.rejects(
    run.api.hook().update({}, { fixture: true }),
    (error) => error === failure,
  );
  await flush();
  run.old.resolve({ nativeSearchEnhancementsEnabled: false });
  await save;
  assert.equal(run.reads(), 2);
  assert.equal(run.api.snapshot(run.key).settings.nativeSearchEnhancementsEnabled, true);
});
test("WINUI11 ordinary concurrent refreshes remain single flight", async () => {
  const run = fixture();
  const reads = [run.initial, run.api.refresh(run.key, () => run.service.get())];
  run.old.resolve({ nativeSearchEnhancementsEnabled: true });
  await Promise.all(reads);
  assert.equal(run.reads(), 1);
});
test("WINUI11 a platform change during a pending read refreshes its newer facts", async () => {
  const run = fixture();
  let changed;
  const release = run.api.acquire(
    run.service,
    {
      onSettingsChanged(listener) {
        changed = listener;
        return () => {};
      },
    },
    run.key,
  );
  await run.service.update({ nativeSearchEnhancementsEnabled: false });
  changed();
  run.old.resolve({ nativeSearchEnhancementsEnabled: true });
  await flush();
  assert.equal(run.api.snapshot(run.key).settings.nativeSearchEnhancementsEnabled, false);
  assert.equal(run.reads(), 2);
  release();
});
test("WINUI11 an idle save needs only one read", async () => {
  let value = { keepAwakeWhileRunning: false },
    reads = 0;
  const service = {
    get: async () => {
      reads++;
      return { ...value };
    },
    update: async (patch) => {
      value = { ...value, ...patch };
    },
  };
  const api = load({ settingService: service });
  await api.hook().update({ keepAwakeWhileRunning: true });
  assert.equal(reads, 1);
  assert.equal(api.snapshot(api.key(undefined, service)).settings.keepAwakeWhileRunning, true);
});
test("WINUI11 separate service snapshots never join one another", async () => {
  const api = load();
  const old = deferred();
  const serviceA = { get: () => old.promise };
  const serviceB = { get: async () => ({ keepAwakeWhileRunning: true }), update: async () => {} };
  const keyA = api.key(undefined, serviceA);
  const initial = api.refresh(keyA, () => serviceA.get());
  await api.update({ settingService: serviceB, patch: {} });
  assert.equal(api.snapshot(keyA).loading, true);
  assert.equal(api.snapshot(api.key(undefined, serviceB)).settings.keepAwakeWhileRunning, true);
  old.resolve({ keepAwakeWhileRunning: false });
  await initial;
});
test("WINUI11 failed reads retain the last usable snapshot and error", async () => {
  const api = load();
  await api.refresh("fixture", async () => ({ keepAwakeWhileRunning: true }));
  const failure = new Error("E2E_READ_FAILED");
  await api.refresh("fixture", async () => {
    throw failure;
  });
  assert.equal(api.snapshot("fixture").settings.keepAwakeWhileRunning, true);
  assert.equal(api.snapshot("fixture").error, failure);
  assert.equal(api.snapshot("fixture").loading, false);
});
