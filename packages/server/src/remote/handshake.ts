import type { HelloMessage, HelloAckMessage } from "@zcode/shared";
import { ZCODE_VERSION, formatZodError, helloMessageSchema } from "@zcode/shared";
import type { StdioStream } from "./backend.js";
import type { IDisposable } from "@zcode/rpc";

const MAX_HANDSHAKE_DIAGNOSTIC_CHARS = 2048;

export interface HandshakeResult {
  hello: HelloMessage;
  /** Raw bytes already read after hello; stdout stays paused until the RPC owner resumes it. */
  remaining: Buffer | null;
}

/**
 * Perform the client-side handshake:
 * 1. Read lines from stdout until we find a zcode-hello JSON
 *    (skip SSH banner/motd lines)
 * 2. Pause stdout at the validated hello boundary and send a zcode-hello-ack to stdin
 * 3. After the ACK write callback succeeds, return hello and raw remaining data (still paused)
 */
export function performHandshake(
  stream: StdioStream,
  clientId: string,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let stdoutText = "";
    let stderrText = "";
    let settled = false;
    let closeDisposable: IDisposable | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let pendingWriteError = false;
    const stdin = stream.stdin as NodeJS.WritableStream & { destroyed?: boolean; closed?: boolean };
    const stdout = stream.stdout as NodeJS.ReadableStream & {
      destroyed?: boolean;
      readableEnded?: boolean;
      errored?: Error | null;
    };

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      stdout.removeListener("data", onData);
      stdout.removeListener("end", onStdoutEnd);
      stdout.removeListener("close", onStdoutEnd);
      stdout.removeListener("error", onStdoutError);
      stream.stderr.removeListener("data", onStderrData);
      // Node Writable 先调用失败 callback，再发布 error；该配对事件仍归原握手 owner，
      // 不能在 callback 中提前解绑而制造 unhandled error，也不引入延时清理或第二个 owner。
      if (!pendingWriteError || stdin.closed) {
        pendingWriteError = false;
        stdin.removeListener("error", onStdinError);
        stdin.removeListener("close", onStdinClose);
      }
      signal?.removeEventListener("abort", onAbort);
      const subscription = closeDisposable;
      closeDisposable = undefined;
      subscription?.dispose();
      buffer = Buffer.alloc(0);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const rejectWithDiagnostics = (message: string, exitCode?: number) => {
      if (settled) return;
      fail(
        new Error(
          formatHandshakeFailure(message, {
            exitCode,
            stdout: appendLimited(stdoutText, buffer.toString("utf-8")),
            stderr: stderrText,
          }),
        ),
      );
    };
    const onStdoutEnd = () => rejectWithDiagnostics("Stream closed before handshake completed");
    const onStdoutError = (error: Error) => fail(error);
    const onStdinError = (error: Error) => {
      pendingWriteError = false;
      if (settled) cleanup();
      else fail(error);
    };
    const onStdinClose = () => {
      pendingWriteError = false;
      if (settled) cleanup();
      else rejectWithDiagnostics("Stream closed before handshake completed");
    };
    const onAbort = () => {
      const error =
        signal?.reason instanceof Error ? signal.reason : new Error("Remote connection canceled");
      if (!(signal?.reason instanceof Error)) error.name = "AbortError";
      fail(error);
    };
    const checkStdout = () => {
      if (stdout.errored) onStdoutError(stdout.errored);
      else if (stdout.destroyed || stdout.readableEnded) onStdoutEnd();
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      // hello 后可能粘着 RPC 二进制帧；整块转 UTF-8 会把非法字节替换并破坏帧头。
      // 完整行才解码，同时避免多字节字符跨 chunk 时被替换。
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const newlineIdx = buffer.indexOf(0x0a);
        if (newlineIdx === -1) break;
        const line = buffer.subarray(0, newlineIdx).toString("utf-8").trim();
        buffer = buffer.subarray(newlineIdx + 1);
        stdoutText = appendLimited(stdoutText, `${line}\n`);
        if (!line.startsWith("{")) continue;
        let rawValue: unknown;
        try {
          rawValue = JSON.parse(line);
        } catch {
          // Not JSON, skip (SSH banner line)
          continue;
        }
        const result = helloMessageSchema.safeParse(rawValue);
        if (result.success) {
          // 删除最后一个 data listener 不会暂停 flowing Readable；ACK 的同步/nextTick
          // Initialize 会在 await 接管前被丢弃。先 pause，raw remaining 只交给 RPC 一次。
          stdout.pause();
          if (settled) return;
          stdout.removeListener("data", onData);
          const ack: HelloAckMessage = {
            type: "zcode-hello-ack",
            version: ZCODE_VERSION,
            clientId,
          };
          let writing = true;
          let acknowledged = false;
          const complete = () => {
            if (settled || writing || !acknowledged) return;
            checkStdout();
            if (settled) return;
            settled = true;
            const remaining = buffer.length > 0 ? buffer : null;
            cleanup();
            resolve({ hello: result.data as HelloMessage, remaining });
          };
          const stdinWasDestroyed = stdin.destroyed;
          try {
            stdin.write(JSON.stringify(ack) + "\n", (error?: Error | null) => {
              if (error) {
                // 已 destroyed 或先 close 后 callback 的 Writable 不再发 error；
                // 以公开 closed 终态释放配对观察，不能迟到重挂永久 listener。
                pendingWriteError = !stdinWasDestroyed && !stdin.closed;
                if (pendingWriteError) {
                  // 正常失败 callback 后 Node 才发布 error；取消已清理时也由同一
                  // ACK owner 临时接住配对事件，不恢复 reader 或 timer。
                  if (settled) {
                    stdin.on("error", onStdinError);
                    stdin.on("close", onStdinClose);
                  }
                }
                if (settled) cleanup();
                else fail(error);
                return;
              }
              if (settled) {
                cleanup();
                return;
              }
              acknowledged = true;
              complete();
            });
          } catch (error) {
            fail(error);
          }
          // write / callback 都是外部重入边界；同步 callback 后 write 尚未返回时，
          // close/abort 仍可拒绝，不能提前完成握手或让迟到 callback 复活它。
          writing = false;
          complete();
          return;
        }
        if (
          rawValue &&
          typeof rawValue === "object" &&
          "type" in rawValue &&
          (rawValue as { type?: unknown }).type === "zcode-hello"
        ) {
          rejectWithDiagnostics(`Invalid zcode-hello: ${formatZodError(result.error)}`);
          return;
        }
      }
    };
    const onStderrData = (chunk: Buffer) => {
      if (!settled) stderrText = appendLimited(stderrText, chunk.toString("utf-8"));
    };

    timeout = setTimeout(() => {
      rejectWithDiagnostics("Handshake timeout: no zcode-hello received within timeout");
    }, timeoutMs);
    try {
      stream.stdin.on("error", onStdinError);
      // stdin 可独立关闭且 ACK callback 仍未归还，必须立即拒绝，不能等命令关闭或超时。
      if (!settled) stdin.on("close", onStdinClose);
      if (!settled) stdout.on("error", onStdoutError);
      if (!settled) stdout.on("end", onStdoutEnd);
      if (!settled) stdout.on("close", onStdoutEnd);
      if (!settled) stream.stderr.on("data", onStderrData);
      if (!settled && signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      if (!settled) {
        closeDisposable = stream.onClose((code) => {
          rejectWithDiagnostics("Stream closed before handshake completed", code);
        });
      }
      if (!settled) checkStdout();
      if (!settled) stdout.on("data", onData);
      // 注册时同步补发或同步收到 hello，迟到归还的句柄也归同一 cleanup。
      if (settled) cleanup();
    } catch (error) {
      fail(error);
      cleanup();
    }
  });
}

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= MAX_HANDSHAKE_DIAGNOSTIC_CHARS) {
    return combined;
  }
  return combined.slice(combined.length - MAX_HANDSHAKE_DIAGNOSTIC_CHARS);
}

function formatHandshakeFailure(
  message: string,
  diagnostics: {
    exitCode?: number;
    stdout: string;
    stderr: string;
  },
): string {
  const parts = [message];
  if (diagnostics.exitCode !== undefined) {
    parts.push(`exit code ${diagnostics.exitCode}`);
  }
  const stderr = diagnostics.stderr.trim();
  if (stderr.length > 0) {
    parts.push(`stderr: ${JSON.stringify(stderr)}`);
  }
  const stdout = diagnostics.stdout.trim();
  if (stdout.length > 0) {
    // 远端 server 在 hello 前退出时，真正原因只存在 stdout/stderr。
    // 如果错误只保留“握手关闭”，SSH 启动失败会在 host/main 日志中被压成无上下文的 {}。
    parts.push(`stdout: ${JSON.stringify(stdout)}`);
  }
  return parts.length === 1 ? message : `${message} (${parts.slice(1).join("; ")})`;
}
