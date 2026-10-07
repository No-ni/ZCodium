import assert from "node:assert/strict";
import test from "node:test";
import { IZCodeTaskService, ServiceCollection } from "@zcode/services";
import { createTaskAutoArchiveRemoteTargetResolver } from "./taskAutoArchiveRouting.js";

test("archive routing rechecks session identity at submission and never accepts path-only or stale sessions", async () => {
  const workspace = { workspacePath: "/same/path", workspaceIdentity: "remote-a" };
  let session = {
    ...workspace,
    remoteSessionId: "session-1",
    sourceAvailability: "online" as "online" | "offline",
  };
  const calls: unknown[] = [];
  const services = new ServiceCollection().register(IZCodeTaskService, {
    archiveStaleTasks: async (params: Parameters<IZCodeTaskService["archiveStaleTasks"]>[0]) => {
      calls.push(params);
      return [];
    },
  } as unknown as IZCodeTaskService);
  const resolve = createTaskAutoArchiveRemoteTargetResolver({
    findSessionForWorkspace: () => session,
    resolveScopedServices: (scope) => {
      assert.equal(scope.kind, "remote");
      if (
        scope.kind !== "remote" ||
        scope.remoteSessionId !== session.remoteSessionId ||
        scope.workspaceIdentity !== session.workspaceIdentity ||
        session.sourceAvailability !== "online"
      )
        throw new Error("stale scope");
      return services;
    },
  });
  assert.equal(resolve({ ...workspace, workspaceIdentity: "remote-b" }), undefined);
  const old = resolve(workspace)!;
  session = { ...session, remoteSessionId: "session-2" };
  assert.throws(() => old.archiveStaleTasks({ ...workspace, olderThanDays: 7 }), /stale scope/);
  await resolve(workspace)!.archiveStaleTasks({ ...workspace, olderThanDays: 7 });
  assert.deepEqual(calls, [{ ...workspace, olderThanDays: 7, remoteSessionId: "session-2" }]);
  session.sourceAvailability = "offline";
  assert.equal(resolve(workspace), undefined);
});
