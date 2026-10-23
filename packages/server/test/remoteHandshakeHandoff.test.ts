import { EventEmitter, getEventListeners, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChannelServer,
  Emitter,
  ProxyChannel,
  SocketProtocol,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import { connectRemote, type RemoteConnection } from "../src/remote/connect.js";

const helloBytes = Buffer.from(
  `${JSON.stringify({
    type: "zcode-hello",
    version: "fixture版本",
    platform: "darwin",
    arch: "arm64",
    pid: 1,
  })}\n`,
);
const systemInfo = { homedir: "/fixture/remote", platform: "darwin" };
type InitializeTiming = "coalesced" | "synchronous" | "nextTick" | "setImmediate" | "none";

// 真实 stream 的 nextTick/data/EOF 和 RPC 响应先排空；不是请求重试或成功超时兜底。
const nodeTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
const observe = <T>(promise: Promise<T>) => Promise.race([promise, Promise.resolve("pending")]);

function fixture(
  timing: InitializeTiming,
  options: { fragmentedHello?: boolean; fragmentedInitialize?: boolean; sendHello?: boolean } = {},
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const close = new EventEmitter();
  const input = new Emitter<VSBuffer>();
  const stream: StdioStream = {
    stdin,
    stdout,
    stderr,
    onClose(listener) {
      close.on("command-close", listener);
      return { dispose: () => close.off("command-close", listener) };
    },
  };
  let ackBytes = Buffer.alloc(0);
  let ackCount = 0;
  let initializeCount = 0;
  let onAck = () => {};
  let resolveInitialize!: () => void;
  const initializeSent = new Promise<void>((resolve) => {
    resolveInitialize = resolve;
  });
  const reading = once(stdout, "resume");
  let initialFrame = true;
  const writeBytes = (bytes: Buffer) => {
    if (options.fragmentedInitialize) {
      for (const byte of bytes) stdout.write(Buffer.from([byte]));
    } else stdout.write(bytes);
  };
  const peerSocket: ISocket = {
    onData: input.event,
    onClose: () => ({ dispose() {} }),
    onEnd: () => ({ dispose() {} }),
    write(data) {
      const bytes = Buffer.from(data.buffer);
      if (stdout.writableEnded) return;
      if (initialFrame && timing === "coalesced") {
        initialFrame = false;
        const prefixLength = options.fragmentedInitialize ? 7 : bytes.length;
        stdout.write(Buffer.concat([helloBytes, bytes.subarray(0, prefixLength)]));
        if (prefixLength < bytes.length) {
          process.nextTick(() => writeBytes(bytes.subarray(prefixLength)));
        }
      } else {
        initialFrame = false;
        writeBytes(bytes);
      }
    },
    end() {},
    async drain() {},
    dispose() {},
  };
  const protocol = new SocketProtocol(peerSocket);
  const server = new ChannelServer(protocol, "fixture-peer", undefined, true);
  const info = vi.fn(async () => systemInfo);
  server.registerChannel(ServiceChannels.System, ProxyChannel.fromService({ info }));
  const initialize = () => {
    initializeCount++;
    server.ready();
    resolveInitialize();
  };
  stdin.on("data", (chunk: Buffer) => {
    if (ackCount > 0) {
      input.fire(VSBuffer.wrap(chunk));
      return;
    }
    ackBytes = Buffer.concat([ackBytes, chunk]);
    const newline = ackBytes.indexOf(0x0a);
    if (newline < 0) return;
    expect(JSON.parse(ackBytes.subarray(0, newline).toString("utf8"))).toMatchObject({
      type: "zcode-hello-ack",
      clientId: "fixture-client",
    });
    ackCount++;
    const remaining = ackBytes.subarray(newline + 1);
    ackBytes = Buffer.alloc(0);
    if (timing === "synchronous") initialize();
    else if (timing === "nextTick") process.nextTick(initialize);
    else if (timing === "setImmediate") setImmediate(initialize);
    onAck();
    if (remaining.length > 0) input.fire(VSBuffer.wrap(remaining));
  });
  const dispose = vi.fn();
  let finishBackend!: () => void;
  const backendFinished = new Promise<void>((resolve) => {
    finishBackend = resolve;
  });
  const disposeAndWait = vi.fn(() => backendFinished);
  const backend: IRemoteBackend = {
    async detect() {
      return { platform: "darwin", arch: "arm64" };
    },
    async exec() {
      if (options.sendHello !== false) {
        if (timing === "coalesced") initialize();
        else if (options.fragmentedHello) {
          for (const byte of Buffer.concat([Buffer.from("fixture banner\r\n"), helloBytes])) {
            stdout.write(Buffer.from([byte]));
          }
        } else stdout.write(helloBytes);
      }
      return stream;
    },
    async upload() {},
    async exists() {
      return true;
    },
    async readFile() {
      return "";
    },
    dispose,
    disposeAndWait,
  };
  return {
    stream,
    stdin,
    stdout,
    stderr,
    close,
    backend,
    reading,
    initializeSent,
    info,
    dispose,
    disposeAndWait,
    finishBackend,
    get ackCount() {
      return ackCount;
    },
    get initializeCount() {
      return initializeCount;
    },
    set onAck(callback: () => void) {
      onAck = callback;
    },
    closeCommand(code = 0) {
      close.emit("command-close", code);
    },
    cleanup() {
      finishBackend();
      close.emit("command-close", 0);
      server.dispose();
      protocol.dispose();
      input.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
      close.removeAllListeners();
    },
  };
}

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("real remote handshake to first business RPC handoff", () => {
  it.each<InitializeTiming>(["coalesced", "synchronous", "nextTick", "setImmediate"])(
    "%s Initialize answers the first public service call without a second Initialize",
    async (timing) => {
      const f = fixture(timing);
      let connection: RemoteConnection | undefined;
      try {
        connection = await connectRemote(f.backend, {
          skipDeploy: true,
          clientId: "fixture-client",
        });
        const firstCall = outcome(connection.services.systemService.info());
        await f.initializeSent;
        await nodeTurn();
        expect(await observe(firstCall)).toEqual({ value: systemInfo });
        expect(f.info).toHaveBeenCalledOnce();
        expect(f.ackCount).toBe(1);
        expect(f.initializeCount).toBe(1);
      } finally {
        connection?.dispose();
        f.cleanup();
      }
    },
  );

  it.each<InitializeTiming>(["coalesced", "synchronous", "nextTick", "setImmediate"])(
    "%s preserves fragmented UTF-8 hello and Initialize header/body",
    async (timing) => {
      const f = fixture(timing, { fragmentedHello: true, fragmentedInitialize: true });
      let connection: RemoteConnection | undefined;
      try {
        connection = await connectRemote(f.backend, {
          skipDeploy: true,
          clientId: "fixture-client",
        });
        const firstCall = outcome(connection.services.systemService.info());
        await f.initializeSent;
        await nodeTurn();
        expect(await observe(firstCall)).toEqual({ value: systemInfo });
        expect(f.info).toHaveBeenCalledOnce();
        expect(f.ackCount).toBe(1);
        expect(f.initializeCount).toBe(1);
      } finally {
        connection?.dispose();
        f.cleanup();
      }
    },
  );

  it.each(["end", "close", "error"])(
    "standalone stdout %s terminates a waiting first call without a command-close event",
    async (kind) => {
      const f = fixture("none");
      const otherData = vi.fn();
      const otherError = vi.fn();
      const closed = vi.fn();
      // 其他 owner 的 observer 不会接管数据，也必须在生产清理后保留。
      f.stdout.on("error", otherError);
      let connection: RemoteConnection | undefined;
      try {
        connection = await connectRemote(f.backend, {
          skipDeploy: true,
          clientId: "fixture-client",
          onDidRemoteClose: closed,
        });
        f.stdout.on("data", otherData);
        const firstCall = outcome(connection.services.systemService.info());
        if (kind === "end") f.stdout.end();
        else f.stdout.destroy(kind === "error" ? new Error("fixture stdout failure") : undefined);
        await nodeTurn();
        expect(await observe(firstCall)).toMatchObject({ error: { name: "ConnectionClosed" } });
        expect(closed).toHaveBeenCalledOnce();
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.stdout.listeners("data")).toEqual([otherData]);
        expect(f.stdout.listeners("error")).toEqual([otherError]);
        expect(f.stderr.listenerCount("data")).toBe(0);
        expect(f.close.listenerCount("command-close")).toBe(0);
        connection.dispose();
        expect(f.dispose).toHaveBeenCalledOnce();
      } finally {
        connection?.dispose();
        f.cleanup();
      }
    },
  );

  it.each(["empty", "coalesced", "fragmented"])(
    "ACK-reentrant stdout EOF with %s Initialize is observed by the installed RPC owner",
    async (shape) => {
      const timing =
        shape === "empty" ? "none" : shape === "coalesced" ? "coalesced" : "synchronous";
      const f = fixture(timing, { fragmentedInitialize: shape === "fragmented" });
      const closed = vi.fn();
      f.onAck = () => f.stdout.end();
      let connection: RemoteConnection | undefined;
      try {
        connection = await connectRemote(f.backend, {
          skipDeploy: true,
          clientId: "fixture-client",
          onDidRemoteClose: closed,
        });
        const firstCall = outcome(connection.services.systemService.info());
        await nodeTurn();
        const result = await observe(firstCall);
        expect(result !== "pending" && "error" in result).toBe(true);
        expect(closed).toHaveBeenCalledOnce();
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.stdout.listenerCount("data")).toBe(0);
        expect(f.stderr.listenerCount("data")).toBe(0);
        expect(f.close.listenerCount("command-close")).toBe(0);
      } finally {
        connection?.dispose();
        f.cleanup();
      }
    },
  );

  it("ACK callback nextTick stdout error has a continuous lifecycle observer across await handoff", async () => {
    const f = fixture("none");
    const otherError = vi.fn();
    f.stdout.on("error", otherError);
    const failure = new Error("fixture ACK-continuation error");
    const write = f.stdin.write.bind(f.stdin);
    vi.spyOn(f.stdin, "write").mockImplementation(((
      chunk: string | Uint8Array,
      callback: (error?: Error | null) => void,
    ) =>
      write(chunk, (error) => {
        callback(error);
        // callback 已 resolve 握手、清掉临时订阅；nextTick 仍先于 await continuation。
        process.nextTick(() => f.stdout.emit("error", failure));
      })) as typeof f.stdin.write);
    const connecting = outcome(
      connectRemote(f.backend, { skipDeploy: true, clientId: "fixture-client" }),
    );
    try {
      await nodeTurn();
      const result = await observe(connecting);
      if (result !== "pending" && "value" in result) result.value.dispose();
      expect(result !== "pending" && "error" in result).toBe(true);
      expect(otherError).toHaveBeenCalledOnce();
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.stdout.listeners("error")).toEqual([otherError]);
      expect(f.stdout.listenerCount("data")).toBe(0);
      expect(f.stderr.listenerCount("data")).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("stdout EOF before hello rejects and releases the actual handshake owner", async () => {
    const f = fixture("none", { sendHello: false });
    const connecting = outcome(
      connectRemote(f.backend, { skipDeploy: true, clientId: "fixture-client" }),
    );
    try {
      await f.reading;
      f.stdout.end();
      await nodeTurn();
      expect(await observe(connecting)).toMatchObject({ error: expect.any(Error) });
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.stdout.listenerCount("data")).toBe(0);
      expect(f.stderr.listenerCount("data")).toBe(0);
      expect(f.close.listenerCount("command-close")).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("command-close synchronously inside ACK rejects instead of publishing a dead connection", async () => {
    const f = fixture("none");
    f.onAck = () => f.closeCommand(17);
    const connecting = outcome(
      connectRemote(f.backend, { skipDeploy: true, clientId: "fixture-client" }),
    );
    try {
      await nodeTurn();
      const result = await observe(connecting);
      if (result !== "pending" && "value" in result) result.value.dispose();
      expect(result !== "pending" && "error" in result).toBe(true);
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.stdout.isPaused()).toBe(true);
      expect(f.stdout.listenerCount("data")).toBe(0);
      expect(f.stderr.listenerCount("data")).toBe(0);
      expect(f.close.listenerCount("command-close")).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it.each(["throw", "sync-callback", "async-callback"])(
    "ACK %s failure reaches connectRemote and retires its backend and diagnostic subscriptions",
    async (kind) => {
      const f = fixture("none");
      const failure = new Error("fixture connection ACK failure");
      const otherDiagnostic = vi.fn();
      f.stderr.on("data", otherDiagnostic);
      const stdin = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          if (kind === "async-callback") process.nextTick(() => callback(failure));
          else callback(failure);
        },
      });
      if (kind === "throw") {
        vi.spyOn(stdin, "write").mockImplementation(() => {
          throw failure;
        });
      }
      const errors: Error[] = [];
      stdin.on("error", (error: Error) => errors.push(error));
      f.stream.stdin = stdin;
      const connecting = outcome(
        connectRemote(f.backend, { skipDeploy: true, clientId: "fixture-client" }),
      );
      try {
        await nodeTurn();
        expect(await observe(connecting)).toEqual({ error: failure });
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.stdout.listenerCount("data")).toBe(0);
        expect(f.stdout.listenerCount("error")).toBe(0);
        expect(f.stderr.listeners("data")).toEqual([otherDiagnostic]);
        expect(f.close.listenerCount("command-close")).toBe(0);
        expect(stdin.listenerCount("error")).toBe(1);
        expect(errors).toEqual(kind === "throw" ? [] : [failure]);
        expect(f.stdout.isPaused()).toBe(true);
      } finally {
        stdin.destroy();
        f.cleanup();
      }
    },
  );

  it("synchronous close during handoff subscription releases every returned handle", async () => {
    const f = fixture("none");
    const releases: ReturnType<typeof vi.fn>[] = [];
    f.stream.onClose = (listener) => {
      const dispose = vi.fn();
      releases.push(dispose);
      if (f.ackCount > 0) listener(17);
      return { dispose };
    };
    const connecting = outcome(
      connectRemote(f.backend, { skipDeploy: true, clientId: "fixture-client" }),
    );
    try {
      await nodeTurn();
      const result = await observe(connecting);
      if (result !== "pending" && "value" in result) result.value.dispose();
      expect(result !== "pending" && "error" in result).toBe(true);
      for (const dispose of releases) expect(dispose).toHaveBeenCalledOnce();
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.stdout.listenerCount("data")).toBe(0);
      expect(f.stderr.listenerCount("data")).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it.each(["before-hello", "inside-ACK", "during-resume"])(
    "%s abort cleans listeners immediately and never double-disposes or revives the backend",
    async (stage) => {
      const f = fixture("synchronous", { sendHello: stage !== "before-hello" });
      const controller = new AbortController();
      const failure = new Error("fixture canceled");
      if (stage === "inside-ACK") f.onAck = () => controller.abort(failure);
      if (stage === "during-resume") {
        const resume = f.stdout.resume.bind(f.stdout);
        vi.spyOn(f.stdout, "resume").mockImplementation(() => {
          if (f.ackCount > 0) controller.abort(failure);
          return resume();
        });
      }
      const connecting = outcome(
        connectRemote(f.backend, {
          skipDeploy: true,
          clientId: "fixture-client",
          signal: controller.signal,
        }),
      );
      try {
        if (stage === "before-hello") {
          await f.reading;
          controller.abort(failure);
        }
        await nodeTurn();
        expect(await observe(connecting)).toEqual({ error: failure });
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.stdout.listenerCount("data")).toBe(0);
        expect(f.stderr.listenerCount("data")).toBe(0);
        expect(f.close.listenerCount("command-close")).toBe(0);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        if (stage !== "before-hello") expect(f.stdout.isPaused()).toBe(true);
        f.stdout.write(helloBytes);
        f.closeCommand(0);
        await nodeTurn();
        expect(f.dispose).toHaveBeenCalledOnce();
        expect(f.info).not.toHaveBeenCalled();
        expect(f.stdout.listenerCount("data")).toBe(0);
      } finally {
        f.cleanup();
      }
    },
  );

  it("resume reentry close cannot activate or publish a released RPC owner", async () => {
    const f = fixture("synchronous");
    const resume = f.stdout.resume.bind(f.stdout);
    vi.spyOn(f.stdout, "resume").mockImplementation(() => {
      if (f.ackCount > 0) f.closeCommand(17);
      return resume();
    });
    const connecting = outcome(
      connectRemote(f.backend, { skipDeploy: true, clientId: "fixture-client" }),
    );
    try {
      await nodeTurn();
      const result = await observe(connecting);
      if (result !== "pending" && "value" in result) result.value.dispose();
      expect(result !== "pending" && "error" in result).toBe(true);
      expect(f.dispose).toHaveBeenCalledOnce();
      expect(f.stdout.isPaused()).toBe(true);
      expect(f.stdout.listenerCount("data")).toBe(0);
      expect(f.stderr.listenerCount("data")).toBe(0);
      expect(f.info).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it("synchronous command-close inside stdin.end still awaits backend.disposeAndWait", async () => {
    const f = fixture("nextTick");
    let connection: RemoteConnection | undefined;
    let disposing: Promise<void> | undefined;
    let settled = false;
    try {
      connection = await connectRemote(f.backend, { skipDeploy: true, clientId: "fixture-client" });
      const end = f.stdin.end.bind(f.stdin);
      vi.spyOn(f.stdin, "end").mockImplementation((...args: Parameters<typeof end>) => {
        f.closeCommand(0);
        return end(...args);
      });
      disposing = connection.disposeAndWait().then(() => {
        settled = true;
      });
      await nodeTurn();
      expect(f.disposeAndWait).toHaveBeenCalledOnce();
      expect(f.dispose).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      f.finishBackend();
      await disposing;
      expect(settled).toBe(true);
      connection.dispose();
      expect(f.dispose).not.toHaveBeenCalled();
    } finally {
      f.finishBackend();
      f.closeCommand(0);
      await disposing;
      connection?.dispose();
      f.cleanup();
    }
  });

  it("real handshake disposal still awaits backend cleanup after standalone stdout EOF", async () => {
    const f = fixture("nextTick");
    let connection: RemoteConnection | undefined;
    let disposing: Promise<void> | undefined;
    let settled = false;
    try {
      connection = await connectRemote(f.backend, { skipDeploy: true, clientId: "fixture-client" });
      disposing = connection.disposeAndWait().then(() => {
        settled = true;
      });
      f.stdout.end();
      await nodeTurn();
      expect(f.disposeAndWait).toHaveBeenCalledOnce();
      expect(f.dispose).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      f.finishBackend();
      await disposing;
      expect(settled).toBe(true);
      expect(f.stderr.listenerCount("data")).toBe(0);
      connection.dispose();
      expect(f.dispose).not.toHaveBeenCalled();
    } finally {
      f.finishBackend();
      f.closeCommand(0);
      await disposing;
      connection?.dispose();
      f.cleanup();
    }
  });
});
