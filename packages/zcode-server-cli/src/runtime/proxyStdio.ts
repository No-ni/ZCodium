import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import { readPersistedStatus } from "./statusSnapshot.js";
import type { ServerLayout } from "./paths.js";

export async function proxyServerStdio(
  layout: ServerLayout,
  input: Readable,
  output: Writable,
): Promise<void> {
  const status = await readPersistedStatus(layout);
  if (status?.state !== "ready" || !status.port || status.host !== "127.0.0.1")
    throw new Error("Source Server must be manually started before proxy-stdio");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: status.port! });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.unpipe(socket);
      socket.unpipe(output);
      input.off("error", fail);
      output.off("error", fail);
      input.off("close", close);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const fail = (error: Error) => finish(error);
    const close = () => finish();
    input.once("error", fail);
    output.once("error", fail);
    input.once("close", close);
    socket.once("error", fail);
    socket.once("close", close);
    socket.once("connect", () => {
      // stdin EOF 只结束当前隧道，不能向 Supervisor 发送 stop 或取消远端任务。
      input.pipe(socket);
      socket.pipe(output, { end: false });
    });
  });
}
