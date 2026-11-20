import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { PendingCommandRegistry } = await tsImport(
  "../../packages/ui/src/v4/pendingCommandRegistry.ts",
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../../packages/ui/tsconfig.json", import.meta.url)),
  },
);
function fixture() {
  let now = 1;
  const values = new Map();
  const registry = new PendingCommandRegistry({
    now: () => now,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  });
  const envelope = (commandId = "command-a") => ({
    commandId,
    clientId: "client-fixture",
    sessionId: "session-a",
    issuedAt: now,
    type: "sendText",
    payload: { text: "synthetic input" },
  });
  const record = (commandId) => {
    const command = envelope(commandId);
    registry.record(command, {
      workspace: { workspacePath: "fixture", workspaceIdentity: "scope-a" },
    });
    return command;
  };
  return {
    registry,
    record,
    values,
    advance: (delta) => {
      now += delta;
    },
  };
}
test("ACK before subscription synchronously resolves the late listener", () => {
  const { registry, record } = fixture();
  const command = record();
  registry.applyAck(command, { status: "accepted" });
  const received = [];
  registry.subscribeResolution(command.commandId, (value) => received.push(value));
  assert.deepEqual(received, ["accepted"]);
});
test("query failure and discarded input remain observable after the entry settles", () => {
  const { registry, record } = fixture();
  for (const [id, result, expected] of [
    ["failed-a", { status: "failed", reasonCode: "fixture.failed" }, "failed"],
    [
      "discard-a",
      {
        status: "failed",
        reasonCode: "fault.command.inputDiscardedOnRestart",
        result: { type: "inputDisposition", delivery: "queue" },
      },
      "discarded",
    ],
  ]) {
    const command = record(id);
    registry.applyQuery({ results: [{ key: command, result }] });
    const received = [];
    registry.subscribeResolution(id, (value) => received.push(value));
    assert.deepEqual(received, [expected]);
    assert.equal(registry.findCommand(id), undefined);
  }
});
test("foreign snapshot cannot create a notification; owning snapshot can precede subscription", () => {
  const { registry, record } = fixture();
  const command = record();
  const snapshot = {
    sessionId: "session-a",
    queue: { items: [] },
    rows: { window: [{ kind: "userInput", sourceCommandId: command.commandId }] },
  };
  registry.reconcileSnapshot(snapshot, "scope-b");
  const received = [];
  const cancel = registry.subscribeResolution(command.commandId, (value) => received.push(value));
  assert.deepEqual(received, []);
  cancel();
  registry.reconcileSnapshot(snapshot, "scope-a");
  assert.deepEqual(received, []);
  registry.subscribeResolution(command.commandId, (value) => received.push(value));
  assert.deepEqual(received, ["authoritative"]);
});
test("notification memory expires and never adds a persisted accepted queue", () => {
  const { registry, record, values, advance } = fixture();
  const command = record();
  registry.applyAck(command, { status: "failed" });
  assert.equal(values.size, 0);
  advance(5 * 60 * 1_000);
  const received = [];
  registry.subscribeResolution(command.commandId, (value) => received.push(value));
  assert.deepEqual(received, []);
});
test("bounded notifications evict oldest and new registration clears the previous generation", () => {
  const { registry, record } = fixture();
  for (let i = 0; i < 513; i++) registry.applyAck(record(`command-${i}`), { status: "failed" });
  const received = [];
  registry.subscribeResolution("command-0", (value) => received.push(value));
  assert.deepEqual(received, []);
  registry.subscribeResolution("command-512", (value) => received.push(value));
  assert.deepEqual(received, ["failed"]);
  record("command-512");
  registry.subscribeResolution("command-512", (value) => received.push(value));
  assert.deepEqual(received, ["failed"]);
});
