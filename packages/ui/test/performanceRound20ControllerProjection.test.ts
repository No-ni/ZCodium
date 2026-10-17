import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IWindowControllerService, WindowHostControllerFrame } from "@zcode/services";
import {
  CONTROLLER_TASKS_INDEX_TOPIC as TASKS,
  type ControllerResyncResult,
  type WindowHostControllerTaskFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";
import { createWindowHostControllerProjection } from "../../desktop/src/host/windowHostControllerProjection.js";

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("controller recovery with production Host projection", () => {
  it.each(["local", "remote"] as const)(
    "%s burst needs only two full snapshots and retains the final update",
    async (kind) => {
      let serial = 0;
      const projection = createWindowHostControllerProjection({
        createId: () => `synthetic-${++serial}`,
      });
      const scope =
        kind === "local"
          ? { kind, workspacePath: "C:/synthetic/workspace" }
          : {
              kind,
              workspacePath: "C:/synthetic/workspace",
              workspaceIdentity: "synthetic-remote",
              remoteSessionId: "remote-1",
            };
      projection.registerSource({
        scope,
        mutate: () => {
          throw new Error("no real mutations in fixture");
        },
      });
      projection.replaceSourceSnapshot({
        scope,
        sessionsIndex: [],
        taskIndex: Array.from({ length: 1000 }, (_, index) => ({
          meta: {
            taskId: `task-${index}`,
            traceId: `trace-${index}`,
            title: `Task ${index}`,
            mode: "edit" as const,
            createdAt: 1,
            updatedAt: 2,
            workspacePath: scope.workspacePath,
            ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          },
          membership: { pinned: false, archived: false, active: true },
        })),
      });
      const frames = new Emitter<WindowHostControllerFrame>();
      const subscriptions = new Map<string, ReturnType<typeof projection.subscribe>>();
      const requests: Array<{
        resolve: (value: ControllerResyncResult) => void;
        result: ControllerResyncResult;
      }> = [];
      const heldSnapshots: WindowHostControllerTaskFrame[] = [];
      const generatedSnapshots: WindowHostControllerTaskFrame[] = [];
      const deliveredSnapshots: WindowHostControllerTaskFrame[] = [];
      let measuring = false;
      let holdSnapshots = false;
      let dropNextDelta = false;
      const observation = frames.event((frame) => {
        if (frame.topic === TASKS && frame.payload.kind === "snapshot")
          deliveredSnapshots.push(frame);
      });
      const deliver = (frame: WindowHostControllerFrame) => {
        if (frame.topic === TASKS && frame.payload.kind === "deltas" && dropNextDelta) {
          dropNextDelta = false;
          return;
        }
        if (frame.topic === TASKS && frame.payload.kind === "snapshot") {
          if (measuring) generatedSnapshots.push(frame);
          if (holdSnapshots) {
            heldSnapshots.push(frame);
            return;
          }
        }
        frames.fire(frame);
      };
      const resync = vi.fn<IWindowControllerService["resyncControllerV4"]>((params) => {
        // 使用真实投影：先生成/发出快照，再延迟 ACK，模拟 RPC 的独立送达。
        const result = { ack: projection.resync(params.subscriptionId) };
        return new Promise((resolve) => requests.push({ resolve, result }));
      });
      const controller = {
        onDynamicControllerFrame: () => frames.event,
        async subscribeControllerV4({ topic }) {
          const subscription = projection.subscribe({ topic, onFrame: deliver });
          subscriptions.set(subscription.subscriptionId, subscription);
          return { ack: subscription.ack };
        },
        async unsubscribeControllerV4({ subscriptionId }) {
          subscriptions.get(subscriptionId)?.dispose();
          subscriptions.delete(subscriptionId);
        },
        resyncControllerV4: resync,
      } as IWindowControllerService;
      const registry = getWindowControllerTaskListRegistry(controller);
      const stop = registry.subscribe(() => {});
      try {
        await flush();
        measuring = true;
        holdSnapshots = true;
        dropNextDelta = true;
        for (let index = 0; index <= 64; index += 1) {
          projection.replaceSourceSessionOverlays(scope, [
            { taskId: "task-0", liveStatus: "running", updatedAt: 1000 + index },
          ]);
        }
        expect(resync.mock.calls.length).toBe(1);
        expect(generatedSnapshots).toHaveLength(1);
        expect(heldSnapshots[0]!.payload.kind).toBe("snapshot");
        const first = heldSnapshots[0]!;
        if (first.payload.kind !== "snapshot") throw new Error("snapshot expected");
        expect(
          first.payload.snapshot.tasks.find((row) => row.address.taskId === "task-0")!.meta
            .updatedAt,
        ).toBe(1001);

        holdSnapshots = false;
        frames.fire(first);
        requests[0]!.resolve(requests[0]!.result);
        await flush();
        expect(resync.mock.calls.length).toBe(2);
        expect(
          generatedSnapshots.reduce(
            (rows, frame) =>
              rows + (frame.payload.kind === "snapshot" ? frame.payload.snapshot.tasks.length : 0),
            0,
          ),
        ).toBe(2000);
        const latest = deliveredSnapshots.at(-1)!;
        if (latest.payload.kind !== "snapshot") throw new Error("snapshot expected");
        const finalRow = latest.payload.snapshot.tasks.find(
          (row) => row.address.taskId === "task-0",
        )!;
        expect(finalRow.meta.updatedAt).toBe(1064);
        expect(finalRow.address.workspaceIdentity).toBe(scope.workspaceIdentity);
        expect(finalRow.address.remoteSessionId).toBe(scope.remoteSessionId);
        requests[1]!.resolve(requests[1]!.result);
        await flush();
        projection.replaceSourceSessionOverlays(scope, [
          { taskId: "task-0", liveStatus: "completed", updatedAt: 1065 },
        ]);
        expect(resync.mock.calls.length).toBe(2);
      } finally {
        stop();
        for (const request of requests) request.resolve(request.result);
        for (const subscription of subscriptions.values()) subscription.dispose();
        subscriptions.clear();
        observation.dispose();
        frames.dispose();
        await flush();
      }
    },
  );
});
