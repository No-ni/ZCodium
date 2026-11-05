// 官方闲时工具已退场；保留普通用户/automation 的公开工具端口回归。
import { expect, it, vi } from "vitest";
import type { TraceId } from "@zcode/contracts";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { sendMessageToolEntry } from "../src/tool/handlers/send-message.js";
import { workflowToolEntry } from "../src/tool/handlers/workflow.js";

function createContext(): ToolExecutionContext {
  return {
    toolCallId: "tool-fixture",
    traceId: "trace-fixture" as TraceId,
    abortSignal: new AbortController().signal,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    workspaceScopeRoot: "/workspace",
    sessionId: "session-fixture" as never,
  };
}
const sendMessageInput = { to: "agent_1", summary: "s", message: "continue" };
const workflowInput = { scriptPath: "review.workflow.js" };

it("普通轮与 automation 轮不受影响（D49-3 方向：cron 轮照旧放行）", async () => {
  const sendMessage = vi.fn(async () => ({ status: "success", messageId: "m1" }));
  const start = vi.fn(async () => ({ status: "backgrounded", runId: "wf_1", response: "ok" }));
  for (const extra of [{}, { automationTurn: true }]) {
    const context = {
      ...createContext(),
      ...extra,
      subagentPort: { sendMessage } as never,
      workflowPort: { start } as never,
    };
    await expect(sendMessageToolEntry.handler(sendMessageInput, context)).resolves.toBeDefined();
    await expect(workflowToolEntry.handler(workflowInput, context)).resolves.toBeDefined();
  }
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledTimes(2);
});
