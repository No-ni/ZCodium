import assert from "node:assert/strict";
import test from "node:test";
import { createBotProjectRuntime } from "../../packages/services/src/bot-project-runtime/index.ts";
import { createWindowHostControllerRuntime } from "../../packages/desktop/src/host/windowHostControllerService.ts";
import { buildServerRemoteWorkspaceIdentity } from "../../packages/shared/src/index.ts";

const target = {
  workspacePath: "/synthetic/bot",
  workspaceIdentity: buildServerRemoteWorkspaceIdentity({
    serverId: "fixture-source",
    workspacePath: "/synthetic/bot",
  }),
};
const hostId = "remote:server:fixture-source";
const meta = {
  ...target,
  taskId: "fixture-task",
  title: "fixture",
  createdAt: 1,
  updatedAt: 1,
  status: "completed",
};

function fixture() {
  let allowed = true;
  let reads = 0;
  let mutations = 0;
  let inspectionHook = async () => {};
  const inspect = async () => {
    if (!allowed) throw new Error("history-present");
    await inspectionHook();
  };
  const taskService = {
    async getTaskMeta(input) {
      reads++;
      return input.taskId === meta.taskId ? meta : null;
    },
    async listTasks() {
      reads++;
      return [meta];
    },
    async listPinnedTasks() {
      reads++;
      return [];
    },
    async listArchivedTasks() {
      reads++;
      return [];
    },
    async listTaskList() {
      reads++;
      return { items: [meta], total: 1, hasMore: false };
    },
    async setTaskPinned() {
      mutations++;
      return meta;
    },
    async sendPrompt() {
      mutations++;
    },
  };
  let source = {
    scope: { kind: "remote", sourceServerId: "fixture-source", ...target },
    taskService,
    sourceAvailability: "online",
    inspectWorkspace: inspect,
  };
  const controller = createWindowHostControllerRuntime({
    createId: () => "fixture-id",
    readHostTaskList: async () => {
      throw new Error("local fallback");
    },
    resolveSource: () => source,
  });
  const connection = {
    owner: {},
    taskService,
    bindWorkspace: inspect,
    agentService: { async syncAppRuntimePreferences() {} },
    modelSelectionService: {
      async getView() {
        return {};
      },
    },
  };
  let onlineConnection = connection;
  const bot = createBotProjectRuntime({
    remoteProjectService: {
      async readDirectory() {
        return { entries: [], hosts: [{ id: hostId, membershipId: "fixture-membership" }] };
      },
      async connectHost() {
        throw new Error("unexpected connect");
      },
    },
    resolveOnline: () => onlineConnection,
    onConnectionsChanged: () => ({ dispose() {} }),
    readBoundTargets: async () => [target],
    readRuntimePreferences: async () => ({}),
    warn() {},
  });
  return {
    bot,
    controller,
    get reads() {
      return reads;
    },
    get mutations() {
      return mutations;
    },
    setAllowed(value) {
      allowed = value;
    },
    setInspection(value) {
      inspectionHook = value;
    },
    retire() {
      source = { ...source, taskService: { ...taskService } };
    },
    retireBot() {
      onlineConnection = { ...connection, owner: {} };
    },
  };
}

test("Bot rejects another workspace and taskId-only calls outside the admitted task index", async () => {
  const f = fixture();
  try {
    const service = await f.bot.getZCodeTaskService(target);
    await assert.rejects(
      service.setTaskPinned({
        ...target,
        workspacePath: "/another",
        taskId: meta.taskId,
        pinned: true,
      }),
      /scope mismatch/,
    );
    await assert.rejects(
      service.sendPrompt({ taskId: "another-task", content: "fixture" }),
      /does not belong/,
    );
    await service.sendPrompt({ taskId: meta.taskId, content: "fixture" });
    assert.equal(f.mutations, 1);
    f.setAllowed(false);
    await assert.rejects(
      service.sendPrompt({ taskId: meta.taskId, content: "fixture" }),
      /history-present/,
    );
    assert.equal(f.mutations, 1);
  } finally {
    f.controller.dispose();
  }
});

test("Controller without a tab inspects before index reads, metadata and mutation", async () => {
  const f = fixture();
  const address = { taskId: meta.taskId, sourceServerId: "fixture-source", ...target };
  try {
    f.setAllowed(false);
    const list = await f.controller.service.listTaskList({
      workspaceScopes: [target],
      kind: "all",
    });
    assert.equal(list.items.length, 0);
    assert.equal(f.reads, 0);
    await assert.rejects(f.controller.service.getTaskMeta({ address }), /history-present/);
    await assert.rejects(
      f.controller.service.mutateTask({ address, mutation: { kind: "pin", pinned: true } }),
      /history-present/,
    );
    assert.equal(f.mutations, 0);
    f.setAllowed(true);
    await f.controller.service.mutateTask({ address, mutation: { kind: "pin", pinned: true } });
    assert.equal(f.mutations, 1);
  } finally {
    f.controller.dispose();
  }
});

test("Controller inspection cannot admit a replacement Source", async () => {
  const f = fixture();
  try {
    f.setInspection(async () => f.retire());
    await assert.rejects(
      f.controller.service.mutateTask({
        address: { taskId: meta.taskId, sourceServerId: "fixture-source", ...target },
        mutation: { kind: "pin", pinned: true },
      }),
      /retired/,
    );
    assert.equal(f.reads, 0);
    assert.equal(f.mutations, 0);
  } finally {
    f.controller.dispose();
  }
});

test("Bot command inspection cannot admit a replacement physical owner", async () => {
  const f = fixture();
  try {
    const service = await f.bot.getZCodeTaskService(target);
    f.setInspection(async () => f.retireBot());
    await assert.rejects(
      service.sendPrompt({ taskId: meta.taskId, content: "fixture" }),
      /changed/,
    );
    assert.equal(f.mutations, 0);
  } finally {
    f.controller.dispose();
  }
});
