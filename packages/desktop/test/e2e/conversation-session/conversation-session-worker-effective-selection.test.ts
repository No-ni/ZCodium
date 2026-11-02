import { encodeCustomModelValue, generateTraceId } from "@zcode/shared";
import { createWorkerSelectionIntegration } from "../helpers/worker-selection-integration.js";
import {
  createBotsServiceHarness,
  createFeishuConfig,
} from "#e2e/bots/helpers/bots-service-harness";
import { clearAppData } from "../helpers/desktop-app.js";

describe("BYOK Worker 的 Bot、附件与即时设置真实执行", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("W99-E02/03/06: 绑定 Bot 的下一轮、附件和立即设置贯穿真实 Host/Worker", async function () {
    this.timeout(180000);
    const host = await createWorkerSelectionIntegration();
    try {
      const original = {
        providerId: host.modelSelection.providerId,
        modelId: host.modelSelection.modelId,
        options: { reasoningLevel: "high" },
      };
      const effective = {
        ...original,
        providerId: host.modelSelection.providerId,
      };
      const created = await host.task.createTask({
        workspacePath: host.workspacePath,
        modelSelection: original,
        deferPersistenceUntilFirstPrompt: true,
      });
      const target = { workspacePath: host.workspacePath, sessionId: created.taskId };
      const harness = createBotsServiceHarness({
        config: createFeishuConfig(),
        state: {
          version: 3,
          bots: {
            "feishu-e2e": {
              botId: "feishu-e2e",
              workspacePath: host.workspacePath,
              mode: "task",
              activeTaskId: created.taskId,
              updatedAt: 1,
            },
          },
        },
        modelSelectionService: host.modelSelectionService,
      });
      // 只替换测试 harness 的 task port；以下读取、命令、发送、订阅均为生产 adapter。
      Object.assign(harness.zcodeTaskService, host.task);
      const sendBot = (text: string) =>
        harness.service.handleInboundMessage({
          botId: "feishu-e2e",
          actor: {
            provider: "feishu",
            botId: "feishu-e2e",
            providerUserId: "ou_e2e_user",
            chatType: "private",
          },
          text,
        });
      async function waitRequest(marker: string) {
        let result: CapturedProviderRequest | undefined;
        await browser.waitUntil(
          async () => {
            result = (await host.readProviderRequests())
              .map((record) => ({
                ...record,
                request: { body: record.requestJson as Record<string, unknown> },
              }))
              .find((record) => JSON.stringify(record.request).includes(marker));
            return Boolean(result);
          },
          { timeout: 30000, timeoutMsg: `缺少真实请求 ${marker}` },
        );
        await browser
          .waitUntil(async () => (await host.agent.readSession(target)).session.status === "idle", {
            timeout: 15000,
            timeoutMsg: "上一轮没有结束",
          })
          .catch(async (error) => {
            await logWorkerFailure(host, target, marker);
            throw error;
          });
        return result!;
      }
      try {
        await host.task.sendPrompt({
          taskId: created.taskId,
          content: "E2E_W99_BOT_INITIAL",
          traceId: generateTraceId("w99"),
          modelSelection: original,
        });
        expect((await waitRequest("E2E_W99_BOT_INITIAL")).request.body.model).toBe(
          original.modelId,
        );
        expect(await host.task.getTaskModelSelection({ taskId: created.taskId })).toEqual(original);
        await sendBot("E2E_W99_BOT_NEXT");
        const next = await waitRequest("E2E_W99_BOT_NEXT");
        expect(next.request.body.model).toBe(effective.modelId);
        expect(next.request.body).toMatchObject({ output_config: { effort: "high" } });
        expect(harness.readState().bots["feishu-e2e"]?.draftOptions).toBeUndefined();

        await sendBot(`/model ${encodeCustomModelValue(effective.providerId, effective.modelId)}`);
        expect(
          (await host.task.getTaskModelSelection({ taskId: created.taskId }))?.options
            ?.reasoningLevel,
        ).toBe("max");
        // 单独设置档位是已提交的 Session 命令，必须立刻保存，不等下一条消息。
        await sendBot("/think low");
        expect(await host.task.getTaskModelSelection({ taskId: created.taskId })).toEqual({
          ...effective,
          options: { reasoningLevel: "low" },
        });
        // 真正退出 Worker 再恢复，不能只靠同进程内存读证明立即持久化。
        await host.agent.disposeWorkspace({ workspacePath: host.workspacePath });
        await host.task.resumeTask({ taskId: created.taskId, workspacePath: host.workspacePath });
        expect(await host.task.getTaskModelSelection({ taskId: created.taskId })).toEqual({
          ...effective,
          options: { reasoningLevel: "low" },
        });
        await expect(
          host.task.setModel({
            taskId: created.taskId,
            traceId: generateTraceId("w99"),
            modelSelection: { ...effective, options: { reasoningLevel: "invalid" } },
          }),
        ).rejects.toThrow();
        expect(
          (await host.task.getTaskModelSelection({ taskId: created.taskId }))?.options
            ?.reasoningLevel,
        ).toBe("low");

        // Session 当前 low；本次已固定 high，附件分支不能退回旧 Session 选择。
        await host.task.sendPrompt({
          taskId: created.taskId,
          content: "E2E_W99_ATTACHMENT",
          traceId: generateTraceId("w99"),
          modelSelection: effective,
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
        const attached = await waitRequest("E2E_W99_ATTACHMENT");
        expect(attached.request.body.model).toBe(effective.modelId);
        expect(attached.request.body).toMatchObject({ output_config: { effort: "high" } });
        const body = JSON.stringify(attached.request.body);
        expect(body.indexOf("FIRST")).toBeGreaterThanOrEqual(0);
        expect(body.indexOf("SECOND")).toBeGreaterThan(body.indexOf("FIRST"));
        expect(attached.error).toBeUndefined();
        expect(
          (await host.task.getTaskModelSelection({ taskId: created.taskId }))?.options
            ?.reasoningLevel,
        ).toBe("low");
      } finally {
        harness.service.disposeAll();
      }
    } finally {
      await host.dispose();
    }
  });
});

type CapturedProviderRequest = {
  request: { body: Record<string, unknown> };
  error?: string;
};

async function logWorkerFailure(
  host: Awaited<ReturnType<typeof createWorkerSelectionIntegration>>,
  target: { workspacePath: string; sessionId: string },
  marker: string,
) {
  const snapshot = await host.agent.readSession(target);
  const events = await host.agent.readSessionEvents(target);
  const records = await host.readProviderRequests();
  console.log(
    "E2E_WORKER_FAILURE",
    JSON.stringify({
      marker,
      status: snapshot.session.status,
      messageCount: snapshot.messages.length,
      failures: events.filter((event) => event.type === "turn.failed"),
      requests: records
        .filter((record) => JSON.stringify(record.requestJson).includes(marker))
        .map((record) => ({
          model: (record.requestJson as { model?: string })?.model,
          error: record.error,
        })),
    }),
  );
}
