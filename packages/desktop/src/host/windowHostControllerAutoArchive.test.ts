import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import type { IZCodeTaskService, WindowHostControllerFrame } from "@zcode/services";
import type { ZCodeTaskMeta, ZCodeWorkspaceEvent } from "@zcode/shared";
import { CONTROLLER_TASKS_INDEX_TOPIC } from "@zcode/shared/zcode-protocol-v4";
import { createWindowHostControllerRuntime } from "./windowHostControllerService.js";

for (const kind of ["local", "remote"] as const) {
  test(`${kind} archive invalidation refreshes desktop frames and mobile reconnect snapshots after an in-flight read`, async () => {
    const scope =
      kind === "remote"
        ? {
            kind,
            workspacePath: "/workspace",
            workspaceIdentity: "remote-identity",
            remoteSessionId: "current",
          }
        : { kind, workspacePath: "/workspace" };
    const meta: ZCodeTaskMeta = {
      taskId: "old",
      traceId: "fixture",
      title: "old",
      mode: "build",
      provider: "glm",
      createdAt: 1,
      updatedAt: 1,
      status: "completed",
      ...scope,
    };
    let archived = false;
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reads = 0;
    const events = new Emitter<ZCodeWorkspaceEvent>();
    const taskService = {
      listTasks: async () => {
        const result = archived ? [] : [meta];
        if (++reads === 1) {
          entered();
          await pending;
        }
        return result;
      },
      listPinnedTasks: async () => [],
      listArchivedTasks: async () => (archived ? [meta] : []),
      onDynamicWorkspaceEvent: () => events.event,
    } as unknown as IZCodeTaskService;
    const controller = createWindowHostControllerRuntime({
      createId: randomUUID,
      resolveSource: () => ({ scope, taskService, sourceAvailability: "online" }),
      onSourceError: (_scope, _operation, error) => {
        throw error;
      },
    });
    const desktopFrames: WindowHostControllerFrame[] = [];
    const desktop = controller.createAttachmentService();
    desktop.onDynamicControllerFrame()((frame) => desktopFrames.push(frame));
    await desktop.subscribeControllerV4({ topic: CONTROLLER_TASKS_INDEX_TOPIC });
    try {
      const initial = controller.service.listTaskList({
        kind: "active",
        workspaceScopes: [scope],
        sortBy: "updated",
      });
      await reading;
      archived = true;
      const refresh = controller.refreshWorkspace(scope);
      release();
      await initial;
      await refresh;
      assert.equal(reads, 2);
      assert.equal(
        (
          await desktop.listTaskList({
            kind: "active",
            workspaceScopes: [scope],
            sortBy: "updated",
          })
        ).items.length,
        0,
      );
      assert.ok(
        desktopFrames.some(
          (frame) =>
            frame.topic === CONTROLLER_TASKS_INDEX_TOPIC &&
            frame.payload.kind === "deltas" &&
            frame.payload.deltas.some(
              (delta) => delta.op === "task.upserted" && delta.task.membership.archived,
            ),
        ),
      );
      const mobile = controller.createAttachmentService();
      const mobileFrames: WindowHostControllerFrame[] = [];
      mobile.onDynamicControllerFrame()((frame) => mobileFrames.push(frame));
      await mobile.subscribeControllerV4({ topic: CONTROLLER_TASKS_INDEX_TOPIC });
      const snapshot = mobileFrames[0]!;
      assert.ok(
        snapshot.topic === CONTROLLER_TASKS_INDEX_TOPIC && snapshot.payload.kind === "snapshot",
      );
      assert.ok("tasks" in snapshot.payload.snapshot);
      assert.equal(snapshot.payload.snapshot.tasks[0]?.membership.archived, true);
      mobile.dispose();
    } finally {
      release();
      desktop.dispose();
      controller.dispose();
      events.dispose();
    }
  });
}
