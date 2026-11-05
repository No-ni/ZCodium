// 官方闲时派发已退场；保留普通会话关闭与标题请求收尾的独立回归。
import { expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

it("session shutdown aborts a running title request and drains its final writes", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const runtime = createTestAgentRuntime(
    createSessionId("shutdown-title"),
    { mode: "yolo", compact: { enabled: false }, titleGeneration: {} },
    {
      sessionStore: createRecordingSubagentSessionStore(),
      eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({
        async generateText(request, observation) {
          if (observation.invocationContext?.metadata?.querySource === "session_title") {
            started.resolve(request.abortSignal!);
            await new Promise((_, reject) =>
              request.abortSignal!.addEventListener(
                "abort",
                () => reject(request.abortSignal!.reason),
                { once: true },
              ),
            );
          }
          return {
            text: "done",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      }),
    },
  );
  await runtime.executeTurn("Please explain the runtime shutdown mechanism carefully");
  const signal = await started.promise;
  runtime.beginShutdown();
  expect(signal.aborted).toBe(true);
  await runtime.closeOwnedWork();
  expect(runtime.hasResidencyBlockingWork()).toBe(false);
});
