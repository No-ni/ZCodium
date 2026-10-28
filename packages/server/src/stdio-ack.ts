import type { Readable } from "node:stream";
import { formatZodError, helloAckMessageSchema, type HelloAckMessage } from "@zcode/shared";

export function waitForStdioAck(stdin: Readable): Promise<HelloAckMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      stdin.removeListener("error", onError);
      buffer = Buffer.alloc(0);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onEnd = () => fail(new Error("stdin closed before hello-ack received"));
    const onError = (error: Error) => fail(error);
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
      buffer = Buffer.concat([buffer, bytes]);
      const newlineIdx = buffer.indexOf(0x0a);
      if (newlineIdx === -1) return;
      try {
        // ACK 是文本，但粘在它后面的 RPC 是二进制；整块 UTF-8 往返会把帧长字节改成替代字符。
        const line = buffer.subarray(0, newlineIdx).toString("utf-8").trim();
        const result = helloAckMessageSchema.safeParse(JSON.parse(line));
        if (!result.success) {
          fail(new Error(`Invalid hello-ack: ${formatZodError(result.error)}`));
          return;
        }
        // 先暂停输入，RPC reader 注册并接管后才恢复，避免 await 初始化期间后续字节无人消费。
        stdin.pause();
        if (settled) return;
        const remaining = buffer.subarray(newlineIdx + 1);
        if (remaining.length > 0) stdin.unshift(remaining);
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result.data);
      } catch (err) {
        fail(new Error(`Failed to parse hello-ack: ${err}`));
      }
    };

    timeout = setTimeout(() => {
      fail(new Error("Handshake timeout: no hello-ack received within 10s"));
    }, 10_000);
    stdin.on("error", onError);
    if (!settled) stdin.on("end", onEnd);
    if (!settled) stdin.on("close", onEnd);
    if (!settled) stdin.on("data", onData);
    // 注册期间也可能同步结束；补清理刚返回的订阅，且不删除其他 owner 的监听器。
    if (settled) cleanup();
    else if (stdin.errored) onError(stdin.errored);
    else if (stdin.readableEnded || stdin.destroyed) onEnd();
  });
}
