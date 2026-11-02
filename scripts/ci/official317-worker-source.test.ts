import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getDataBaseDir } from "@zcode/services/node";
import { generateTraceId } from "@zcode/shared";
import { createWorkerSelectionIntegration } from "../../packages/desktop/test/e2e/helpers/worker-selection-integration.js";

test(
  "当前 CLI 源码 Worker 执行 BYOK 输入，冷恢复保留选择且附件不改 Session",
  { timeout: 90_000 },
  async () => {
    const previous = getDataBaseDir();
    const host = await createWorkerSelectionIntegration("worker-current-source", {
      cliEntrypoint: resolve("apps/zcode-cli/packages/cli/src/main.ts"),
      cliNodeArgs: ["--import", "tsx"],
      processLifecycleReporter: {
        onSpawn: () => console.info("WORKER_SOURCE_SPAWN"),
        onExit: (event) =>
          console.info("WORKER_SOURCE_EXIT", event.terminationKind, event.terminationReason),
      },
    });
    try {
      const created = await host.task.createTask({
        workspacePath: host.workspacePath,
        modelSelection: host.modelSelection,
        deferPersistenceUntilFirstPrompt: true,
      });
      const target = { workspacePath: host.workspacePath, sessionId: created.taskId };
      async function waitForRequest(marker: string) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const record = (await host.readProviderRequests()).find(
            (item) =>
              item.replay?.fixtureId !== "worker-byok-title" &&
              JSON.stringify(item.requestJson).includes(marker),
          );
          if (record) {
            const snapshot = await host.agent.readSession(target);
            console.info("WORKER_SOURCE_STATUS", snapshot.session.status);
            if (snapshot.session.status === "idle")
              return record.requestJson as Record<string, unknown>;
          }
          await delay(50);
        }
        throw new Error(`Missing synthetic Worker response: ${marker}`);
      }
      await host.task.sendPrompt({
        taskId: created.taskId,
        content: "E2E_W99_BOT_INITIAL",
        traceId: generateTraceId("worker-source"),
      });
      const first = await waitForRequest("E2E_W99_BOT_INITIAL");
      assert.equal(first.model, host.modelSelection.modelId);
      assert.deepEqual(first.output_config, { effort: "high" });
      const low = { ...host.modelSelection, options: { reasoningLevel: "low" } };
      await host.task.setModel({
        taskId: created.taskId,
        traceId: generateTraceId("worker-source"),
        modelSelection: low,
      });
      await host.agent.disposeWorkspace({ workspacePath: host.workspacePath });
      await host.task.resumeTask({ taskId: created.taskId, workspacePath: host.workspacePath });
      assert.deepEqual(await host.task.getTaskModelSelection({ taskId: created.taskId }), low);
      await assert.rejects(
        host.task.setModel({
          taskId: created.taskId,
          traceId: generateTraceId("worker-source"),
          modelSelection: { ...low, options: { reasoningLevel: "invalid" } },
        }),
      );
      assert.deepEqual(await host.task.getTaskModelSelection({ taskId: created.taskId }), low);
      await host.task.sendPrompt({
        taskId: created.taskId,
        content: "E2E_W99_ATTACHMENT",
        traceId: generateTraceId("worker-source"),
        modelSelection: host.modelSelection,
        modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
        attachments: [
          {
            kind: "file",
            filename: "first.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
            textContent: "FIRST",
          },
          {
            kind: "file",
            filename: "second.txt",
            mimeType: "text/plain",
            sizeBytes: 6,
            textContent: "SECOND",
          },
        ],
      });
      const attached = await waitForRequest("E2E_W99_ATTACHMENT");
      assert.deepEqual(attached.output_config, { effort: "high" });
      const messages = JSON.stringify(attached.messages);
      assert.ok(
        messages.indexOf("FIRST") >= 0 && messages.indexOf("SECOND") > messages.indexOf("FIRST"),
      );
      assert.deepEqual(await host.task.getTaskModelSelection({ taskId: created.taskId }), low);
    } finally {
      await host.dispose();
      assert.equal(getDataBaseDir(), previous);
    }
  },
);
