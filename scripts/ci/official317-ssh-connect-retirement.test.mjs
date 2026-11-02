import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function fixture() {
  const source = await readFile(
    new URL("../../packages/server/src/remote/ssh-backend.ts", import.meta.url),
    "utf8",
  );
  const file = ts.createSourceFile("ssh-backend.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "SSHBackend",
  );
  assert.ok(declaration);
  const code = ts.transpileModule(
    declaration.getText(file).replace(/^export\s+/, "") + "\nreturn SSHBackend;",
    {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    },
  ).outputText;
  const clients = [];
  class Client extends EventEmitter {
    constructor() {
      super();
      clients.push(this);
    }
    connect(config) {
      this.config = config;
      this.attempts = (this.attempts ?? 0) + 1;
    }
    end() {
      this.ends = (this.ends ?? 0) + 1;
    }
  }
  class Emitter {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  }
  const Backend = new Function(
    "SSHClient",
    "Emitter",
    "buildSSHConnectConfig",
    "resolveZCodeRuntimeEnv",
    "createSSHHostVerifier",
    "SSHHostKeyStore",
    "normalizeSSHConnectError",
    "console",
    "safeLogArgs",
    code,
  )(
    Client,
    Emitter,
    (value) => value,
    () => "production",
    (options) => options.isActive,
    class {},
    (error) => (error instanceof Error ? error : new Error("fixture")),
    { error() {} },
    () => [],
  );
  return { backend: new Backend({ host: "fixture.invalid", username: "fixture" }), clients };
}

test("dispose immediately settles the one shared handshake without socket events", async () => {
  const { backend, clients } = await fixture();
  const first = backend.ensureConnected();
  const second = backend.ensureConnected();
  let firstFailure, secondFailure;
  first.catch((error) => {
    firstFailure = error;
  });
  second.catch((error) => {
    secondFailure = error;
  });
  assert.equal(clients[0].attempts, 1);
  backend.dispose();
  // Promise settlement only; no timer, network, or synthetic close event.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.match(firstFailure?.message ?? "", /已释放/);
  assert.equal(secondFailure, firstFailure);
  assert.equal(clients[0].listenerCount("ready"), 0);
  clients[0].emit("ready");
  clients[0].emit("error", new Error("late socket error"));
  assert.equal(backend.connected, false);
  backend.dispose();
  assert.equal(clients[0].ends, 1);
  await assert.rejects(backend.ensureConnected(), /已释放/);
  assert.equal(clients[0].attempts, 1);
});

test("a failed attempt retires its cancel callback before a new handshake", async () => {
  const { backend, clients } = await fixture();
  const first = backend.ensureConnected();
  clients[0].emit("error", new Error("handshake failed"));
  await assert.rejects(first, /handshake failed/);
  const second = backend.ensureConnected();
  assert.equal(clients.length, 2);
  clients[0].emit("ready");
  clients[0].emit("close");
  assert.equal(backend.connected, false);
  clients[1].emit("ready");
  await second;
  assert.equal(backend.connected, true);
  assert.equal(backend.failPendingConnect, undefined);
  backend.dispose();
});
