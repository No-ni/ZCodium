import { Duplex, Readable, Writable } from "node:stream";
import { ZCODE_USER_DATA_DIR_NAME, type RemoteTarget } from "@zcode/shared";
import { createRemoteBackend } from "../remote/create-backend.js";
import { assertSupportedRemoteEnvironment } from "../remote/remotePlatformSupport.js";
import { SourceServerTransportError, type SourceServerTransport } from "./contract.js";
import type { IRemoteBackend, StdioStream } from "../remote/backend.js";

export const SOURCE_SERVER_ROOT = `~/${ZCODE_USER_DATA_DIR_NAME}/server`;
const ROOT_SHELL = `"$HOME/${ZCODE_USER_DATA_DIR_NAME}/server"`;
const BIN_SHELL = `${ROOT_SHELL}/bin/zcode`;

async function collect(
  stream: StdioStream,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let finished = false;
    const cleanup = () => {
      subscription.dispose();
      signal?.removeEventListener("abort", abort);
      stream.stdout.off("data", data);
      stream.stdout.off("error", fail);
      stream.stderr.off("data", discard);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const data = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 65_536) fail(new Error("Source probe exceeded response limit"));
    };
    const discard = () => undefined;
    const abort = () => fail(new Error("Source connection canceled"));
    const subscription = stream.onClose((code) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({ code, stdout });
    });
    stream.stdout.on("data", data);
    stream.stdout.once("error", fail);
    stream.stderr.on("data", discard);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function connectSourceServerTransport(
  target: RemoteTarget,
  options: {
    signal?: AbortSignal;
    createBackend?: (target: RemoteTarget) => Promise<IRemoteBackend>;
  } = {},
): Promise<SourceServerTransport> {
  options.signal?.throwIfAborted();
  const backend = await (options.createBackend ?? createRemoteBackend)(target);
  let disposed = false;
  const channels = new Set<Duplex>();
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const channel of channels) channel.destroy();
    channels.clear();
    if (backend.disposeAndWait) await backend.disposeAndWait();
    else backend.dispose();
  };
  const cancel = () => {
    void dispose();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const environment = await backend.detect();
    options.signal?.throwIfAborted();
    assertSupportedRemoteEnvironment(environment);
    if (!(await backend.exists(`${SOURCE_SERVER_ROOT}/bin/zcode`)))
      throw new SourceServerTransportError("source-server-install-required");
    const statusResult = await collect(
      await backend.exec(`${BIN_SHELL} status --server-root ${ROOT_SHELL} --json`),
      options.signal,
    );
    options.signal?.throwIfAborted();
    const lastLine = statusResult.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    const status = JSON.parse(lastLine) as { state?: unknown; port?: unknown };
    if (
      statusResult.code !== 0 ||
      status.state !== "ready" ||
      !Number.isInteger(status.port) ||
      Number(status.port) < 1 ||
      Number(status.port) > 65_535
    )
      throw new SourceServerTransportError("source-server-start-required");
    const ingressToken = (await backend.readFile(`${SOURCE_SERVER_ROOT}/run/ingress-token`)).trim();
    if (!/^[a-f0-9]{64}$/.test(ingressToken))
      throw new SourceServerTransportError("source-server-connection-failed");
    options.signal?.throwIfAborted();
    // 准备信号的所有权到此结束，发布后的物理连接只能由 Source manager 关闭。
    options.signal?.removeEventListener("abort", cancel);
    return {
      backend,
      ingressToken,
      async openChannel() {
        if (disposed) throw new Error("Source transport was released");
        const stream = await backend.exec(
          `${BIN_SHELL} server proxy-stdio --server-root ${ROOT_SHELL}`,
        );
        if (disposed) {
          stream.stdin.end();
          throw new Error("Source connection canceled");
        }
        const channel = Duplex.fromWeb({
          readable: Readable.toWeb(stream.stdout as Readable),
          writable: Writable.toWeb(stream.stdin as Writable),
        });
        const subscription = stream.onClose(() => channel.destroy());
        const discard = () => undefined;
        stream.stderr.on("data", discard);
        channels.add(channel);
        channel.once("close", () => {
          channels.delete(channel);
          subscription.dispose();
          stream.stderr.off("data", discard);
        });
        return channel;
      },
      async dispose() {
        options.signal?.removeEventListener("abort", cancel);
        await dispose();
      },
    };
  } catch (error) {
    options.signal?.removeEventListener("abort", cancel);
    await dispose();
    throw error;
  }
}
