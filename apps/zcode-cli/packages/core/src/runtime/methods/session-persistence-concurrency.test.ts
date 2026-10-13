import { expect, it, vi } from "vitest";
import { ensureSessionPersisted } from "./events.js";
import type { AgentRuntimeInternal } from "../internal.js";
it("merges first sampling and main-task persistence; a failed attempt can be retried", async () => {
  const gate = Promise.withResolvers<never>();
  const createSession = vi.fn(() => gate.promise);
  const runtime = {
    sessionStore: { createSession },
    sessionPersisted: false,
    config: { mode: "build" },
    workingDirectory: "/fixture",
    sessionId: "task",
  } as unknown as AgentRuntimeInternal;
  const trace = { traceId: "trace", spanId: "span" } as never;
  const a = ensureSessionPersisted.call(runtime, "sampling", trace);
  const b = ensureSessionPersisted.call(runtime, "main", trace);
  const outcomes = Promise.allSettled([a, b]);
  expect(createSession).toHaveBeenCalledTimes(1);
  gate.reject(new Error("fixture storage failed"));
  expect((await outcomes).every((result) => result.status === "rejected")).toBe(true);
  await expect(ensureSessionPersisted.call(runtime, "retry", trace)).rejects.toThrow(
    "storage failed",
  );
  expect(createSession).toHaveBeenCalledTimes(2);
});

/**
 * 执行 cwd 落库取的是**会话执行边界**（`workspaceRoot`），不是落库那一刻的活 cwd
 * （`workingDirectory`，Bash `cd` 之后会变）。
 *
 * 判据：协议侧靠「`path` 严格落在工作区键路径之下」识别本规则铸造的会话目录
 * （bootstrap 的 `isPersistedConversationExecutionPath`），一旦 `path` 是对话根之外的目录，该会话
 * 就被判成「没有独立目录」——快照回落对话根（UI 文件树/提及/终端看错目录），而 core 恢复后仍在
 * 那个目录里跑。可达路径上两者恒等（Bash 只能在首个 turn 内、持久化之后改 cwd），这条用例把
 * 「语义不依赖落库时机」钉住：把 `path` 改回 `this.workingDirectory` 必红。
 */
it("执行 cwd 落库取会话执行边界，不取落库那一刻的活 cwd", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const createSession = vi.fn(async (input: Record<string, unknown>) => {
    calls.push(input);
  });
  const runtime = {
    appendEvent: async () => {},
    appVersion: "0.0.0",
    config: { mode: "build", workspacePath: "/conversation/root" },
    createEvent: () => ({}) as never,
    getSessionModelSelection: () => undefined,
    logger: undefined,
    sessionId: "task",
    sessionPersisted: false,
    sessionStore: { createSession },
    // 已 `cd sub` 的活 cwd 与本次会话的执行边界不同。
    workingDirectory: "/conversation/root/sub",
    workspaceRoot: "/conversation/root/2026-10-11/a1b2c3d4",
  } as unknown as AgentRuntimeInternal;
  await ensureSessionPersisted.call(runtime, "hello", {
    traceId: "trace",
    spanId: "span",
  } as never);

  expect(createSession).toHaveBeenCalledTimes(1);
  expect(calls[0]).toMatchObject({
    directory: "/conversation/root",
    path: "/conversation/root/2026-10-11/a1b2c3d4",
  });
});
