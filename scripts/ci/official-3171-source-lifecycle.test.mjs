import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { tsImport } from "tsx/esm/api";

const { executeSourceServerCommand } = await tsImport(
  "../../packages/server/src/source-server/adapters.ts",
  import.meta.url,
);
const { SourceServerConnectionManager } = await tsImport(
  "../../packages/desktop/src/host/sourceServerConnectionManager.ts",
  import.meta.url,
);

function backendFixture({ installed = true, response = "[]", exitCode = 0 } = {}) {
  const calls = [];
  let disposals = 0;
  const backend = {
    async detect() {
      return { platform: "darwin", arch: "arm64" };
    },
    async exists() {
      return installed;
    },
    async exec(command) {
      calls.push(command);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      let close;
      setImmediate(() => {
        stdout.end(response);
        stderr.end();
        close?.(exitCode);
      });
      return {
        stdin,
        stdout,
        stderr,
        onClose(listener) {
          close = listener;
          return { dispose() {} };
        },
      };
    },
    async disposeAndWait() {
      disposals += 1;
    },
    dispose() {
      throw new Error("Must await backend disposal");
    },
    async upload() {
      throw new Error("A lifecycle operation cannot upload");
    },
  };
  return {
    backend,
    calls,
    get disposals() {
      return disposals;
    },
  };
}

test("explicit Source commands only execute the installed CLI and never install/register", async () => {
  for (const command of ["stop", "restart", "running-tasks"]) {
    const fixture = backendFixture();
    await executeSourceServerCommand(
      { kind: "ssh", host: "fixture", username: "fixture" },
      command,
      {
        createBackend: async () => fixture.backend,
      },
    );
    assert.equal(fixture.disposals, 1);
    assert.equal(fixture.calls.length, 1);
    assert.match(fixture.calls[0], /\$HOME\/\.zcodium\/server/);
    assert.match(fixture.calls[0], command === "stop" ? /stop --wait/ : new RegExp(` ${command} `));
    if (command === "restart")
      assert.match(fixture.calls[0], /^ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 /);
    assert.doesNotMatch(fixture.calls[0], /curl|wget|install|update|upload/);
  }
});

test("missing predeployment fails closed without executing a command", async () => {
  const fixture = backendFixture({ installed: false });
  await assert.rejects(
    executeSourceServerCommand({ kind: "docker", container: "fixture" }, "restart", {
      createBackend: async () => fixture.backend,
    }),
    { code: "source-server-install-required" },
  );
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.disposals, 1);
});

test("the public adapter rejects commands outside the explicit lifecycle contract", async () => {
  const fixture = backendFixture();
  await assert.rejects(
    executeSourceServerCommand({ kind: "docker", container: "fixture" }, "install; update", {
      createBackend: async () => fixture.backend,
    }),
    /not supported/,
  );
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.disposals, 0);
});

function managerFixture(executeCommand) {
  const profile = {
    profileId: "profile",
    generation: 1,
    sourceServerId: "source",
    target: { kind: "docker", container: "fixture" },
  };
  let current = profile;
  const listeners = new Set();
  const directory = {
    async assertCurrent(input) {
      if (
        !current ||
        input.profileId !== current.profileId ||
        input.generation !== current.generation
      )
        throw new Error("stale profile");
      return current;
    },
    async snapshot() {
      return { generation: current?.generation ?? 2, profiles: current ? [current] : [] };
    },
    onDidChange(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
  };
  const manager = new SourceServerConnectionManager({ directory, executeCommand });
  return {
    manager,
    profile,
    target: profile.target,
    retire() {
      current = undefined;
      for (const listener of listeners) listener({ generation: 2, profiles: [] });
    },
  };
}

test("same Source operation shares one flight and rejects opposite operations or new attachment", async () => {
  const pending = Promise.withResolvers();
  let calls = 0;
  const fixture = managerFixture(async () => {
    calls += 1;
    return pending.promise;
  });
  const first = fixture.manager.stopSource(fixture.profile, fixture.target);
  const second = fixture.manager.stopSource(fixture.profile, fixture.target);
  await assert.rejects(fixture.manager.restartSource(fixture.profile, fixture.target), {
    code: "source-server-lifecycle-busy",
  });
  await assert.rejects(fixture.manager.retain(fixture.profile, fixture.target), {
    code: "source-server-lifecycle-busy",
  });
  pending.resolve({ code: 0, stdout: "{}" });
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(fixture.manager.listStates()[0].state, "offline");
  await fixture.manager.dispose();
});

test("a retired Profile cannot publish late lifecycle success", async () => {
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const fixture = managerFixture(async () => {
    started.resolve();
    return pending.promise;
  });
  const operation = fixture.manager.stopSource(fixture.profile, fixture.target);
  await started.promise;
  fixture.retire();
  pending.resolve({ code: 0, stdout: "{}" });
  await assert.rejects(operation);
  assert.deepEqual(fixture.manager.listStates(), []);
  await fixture.manager.dispose();
});

test("running-task output is strict and unavailable is never an empty-task assertion", async () => {
  for (const [stdout, expected] of [
    ["[]", { available: true, tasks: [] }],
    ["null", { available: false }],
    ["not json", { available: false }],
    [
      JSON.stringify([{ sessionId: "one", workspacePath: "/fixture", secret: "unexpected" }]),
      { available: false },
    ],
  ]) {
    const fixture = managerFixture(async () => ({ code: 0, stdout }));
    assert.deepEqual(
      await fixture.manager.getRunningTasks(fixture.profile, fixture.target),
      expected,
    );
    await fixture.manager.dispose();
  }
});

test("stop cancels a running-task query and waits for its resource release before execution", async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const calls = [];
  let canceled = false;
  const fixture = managerFixture(async (_target, command, { signal }) => {
    calls.push(command);
    if (command === "running-tasks") {
      signal.addEventListener(
        "abort",
        () => {
          canceled = true;
        },
        { once: true },
      );
      started.resolve();
      await release.promise;
      signal.throwIfAborted();
    }
    return { code: 0, stdout: "[]" };
  });
  const query = fixture.manager.getRunningTasks(fixture.profile, fixture.target);
  const rejected = assert.rejects(query);
  await started.promise;
  const stop = fixture.manager.stopSource(fixture.profile, fixture.target);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(canceled, true);
  assert.deepEqual(calls, ["running-tasks"]);
  release.resolve();
  await Promise.all([rejected, stop]);
  assert.deepEqual(calls, ["running-tasks", "stop"]);
  await fixture.manager.dispose();
});

test("manager shutdown cancels and waits for query completion", async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let signal;
  const fixture = managerFixture(async (_target, _command, options) => {
    signal = options.signal;
    started.resolve();
    await release.promise;
    return { code: 0, stdout: "[]" };
  });
  const query = fixture.manager.getRunningTasks(fixture.profile, fixture.target);
  const rejected = assert.rejects(query);
  await started.promise;
  let closed = false;
  const closing = fixture.manager.dispose().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(closed, true);
});
