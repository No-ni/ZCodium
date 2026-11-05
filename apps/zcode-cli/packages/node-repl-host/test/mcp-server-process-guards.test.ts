import { EventEmitter } from "node:events";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
  installNodeReplProcessGuards,
  installNodeReplShutdownTriggers,
  createNodeReplMcpRuntime,
} from "../src/server.js";

describe("node_repl queued call lifecycle", () => {
  it("does not execute a request cancelled while waiting in the queue", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const executeJs = vi.fn(async () => {
      started.resolve();
      await finish.promise;
      return { logs: "", result: "done" };
    });
    const runtime = createNodeReplMcpRuntime({ executeJs });
    const client = new Client({ name: "queued-cancel-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
    const input = { name: "js", arguments: { code: "1" } };
    try {
      const first = client.callTool(input);
      await started.promise;
      const controller = new AbortController();
      const queued = client.callTool(input, { signal: controller.signal });
      const outcomes = Promise.allSettled([first, queued]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort(new Error("fixture request cancelled"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      finish.resolve();
      await outcomes;
      // 服务器端的取消通知与排队收尾均在这轮 microtask 完成，不以超时猜测完成。
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(executeJs).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve();
      runtime.dispose();
      await client.close();
    }
  });

  it("does not execute a queued call after runtime disposal", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const executeJs = vi.fn(async () => {
      started.resolve();
      await finish.promise;
      return { logs: "", result: "done" };
    });
    const runtime = createNodeReplMcpRuntime({ executeJs });
    const client = new Client({ name: "queued-lifecycle-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
    const input = { name: "js", arguments: { code: "1" } };
    try {
      const first = client.callTool(input);
      await started.promise;
      const queued = client.callTool(input);
      const outcomes = Promise.allSettled([first, queued]);
      // transport 在 microtask 中分发；一个事件循环边界确保第二条已持有队列等待。
      await new Promise<void>((resolve) => setImmediate(resolve));
      runtime.dispose();
      finish.resolve();
      const [, second] = await outcomes;
      expect(second).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: expect.stringContaining("disposed") }),
      });
      expect(executeJs).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve();
      runtime.dispose();
      await client.close();
    }
  });
});

function createFakeProcess() {
  const emitter = new EventEmitter();
  return {
    emitter,
    on: emitter.on.bind(emitter) as NodeJS.Process["on"],
    once: emitter.once.bind(emitter) as NodeJS.Process["once"],
  };
}

describe("node_repl MCP server process guards", () => {
  it("logs unhandled rejections to stderr instead of letting the process die", () => {
    const fake = createFakeProcess();
    const stderrLines: string[] = [];
    installNodeReplProcessGuards({
      onOutputClosed: vi.fn(),
      process: fake,
      writeStderr: (text) => stderrLines.push(text),
    });

    fake.emitter.emit("unhandledRejection", new Error("boom from stale cell promise"));

    expect(stderrLines.join("")).toContain("unhandledRejection");
    expect(stderrLines.join("")).not.toContain("boom from stale cell promise");
  });

  it("logs uncaught exceptions to stderr instead of letting the process die", () => {
    const fake = createFakeProcess();
    const stderrLines: string[] = [];
    installNodeReplProcessGuards({
      onOutputClosed: vi.fn(),
      process: fake,
      writeStderr: (text) => stderrLines.push(text),
    });

    fake.emitter.emit("uncaughtException", new Error("boom from async timer"));

    expect(stderrLines.join("")).toContain("uncaughtException");
    expect(stderrLines.join("")).not.toContain("boom from async timer");
  });

  it("keeps handler installation idempotent so repeated main() bootstraps do not stack listeners", () => {
    const fake = createFakeProcess();
    const stderrLines: string[] = [];
    const options = {
      onOutputClosed: vi.fn(),
      process: fake,
      writeStderr: (text: string) => stderrLines.push(text),
    };
    installNodeReplProcessGuards(options);
    installNodeReplProcessGuards(options);

    fake.emitter.emit("unhandledRejection", new Error("once"));

    expect(stderrLines).toHaveLength(1);
  });

  it("redacts non-Error rejection reasons", () => {
    const fake = createFakeProcess();
    const stderrLines: string[] = [];
    installNodeReplProcessGuards({
      onOutputClosed: vi.fn(),
      process: fake,
      writeStderr: (text) => stderrLines.push(text),
    });

    fake.emitter.emit("unhandledRejection", "plain string reason");

    expect(stderrLines.join("")).toContain("unhandledRejection");
    expect(stderrLines.join("")).not.toContain("plain string reason");
  });

  it("does not expose error content, paths or credentials in direct stderr diagnostics", () => {
    const fake = createFakeProcess();
    const stderrLines: string[] = [];
    installNodeReplProcessGuards({
      onOutputClosed: vi.fn(),
      process: fake,
      writeStderr: (text) => stderrLines.push(text),
    });
    const secret = "fixture-key-do-not-log";
    const privatePath = "C:/fictional-user/private.txt";
    const content = "fixture-user-message";
    const error = new Error(`${secret} ${privatePath} ${content}`);
    error.stack = `${error.message}\n at fixture (${privatePath}:1:1)`;
    fake.emitter.emit("unhandledRejection", error);
    for (const value of [secret, privatePath, content])
      expect(stderrLines.join("")).not.toContain(value);
    expect(stderrLines.join("")).toContain("unhandledRejection");
  });

  it.each(["EPIPE", "EIO", "ENXIO", "EBADF", "ERR_STREAM_DESTROYED"])(
    "treats %s as a terminal output closure without writing to the broken stderr again",
    (code) => {
      const fake = createFakeProcess();
      const stderrLines: string[] = [];
      const onOutputClosed = vi.fn();
      installNodeReplProcessGuards({
        onOutputClosed,
        process: fake,
        writeStderr: (text) => stderrLines.push(text),
      });
      const error = Object.assign(new Error(`write ${code}`), { code });

      fake.emitter.emit("uncaughtException", error);
      fake.emitter.emit("uncaughtException", error);

      expect(onOutputClosed).toHaveBeenCalledOnce();
      expect(onOutputClosed).toHaveBeenCalledWith(error);
      expect(stderrLines).toEqual([]);
    },
  );

  it("stops reporting queued errors after the output has closed", () => {
    const fake = createFakeProcess();
    const stderrLines: string[] = [];
    installNodeReplProcessGuards({
      onOutputClosed: vi.fn(),
      process: fake,
      writeStderr: (text) => stderrLines.push(text),
    });

    fake.emitter.emit(
      "uncaughtException",
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    );
    fake.emitter.emit("unhandledRejection", new Error("already queued"));

    expect(stderrLines).toEqual([]);
  });

  it("treats a synchronous EPIPE from the diagnostic write as output closure", () => {
    const fake = createFakeProcess();
    const onOutputClosed = vi.fn();
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    installNodeReplProcessGuards({
      onOutputClosed,
      process: fake,
      writeStderr: () => {
        throw error;
      },
    });

    fake.emitter.emit("uncaughtException", new Error("original async failure"));

    expect(onOutputClosed).toHaveBeenCalledOnce();
    expect(onOutputClosed).toHaveBeenCalledWith(error);
  });
});

describe("node_repl MCP server shutdown triggers", () => {
  it.each(["end", "close"] as const)("shuts down when stdin emits %s", (event) => {
    const fakeProcess = createFakeProcess();
    const stdin = new EventEmitter();
    const shutdown = vi.fn();
    installNodeReplShutdownTriggers({
      process: fakeProcess,
      shutdown,
      stdin: {
        once: stdin.once.bind(stdin) as NodeJS.ReadStream["once"],
      },
    });

    stdin.emit(event);

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("coalesces stdin closure and process signals into one shutdown", () => {
    const fakeProcess = createFakeProcess();
    const stdin = new EventEmitter();
    const shutdown = vi.fn();
    installNodeReplShutdownTriggers({
      process: fakeProcess,
      shutdown,
      stdin: {
        once: stdin.once.bind(stdin) as NodeJS.ReadStream["once"],
      },
    });

    stdin.emit("end");
    stdin.emit("close");
    fakeProcess.emitter.emit("SIGTERM");
    fakeProcess.emitter.emit("SIGINT");

    expect(shutdown).toHaveBeenCalledOnce();
  });
});
