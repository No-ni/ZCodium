import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("transport listener releases its first consumer but still closes late ports", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const code = `
    import assert from "node:assert/strict";
    import { EventEmitter } from "node:events";
    import { setImmediate } from "node:timers/promises";
    import { subscribeBotRemoteWorkspaceResponses } from "./packages/services/src/bots/botRemoteWorkspaceMessages.ts";
    const port = Object.assign(new EventEmitter(), { postMessage() {} });
    function register() {
      const responses = {
        pending: new Map(), pendingRuntimePorts: new Map(),
        pendingConnectionStatus: new Map(), receivedRuntimePorts: new Set(),
      };
      const reference = new WeakRef(responses);
      subscribeBotRemoteWorkspaceResponses(port, responses)();
      return reference;
    }
    const references = Array.from({ length: 100 }, register);
    // 跨事件轮次释放 WeakRef 的当轮保活；GC 只用于隔离回收验证，不参与生产时序。
    for (let i = 0; i < 8; i++) { await setImmediate(); global.gc(); }
    assert.equal(references.filter((ref) => ref.deref() !== undefined).length, 0);
    assert.equal(port.listenerCount("message"), 1);
    let closed = 0;
    port.emit("message", {
      data: { type: "bot-remote-workspace-runtime-port", requestId: "late", ok: true },
      ports: [{ close() { closed++; } }],
    });
    assert.equal(closed, 1);
  `;
  const { stderr } = await promisify(execFile)(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "--input-type=module", "--eval", code],
    { cwd: root, timeout: 15_000 },
  );
  assert.equal(stderr, "");
});
