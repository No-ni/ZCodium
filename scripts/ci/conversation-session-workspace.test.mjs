/* eslint-disable max-lines -- 本文件是「对话会话独立工作目录」的单元级 CI 入口（进程级验收另有
   conversation-session-workspace-e2e.test.mjs）：目录命名/规划、创建与恢复的路径裁决、以及删除
   边界的空目录回收接线共用同一批 fixture（临时对话根）与同一份 tsImport 装载；拆成多个文件会让
   这些共享前置重复多份并失去「同一规则全覆盖」的可读性。真正拆分时按「命名与裁决」/「回收接线」
   两个主题各建一个 test.mjs。 */
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, resolve, sep } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  ConversationSessionWorkspaceCollisionError,
  ConversationSessionWorkspaceUnavailableError,
  CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON,
  buildConversationSessionDirName,
  ensureConversationSessionDirForBareResume,
  ensureConversationSessionWorkspaceDir,
  ensureConversationSessionWorkspaceForExecution,
  formatConversationSessionDateDir,
  isConversationSessionDateDirUsable,
  isConversationSessionWorkspacePath,
  isConversationWorkspaceEnabled,
  isPersistedConversationExecutionPath,
  isReusablePersistedConversationExecutionPath,
  persistConversationSessionBackfillDirectory,
  planConversationSessionWorkspace,
  resolveConversationSessionDirNameForCreate,
  resolveConversationSessionWorkspaceForCreate,
  resolveConversationSessionWorkspaceForResume,
  resolveConversationSessionWorkspaceInherited,
  resolvePersistedConversationExecutionFallback,
} = await tsImport(
  "../../apps/zcode-cli/packages/bootstrap/src/app/conversation-session-workspace.ts",
  import.meta.url,
);
const { reclaimEmptyConversationSessionDir, sweepEmptyConversationSessionDirs } = await tsImport(
  "../../apps/zcode-cli/packages/bootstrap/src/app/conversation-session-workspace-reclaim.ts",
  import.meta.url,
);
// 删除边界的回收接线：判定函数 + 接线本体（v4-bridge closeSession 调用的就是后者）。
const {
  isConversationSessionDirectoryInUse,
  isConversationSessionDirectoryInUseAcrossProcesses,
  isConversationSessionReclaimEnabled,
  ownsConversationSessionDirectory,
  reclaimConversationSessionDirOnDelete,
  resetConversationSessionEmptySweepScheduleForTests,
  scheduleConversationSessionEmptySweep,
  shouldReclaimConversationSessionDir,
} = await tsImport(
  "../../apps/zcode-cli/packages/bootstrap/src/app/conversation-session-workspace-reclaim.ts",
  import.meta.url,
);

const { activateSessionForResume } = await tsImport(
  "../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts",
  import.meta.url,
);

const SESSION_ID = "sess_a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "zcode-conversation-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertMissing(path) {
  await assert.rejects(
    () => stat(path),
    (error) => error.code === "ENOENT",
    `expected ${path} to be removed`,
  );
}

async function assertPresent(path) {
  const info = await stat(path);
  assert.ok(info.isDirectory(), `expected ${path} to stay`);
}

/**
 * 会话库的窄面假实现：只需 getSession/updateSession（补发写回用到的全部能力）。
 * `row` 暴露当前落盘事实，用于断言「只改 path、directory 与活动时间不动」。
 */
function createFakeSessionStore(initial) {
  const row = {
    directory: initial.directory,
    path: initial.path,
    timeUpdated: initial.updatedAt,
  };
  const snapshot = () => ({
    directory: row.directory,
    path: row.path,
    time: { updated: row.timeUpdated },
  });
  return {
    getSession: async () => snapshot(),
    row,
    updateSession: async (input) => {
      if (input.directory !== undefined) row.directory = input.directory;
      if (input.path !== undefined) row.path = input.path;
      if (input.timeUpdated !== undefined) row.timeUpdated = input.timeUpdated;
      return snapshot();
    },
  };
}

/**
 * 启动清扫要用的会话库窄面假实现：只回答「库里有那些非空 path」。
 * `inputs` 记录收到的查询参数，用于断言清扫**没有**依赖 `directory` 精确过滤。
 */
function createFakeSessionPathSource(rows = []) {
  const inputs = [];
  return {
    inputs,
    listSessions: async (query) => {
      inputs.push(query);
      return rows;
    },
  };
}

/** 会话库不可用的假实现：清扫必须 fail-closed（一个目录都不删），且失败路径要能被观测。 */
function createThrowingSessionPathSource() {
  const calls = [];
  return {
    calls,
    listSessions: async (query) => {
      calls.push(query);
      throw new Error("session store unavailable");
    },
  };
}

/** 收集日志的假 logger：只关心「失败/接线缺陷是否被报出来」，不关心格式。 */
function createRecordingLogger() {
  const debugMessages = [];
  const warnMessages = [];
  const warnContexts = [];
  return {
    debug: (message) => debugMessages.push(String(message)),
    debugMessages,
    warn: (message, context) => {
      warnMessages.push(String(message));
      warnContexts.push(context);
    },
    warnContexts,
    warnMessages,
  };
}

/** 启动清扫是 fire-and-forget：只断言它最终完成，不用 sleep 猜时序。 */
async function waitForMissing(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path} to be removed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("目录名取会话 id 的 uuid 段前 8 位，不含 sess_ 前缀", () => {
  assert.equal(buildConversationSessionDirName(SESSION_ID), "a1b2c3d4");
  assert.equal(buildConversationSessionDirName(SESSION_ID, 12), "a1b2c3d45e6f");
});

test("异常会话 id 退化为稳定哈希，不抛错也不产生空目录名", () => {
  const first = buildConversationSessionDirName("导入的历史会话");
  const second = buildConversationSessionDirName("导入的历史会话");
  assert.equal(first, second);
  assert.match(first, /^[a-z0-9]{8}$/u);
});

test("非 uuid 形态的会话 id 不得因公共前缀共用目录（子代理 / workflow 子会话）", () => {
  // 仓库自己就在铸这些 id：`sess_${"subagent_" + agentId}` / `sess_${"workflow_" + activityId}`。
  // 取「id 前 8 位」会让同一天的所有同类子会话挤进同一个执行目录，并让回收的所有权判定
  // 把同一目录判给两个会话；这类 id 必须走稳定哈希。
  const subagentA = buildConversationSessionDirName(
    "sess_subagent_agent_11111111-1111-4111-8111-111111111111",
  );
  const subagentB = buildConversationSessionDirName(
    "sess_subagent_agent_22222222-2222-4222-8222-222222222222",
  );
  const workflowA = buildConversationSessionDirName(
    "sess_workflow_activity_aaaaaaaa-1111-4111-8111-111111111111",
  );
  const workflowB = buildConversationSessionDirName(
    "sess_workflow_activity_bbbbbbbb-2222-4222-8222-222222222222",
  );
  for (const name of [subagentA, subagentB, workflowA, workflowB]) {
    assert.match(name, /^[a-z0-9]{8}$/u, `目录名形状必须是 8 位小写字母数字: ${name}`);
  }
  assert.notEqual(subagentA, subagentB, "两个子代理会话不能共用目录");
  assert.notEqual(workflowA, workflowB, "两个 workflow 子会话不能共用目录");
  // 稳定可复现 + 12 位是同一哈希的更长前缀（所有权判定两种都认）。
  assert.equal(
    subagentA,
    buildConversationSessionDirName("sess_subagent_agent_11111111-1111-4111-8111-111111111111"),
  );
  assert.ok(
    buildConversationSessionDirName(
      "sess_subagent_agent_11111111-1111-4111-8111-111111111111",
      12,
    ).startsWith(subagentA),
  );
  // 所有权：B 不得被判为拥有 A 的目录（否则删 B 会删掉 A 正在用的目录）。
  assert.equal(
    ownsConversationSessionDirectory({
      executionPath: join("/root/default", "2026-10-11", subagentA),
      sessionId: "sess_subagent_agent_11111111-1111-4111-8111-111111111111",
    }),
    true,
  );
  assert.equal(
    ownsConversationSessionDirectory({
      executionPath: join("/root/default", "2026-10-11", subagentA),
      sessionId: "sess_subagent_agent_22222222-2222-4222-8222-222222222222",
    }),
    false,
  );
});

test("日期目录用本地日期；恢复按持久化名字复用，不按当前时间重算", () => {
  const created = new Date(2026, 9, 11, 13, 30, 0).getTime();
  assert.equal(formatConversationSessionDateDir(created), "2026-10-11");
  const plan = planConversationSessionWorkspace({
    conversationRoot: "/root/default",
    sessionId: SESSION_ID,
    createdAtMs: created,
  });
  assert.equal(plan.directory, resolve("/root/default", "2026-10-11", "a1b2c3d4"));
  const resumed = planConversationSessionWorkspace({
    conversationRoot: "/root/default",
    sessionId: SESSION_ID,
    createdAtMs: new Date(2026, 9, 12, 0, 5, 0).getTime(),
    existingName: "a1b2c3d4",
  });
  assert.equal(resumed.directory, resolve("/root/default", "2026-10-12", "a1b2c3d4"));
});

test("只有未带 identity 且路径等于对话根的 workspace 才启用独立目录", () => {
  assert.equal(
    isConversationWorkspaceEnabled({
      conversationRoot: "/root/default",
      workspacePath: "/root/default",
    }),
    true,
  );
  assert.equal(
    isConversationWorkspaceEnabled({
      conversationRoot: "/root/default/",
      workspacePath: "/root/default",
    }),
    true,
  );
  assert.equal(
    isConversationWorkspaceEnabled({
      conversationRoot: "/root/default",
      workspacePath: "/root/default",
      workspaceIdentity: "remote:ssh:host",
    }),
    false,
  );
  assert.equal(
    isConversationWorkspaceEnabled({
      conversationRoot: undefined,
      workspacePath: "/root/default",
    }),
    false,
  );
  assert.equal(
    isConversationWorkspaceEnabled({
      conversationRoot: "/root/default",
      workspacePath: "/root/project",
    }),
    false,
  );
});

test("对话根自身不算会话目录；根之外与 .. 逃逸都不算", () => {
  assert.equal(isConversationSessionWorkspacePath("/root/default", "/root/default"), false);
  assert.equal(
    isConversationSessionWorkspacePath("/root/default/2026-10-11/a1b2c3d4", "/root/default"),
    true,
  );
  assert.equal(isConversationSessionWorkspacePath("/root/other", "/root/default"), false);
  assert.equal(
    isConversationSessionWorkspacePath("/root/default/../other", "/root/default"),
    false,
  );
  assert.equal(isConversationSessionWorkspacePath(undefined, "/root/default"), false);
  // 严格包含：等于对话根（存量会话旧值）不算会话目录；目录名只由创建侧的定名规则决定，
  // 恢复不按名字反推（见「新建定名」与「恢复复用」两组用例）。
  assert.equal(isConversationSessionWorkspacePath("/root/default", "/root/default"), false);
});

test("新建定名：同名目录一律复用（定名对同一会话幂等）", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 9, 11, 9, 0, 0).getTime();
    const resolveName = () =>
      resolveConversationSessionDirNameForCreate({
        conversationRoot: root,
        sessionId: SESSION_ID,
        createdAtMs,
      });
    assert.equal(resolveName(), "a1b2c3d4");
    // 目录已存在（自己的残留、写库失败后的重试、并发冷恢复）→ 仍是同一个名字。
    // 这里若回退 12 位，行会被 upsert 到新目录，前一次目录里已写的文件永久失联
    // （非空目录不会被空目录回收），且违背「名字一旦确定即随会话持久化」。
    await mkdir(join(root, "2026-10-11", "a1b2c3d4"), { recursive: true });
    assert.equal(resolveName(), "a1b2c3d4");
  });
});

test("新建定名：8 位目录被非目录（文件 / 符号链接）占住时回退 12 位", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 9, 11, 9, 0, 0).getTime();
    const dateDir = join(root, "2026-10-11");
    await mkdir(dateDir, { recursive: true });
    const shortPath = join(dateDir, "a1b2c3d4");
    const resolveName = () =>
      resolveConversationSessionDirNameForCreate({
        conversationRoot: root,
        sessionId: SESSION_ID,
        createdAtMs,
      });
    // 同名文件：mkdir 必失败，换 12 位给新会话一条活路。
    await writeFile(shortPath, "occupied by a file");
    assert.equal(resolveName(), "a1b2c3d45e6f");
    // 符号链接：不跟随（跟随会让 mkdir 写到对话根之外），同样按占位处理。
    await rm(shortPath);
    await symlink(dateDir, shortPath, "dir");
    assert.equal(resolveName(), "a1b2c3d45e6f");
  });
});

test("新建定名：悬空符号链接占住 8 位路径时也必须回退，且创建仍能成功", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 9, 11, 9, 0, 0).getTime();
    const dateDir = join(root, "2026-10-11");
    await mkdir(dateDir, { recursive: true });
    const shortPath = join(dateDir, "a1b2c3d4");
    // 断链（会话目录被软链到未挂载的外接盘 / 同步工具留下的死链）：
    // `existsSync` **跟随**链接、对断链返回 false，会把占位护栏整条绕过，
    // 于是用 8 位去 mkdir，而 `mkdir(recursive)` 对断链报 ENOENT —— 该 8 位前缀的会话
    // 创建会确定性失败、重试也永远失败。判定必须用 lstat。
    await symlink(join(root, "not-mounted-external-disk"), shortPath, "dir");
    const name = resolveConversationSessionDirNameForCreate({
      conversationRoot: root,
      sessionId: SESSION_ID,
      createdAtMs,
    });
    assert.equal(name, "a1b2c3d45e6f");
    // 12 位路径可正常创建：兜底确实给了新会话一条活路（而不是只改了个名字）。
    const directory = join(dateDir, name);
    await ensureConversationSessionWorkspaceDir(directory);
    await assertPresent(directory);
  });
});

test("定名占用比较复用平台大小写规则，避免不同拼写共享执行目录", async () => {
  await withRoot(async (root) => {
    const createdAtMs = Date.now();
    const plan = planConversationSessionWorkspace({
      conversationRoot: root,
      sessionId: SESSION_ID,
      createdAtMs,
    });
    await mkdir(plan.directory, { recursive: true });
    const input = { conversationRoot: root, sessionId: SESSION_ID, createdAtMs };
    const upperShort = join(plan.dateDir, plan.name.toUpperCase());
    const longName = buildConversationSessionDirName(SESSION_ID, 12);
    assert.equal(
      resolveConversationSessionDirNameForCreate({
        ...input,
        occupiedDirectories: [upperShort],
      }),
      process.platform === "linux" ? plan.name : longName,
    );
    if (process.platform !== "linux") {
      assert.throws(
        () =>
          resolveConversationSessionDirNameForCreate({
            ...input,
            occupiedDirectories: [upperShort, join(plan.dateDir, longName.toUpperCase())],
          }),
        ConversationSessionWorkspaceCollisionError,
      );
      assert.equal(
        resolveConversationSessionWorkspaceForResume({
          ...input,
          workspacePath: root,
          persistedPath: root,
          occupiedDirectories: [upperShort],
        }).directory,
        join(plan.dateDir, longName),
      );
    }
  });
});

test("派生 cwd 仍认领祖先候选目录，目录缺失时新建与补发也不得复用", async () => {
  await withRoot(async (root) => {
    const createdAtMs = Date.now();
    const plan = planConversationSessionWorkspace({
      conversationRoot: root,
      sessionId: SESSION_ID,
      createdAtMs,
    });
    const input = { conversationRoot: root, sessionId: SESSION_ID, createdAtMs };
    const longName = buildConversationSessionDirName(SESSION_ID, 12);
    const nested = join(plan.directory, "nested", "child");
    assert.equal(
      resolveConversationSessionDirNameForCreate({ ...input, occupiedDirectories: [nested] }),
      longName,
    );
    assert.equal(
      resolveConversationSessionWorkspaceForResume({
        ...input,
        workspacePath: root,
        persistedPath: root,
        occupiedDirectories: [nested],
      }).directory,
      join(plan.dateDir, longName),
    );
    assert.throws(
      () =>
        resolveConversationSessionDirNameForCreate({
          ...input,
          occupiedDirectories: [nested, join(plan.dateDir, longName, "nested")],
        }),
      ConversationSessionWorkspaceCollisionError,
    );
    // 同名前缀邻居和位于候选祖先的旧共享根不构成这个候选的认领。
    assert.equal(
      resolveConversationSessionDirNameForCreate({
        ...input,
        occupiedDirectories: [root, join(plan.dateDir, `${plan.name}ff`, "nested")],
      }),
      plan.name,
    );
  });
});

test("在册路径缺失时仍通过最近祖先规范化根别名", async () => {
  const { conversationSessionDirectoryKey } = await tsImport(
    "../../apps/zcode-cli/packages/bootstrap/src/app/conversation-session-workspace-registry.ts",
    import.meta.url,
  );
  await withRoot(async (root) => {
    const canonical = join(root, "default");
    const alias = join(root, "alias");
    await mkdir(canonical);
    await symlink(canonical, alias, "dir");
    const suffix = join("2026-10-14", "a1b2c3d4", "nested");
    assert.equal(
      await conversationSessionDirectoryKey(join(alias, suffix)),
      await conversationSessionDirectoryKey(join(canonical, suffix)),
    );
  });
});

test("新建定名：8 位目录被别的在册会话占用时回退 12 位，占用只对「别的会话」成立", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 9, 11, 9, 0, 0).getTime();
    const dateDir = join(root, "2026-10-11");
    const shortPath = join(dateDir, "a1b2c3d4");
    const longPath = join(dateDir, "a1b2c3d45e6f");
    await mkdir(shortPath, { recursive: true });
    const resolveName = (occupiedDirectories) =>
      resolveConversationSessionDirNameForCreate({
        conversationRoot: root,
        createdAtMs,
        ...(occupiedDirectories === undefined ? {} : { occupiedDirectories }),
        sessionId: SESSION_ID,
      });
    const createWorkspace = (occupiedDirectories) =>
      resolveConversationSessionWorkspaceForCreate({
        conversationRoot: root,
        createdAtMs,
        ...(occupiedDirectories === undefined ? {} : { occupiedDirectories }),
        sessionId: SESSION_ID,
        workspacePath: root,
      });

    // 缺省不传（现有行为 / 现有调用方）：同名真目录仍然复用 8 位。
    assert.equal(resolveName(undefined), "a1b2c3d4");
    // 占用集合不含它：那是本次会话自己的残留（重试 / 并发冷恢复）→ 仍复用 8 位，幂等不变。
    assert.equal(resolveName([join(dateDir, "ffffffff")]), "a1b2c3d4");
    assert.equal(resolveName([]), "a1b2c3d4");
    // 占用集合含它（同日另一个会话 id 撞了前 8 位）→ 回退 12 位，两个会话不共用目录。
    assert.equal(resolveName([shortPath]), "a1b2c3d45e6f");
    // 规范化比较：尾分隔符 / 相对写法不能漏判（漏判就是两个会话共用目录）。
    assert.equal(resolveName([`${shortPath}/`]), "a1b2c3d45e6f");
    assert.equal(resolveName([resolve(shortPath)]), "a1b2c3d45e6f");
    // 创建边界同一份判定：占用集合穿透到目录规划。
    assert.equal(createWorkspace([shortPath])?.directory, longPath);

    // 12 位被用户文件占位时拒绝创建，不能把会话 cwd 降级到共享根。
    await mkdir(dateDir, { recursive: true });
    await writeFile(longPath, "occupied by a file");
    assert.throws(
      () => resolveName([shortPath]),
      (error) => error instanceof ConversationSessionWorkspaceUnavailableError,
    );
    // 即使 12 位长名是另一个会话的真实目录，也必须拒绝，不能静默共用。
    const longCollisionId = "sess_a1b2c3d4-5e6f-9abc-8c9d-111111111111";
    assert.equal(buildConversationSessionDirName(longCollisionId, 12), "a1b2c3d45e6f");
    // 占用判定不要求目录此刻存在：占位者被手工删掉后，这个名字也不能被别的会话拿走
    // （否则两个会话仍然会落到同一个目录）。
    await rm(longPath);
    await mkdir(longPath);
    assert.throws(
      () =>
        resolveConversationSessionDirNameForCreate({
          conversationRoot: root,
          createdAtMs,
          occupiedDirectories: [shortPath, longPath],
          sessionId: longCollisionId,
        }),
      (error) => error instanceof ConversationSessionWorkspaceCollisionError,
    );
    await rm(longPath, { recursive: true, force: true });
    // 同一会话自己的长目录仍可幂等复用。
    await mkdir(longPath);
    assert.equal(resolveName([shortPath]), "a1b2c3d45e6f");
    await rm(longPath, { recursive: true, force: true });
    await rm(shortPath, { recursive: true, force: true });
    assert.equal(resolveName([shortPath]), "a1b2c3d45e6f");
  });
});

test("执行准入重建自有叶目录，并拒绝 nested cwd 的 symlink 祖先", async () => {
  await withRoot(async (root) => {
    const dateDir = join(root, "2026-10-11");
    const leaf = join(dateDir, "a1b2c3d4");
    const nested = join(leaf, "subproject");
    const guard = (executionWorkspacePath) =>
      ensureConversationSessionWorkspaceForExecution({
        conversationRoot: root,
        executionWorkspacePath,
        workspaceIdentity: undefined,
        workspacePath: root,
      });

    await mkdir(dateDir, { recursive: true });
    await guard(leaf);
    await assertPresent(leaf);
    await mkdir(nested);
    await guard(nested);

    // 派生会话执行根可为父 cd 后的深层路径；删掉后准入应重建，不必先做一次冷恢复。
    await rm(nested, { recursive: true });
    await guard(join(nested, "deeper"));
    await assertPresent(join(nested, "deeper"));
    await rm(dateDir, { recursive: true });
    await guard(join(nested, "deeper"));
    await assertPresent(join(nested, "deeper"));
    await assert.rejects(
      () => guard(join(root, "notes", "a1b2c3d4", "nested")),
      (error) => error instanceof ConversationSessionWorkspaceUnavailableError,
    );
    await assert.rejects(
      () => guard(join(root, "2026-10-11", "notes", "nested")),
      (error) => error instanceof ConversationSessionWorkspaceUnavailableError,
    );
    await assertMissing(join(root, "notes"));
    await assertMissing(join(dateDir, "notes"));

    await rm(dateDir, { recursive: true, force: true });
    const outside = join(root, "outside-date");
    await mkdir(outside);
    await symlink(outside, dateDir, "dir");
    await assert.rejects(
      () => guard(nested),
      (error) => error instanceof ConversationSessionWorkspaceUnavailableError,
    );
    await assertMissing(join(outside, "a1b2c3d4"));
  });
});

test("创建/恢复都刷新目录 mtime：清扫年龄门禁按「最近被动过」而不是创建时间", async () => {
  await withRoot(async (root) => {
    const directory = join(root, "2026-09-03", "a1b2c3d4");
    await ensureConversationSessionWorkspaceDir(directory);
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(directory, stale, stale);
    assert.ok(
      Date.now() - (await stat(directory)).mtimeMs > 20 * 24 * 60 * 60 * 1000,
      "fixture 必须先把 mtime 推旧",
    );
    // mkdir 对已存在的目录不改 mtime：不显式刷新的话，只用对话、没写过文件的在用目录
    // 会被启动清扫当成「建了 7 天没人动」删掉。
    await ensureConversationSessionWorkspaceDir(directory);
    assert.ok(Date.now() - (await stat(directory)).mtimeMs < 60_000, "重复 ensure 必须刷新 mtime");
  });
});

test("常驻会话的恢复也刷新目录 mtime：deferred 草稿的空目录不会被启动清扫当残留删掉", async () => {
  await withRoot(async (root) => {
    const dateDir = join(root, "2026-10-11");
    const touchedDir = join(dateDir, "a1b2c3d4");
    // 对照组：同样年龄、同样空，但这次「恢复」没有碰它（证明年龄门禁真的会删，而不是清扫没跑）。
    const controlDir = join(dateDir, "b2c3d4e5");
    await mkdir(touchedDir, { recursive: true });
    await mkdir(controlDir, { recursive: true });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(touchedDir, eightDaysAgo, eightDaysAgo);
    await utimes(controlDir, eightDaysAgo, eightDaysAgo);

    // 命中注册表的「恢复」走早退分支：不经过 resolveRecordExecutionWorkspacePath，因此必须自己
    // 刷新 mtime（规则 3）。deferred 草稿不落 sqlite ⇒ 不在清扫的在册集合里，只有 mtime 能救它。
    const record = { executionWorkspacePath: touchedDir };
    const warnings = [];
    const context = {
      deps: { env: { ZCODE_CONVERSATION_WORKSPACE_ROOT: root } },
      logger: { debug: () => {}, warn: (message, fields) => warnings.push([message, fields]) },
      sessions: new Map([[SESSION_ID, record]]),
    };
    const activated = await activateSessionForResume(context, { sessionId: SESSION_ID });
    assert.equal(activated.record, record, "常驻会话必须原样返回同一个 record");
    assert.ok(
      Date.now() - (await stat(touchedDir)).mtimeMs < 60_000,
      "常驻恢复必须刷新会话目录 mtime（否则 7 天没动过的活草稿目录会被别的进程扫掉）",
    );

    // 空在册集合 = 草稿形态（库里没有这一行）：年龄门禁是唯一还站着的守卫。
    const removed = await sweepEmptyConversationSessionDirs({
      conversationRoot: root,
      nowMs: Date.now(),
      sessionPathSource: createFakeSessionPathSource([]),
    });
    assert.equal(removed, 1, `清扫只应删掉对照组，实际 removed=${removed}`);
    await assertPresent(touchedDir);
    await assertMissing(controlDir);
    assert.deepEqual(warnings, []);
  });
});

test("常驻恢复的 mtime 刷新也过规则 8 门禁：日期段是活链接时不得把目录铸到对话根之外", async () => {
  await withRoot(async (root) => {
    // 占位形态：`<对话根>/<日期>` 被换成指向外部的活符号链接。touch 的幂等 mkdir 会**跟随**
    // 这层链接——常驻早退分支过去只有词法包含判定就直 mkdir，会把 `<id8>` 铸到对话根之外
    // （回收的 isRealDirectory 与清扫的 dirent.isDirectory 都不认，永不清理）。现在必须静默跳过。
    const dateDir = join(root, "2026-10-13");
    const outsideParent = await mkdtemp(join(tmpdir(), "zcode-outside-"));
    try {
      const outsideDir = join(outsideParent, "outside");
      await mkdir(outsideDir, { recursive: true });
      await rm(dateDir, { recursive: true, force: true });
      await symlink(outsideDir, dateDir, "dir");

      const record = { executionWorkspacePath: join(dateDir, "a1b2c3d4") };
      const warnings = [];
      const context = {
        deps: { env: { ZCODE_CONVERSATION_WORKSPACE_ROOT: root } },
        logger: { debug: () => {}, warn: (message, fields) => warnings.push([message, fields]) },
        sessions: new Map([[SESSION_ID, record]]),
      };
      await activateSessionForResume(context, { sessionId: SESSION_ID });

      // 关键断言：对话根之外不得出现会话目录（修复前 mkdir 跟随链接会把它建出来）。
      await assertMissing(join(outsideDir, "a1b2c3d4"));
      // 静默跳过，不产生 warn（touch 分支不做 cwd 裁决，mtime 略旧不是会话事件）。
      assert.deepEqual(warnings, []);
    } finally {
      await rm(outsideParent, { recursive: true, force: true });
    }
  });
});

test("裸 CLI/TUI 恢复的目录重建：缺失补建、坏占位拒绝，普通 IO 故障不抛", async () => {
  await withRoot(async (root) => {
    const sessionDir = join(root, "2026-10-13", "a1b2c3d4");
    const dateDir = join(root, "2026-10-13");

    // ① 行在、path 指向已被回收/手工删除的会话目录 ⇒ 幂等补建（含日期目录）。
    await ensureConversationSessionDirForBareResume({
      sessionId: SESSION_ID,
      store: {
        getSession: async () => ({ directory: root, path: sessionDir }),
        updateSession: async () => {
          throw new Error("must not write");
        },
      },
    });
    await assertPresent(sessionDir);

    // ② 占位（日期目录是活链接）⇒ 不跟随、不把目录铸到根外、记一条只带 reason 的 warn。
    const outsideParent = await mkdtemp(join(tmpdir(), "zcode-bare-resume-"));
    try {
      const outsideDir = join(outsideParent, "outside");
      await mkdir(outsideDir, { recursive: true });
      const dateDir2 = join(root, "2026-10-14");
      await rm(dateDir2, { recursive: true, force: true });
      await symlink(outsideDir, dateDir2, "dir");
      const warnings2 = [];
      await assert.rejects(
        () =>
          ensureConversationSessionDirForBareResume({
            logger: { warn: (message, fields) => warnings2.push([message, fields]) },
            sessionId: SESSION_ID,
            store: {
              getSession: async () => ({ directory: root, path: join(dateDir2, "a1b2c3d4") }),
              updateSession: async () => {
                throw new Error("must not write");
              },
            },
          }),
        ConversationSessionWorkspaceUnavailableError,
      );
      await assertMissing(join(outsideDir, "a1b2c3d4"));
      assert.equal(warnings2.length, 1);
      assert.match(warnings2[0][0], /not usable/u);
      assert.equal(warnings2[0][1].reason, "date_dir_unusable");
      assert.equal(warnings2[0][1].errorCode, undefined);
    } finally {
      await rm(outsideParent, { recursive: true, force: true });
    }

    // ③ 非本规则铸造的 path（= directory，项目工作区/存量形态）⇒ 不代建。
    await rm(sessionDir, { recursive: true, force: true });
    await rm(dateDir, { recursive: true, force: true });
    await ensureConversationSessionDirForBareResume({
      sessionId: SESSION_ID,
      store: { getSession: async () => ({ directory: root, path: root }) },
    });
    await assertMissing(dateDir);

    // ④ 拿不到行 / 端口缺席 / 查库抛错 ⇒ 静默；mkdir 失败 ⇒ 只记一条 warn，一律不抛。
    await ensureConversationSessionDirForBareResume({
      sessionId: SESSION_ID,
      store: { getSession: async () => null },
    });
    await ensureConversationSessionDirForBareResume({ sessionId: SESSION_ID, store: undefined });
    await ensureConversationSessionDirForBareResume({
      sessionId: SESSION_ID,
      store: {
        getSession: async () => {
          throw Object.assign(new Error("store unavailable"), { code: "SQLITE_BUSY" });
        },
      },
    });
    const logger = createRecordingLogger();
    // chmod 的目录权限语义只适用于非 root 的 POSIX；Windows 无法用 mode 位制造 EACCES。
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    // mkdir 自身失败（classify 判可用、mkdir 才暴露）：日期目录无写权限 ⇒ EACCES。
    await mkdir(dateDir, { recursive: true });
    await chmod(dateDir, 0o000);
    try {
      await ensureConversationSessionDirForBareResume({
        logger,
        sessionId: SESSION_ID,
        store: { getSession: async () => ({ directory: root, path: sessionDir }) },
      });
    } finally {
      await chmod(dateDir, 0o755);
    }
    assert.ok(
      logger.warnMessages.some((message) => /ensure failed/.test(message)),
      "mkdir 失败必须记一条只带 errorCode 的 warn",
    );
  });
});

test("创建边界：启用时落到 <根>/<创建日>/<会话id前8位>，目录创建幂等", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 9, 11, 9, 0, 0).getTime();
    const created = resolveConversationSessionWorkspaceForCreate({
      conversationRoot: root,
      createdAtMs,
      sessionId: SESSION_ID,
      workspacePath: root,
    });
    assert.equal(created?.directory, join(root, "2026-10-11", "a1b2c3d4"));
    assert.equal(created?.backfilled, false);
    await ensureConversationSessionWorkspaceDir(created.directory);
    await assertPresent(created.directory);
    // mkdir 幂等：重复创建不抛错、不换目录（草稿预热与首发都走这一条）。
    await ensureConversationSessionWorkspaceDir(created.directory);
    await assertPresent(created.directory);
    // 目录被手工删除后按同一路径重建（恢复路径依赖这条，不重新定名、不换日期）。
    await rm(created.directory, { recursive: true, force: true });
    await ensureConversationSessionWorkspaceDir(created.directory);
    await assertPresent(created.directory);
  });
});

test("创建边界：未启用独立目录规则时不接管（带 identity / 路径不等于对话根 / 无标记）", () => {
  const createdAtMs = new Date(2026, 9, 11, 9, 0, 0).getTime();
  const enabled = {
    conversationRoot: "/root/default",
    createdAtMs,
    sessionId: SESSION_ID,
    workspacePath: "/root/default",
  };
  assert.equal(resolveConversationSessionWorkspaceForCreate(enabled)?.backfilled, false);
  assert.equal(
    resolveConversationSessionWorkspaceForCreate({
      ...enabled,
      workspaceIdentity: "remote:ssh:host",
    }),
    undefined,
  );
  assert.equal(
    resolveConversationSessionWorkspaceForCreate({ ...enabled, workspacePath: "/root/project" }),
    undefined,
  );
  assert.equal(
    resolveConversationSessionWorkspaceForCreate({ ...enabled, conversationRoot: undefined }),
    undefined,
  );
});

// ── 日期目录可用性：定名之前必须确认 `<对话根>/<创建日>` 是真目录（或缺席） —─────────
// 旧实现只 `lstat` 最后一段 `<日期>/<id8>`：父目录被占住时子路径一律 ENOENT，被判成"名字空闲"，
// 于是普通文件 / 断链让当天所有会话 mkdir 报 ENOTDIR，活链接则把会话目录建到对话根之外
// （词法包含判定说"在根内"，回收与清扫却都拒绝这种中间链接，永不清理）。

test("创建边界：日期目录是悬空符号链接时不铸造目录，也不跟随链接", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 9, 11, 9, 0, 0).getTime();
    const dateDir = join(root, "2026-10-11");
    const linkTarget = join(root, "not-mounted-external-disk");
    await symlink(linkTarget, dateDir, "dir");
    assert.equal(isConversationSessionDateDirUsable(dateDir), false);
    const logger = createRecordingLogger();
    let resolution;
    assert.doesNotThrow(() => {
      resolution = resolveConversationSessionWorkspaceForCreate({
        conversationRoot: root,
        createdAtMs,
        logger,
        sessionId: SESSION_ID,
        workspacePath: root,
      });
    });
    // 返回 undefined ⇒ 调用方沿用旧行为 cwd = workspacePath；绝不在这里抛错。
    assert.equal(resolution, undefined);
    // 占位者是用户的东西：链接没被跟随、也没被修掉，链接目标处不产生任何东西。
    assert.equal((await lstat(dateDir)).isSymbolicLink(), true);
    await assertMissing(linkTarget);
    await assertMissing(join(dateDir, "a1b2c3d4"));
    assert.deepEqual(logger.warnContexts, [
      { reason: CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON },
    ]);
  });
});

test("创建边界：日期目录是普通文件时不铸造目录（当天所有会话都会 ENOTDIR）", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 9, 11, 9, 0, 0).getTime();
    const dateDir = join(root, "2026-10-11");
    await writeFile(dateDir, "occupied by a user file");
    assert.equal(isConversationSessionDateDirUsable(dateDir), false);
    const logger = createRecordingLogger();
    let resolution;
    assert.doesNotThrow(() => {
      resolution = resolveConversationSessionWorkspaceForCreate({
        conversationRoot: root,
        createdAtMs,
        logger,
        sessionId: SESSION_ID,
        workspacePath: root,
      });
    });
    assert.equal(resolution, undefined);
    // 文件既没被删也没被改成目录，对话根下没有多出任何条目。
    assert.equal(await readFile(dateDir, "utf8"), "occupied by a user file");
    assert.deepEqual(await readdir(root), ["2026-10-11"]);
    assert.deepEqual(logger.warnContexts, [
      { reason: CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON },
    ]);
  });
});

test("创建边界：日期目录是指向真目录的符号链接时不使用它，也不在链接目标里建目录", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 9, 11, 9, 0, 0).getTime();
    const linkTarget = await mkdtemp(join(tmpdir(), "zcode-date-dir-target-"));
    const dateDir = join(root, "2026-10-11");
    try {
      await symlink(linkTarget, dateDir, "dir");
      assert.equal(isConversationSessionDateDirUsable(dateDir), false);
      const logger = createRecordingLogger();
      let resolution;
      assert.doesNotThrow(() => {
        resolution = resolveConversationSessionWorkspaceForCreate({
          conversationRoot: root,
          createdAtMs,
          logger,
          sessionId: SESSION_ID,
          workspacePath: root,
        });
      });
      assert.equal(resolution, undefined);
      // 旧实现会经链接把 `<id8>` 建到目标目录里（对话根之外）；这里断言目标目录仍然为空。
      assert.deepEqual(await readdir(linkTarget), []);
      assert.equal((await lstat(dateDir)).isSymbolicLink(), true);
      assert.deepEqual(logger.warnContexts, [
        { reason: CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON },
      ]);
    } finally {
      await rm(linkTarget, { recursive: true, force: true });
    }
  });
});

test("恢复边界：复用持久化 path，日期不按当前时间重算", () => {
  const persistedPath = "/root/default/2026-10-11/a1b2c3d4";
  const resumed = resolveConversationSessionWorkspaceForResume({
    conversationRoot: "/root/default",
    // 跨零点：恢复发生在次日，但执行 cwd 仍必须是持久化路径。
    createdAtMs: new Date(2026, 9, 12, 0, 5, 0).getTime(),
    persistedDirectory: "/root/default",
    persistedPath,
    sessionId: SESSION_ID,
    workspacePath: "/root/default",
  });
  assert.equal(resumed?.directory, resolve(persistedPath));
  assert.equal(resumed?.backfilled, false);
});

test("恢复边界：目录不存在不影响 cwd 判定，mkdir 按同一路径重建", async () => {
  await withRoot(async (root) => {
    // 判定是纯路径计算、不查文件系统：目录被手工删除时也必须复用持久化 cwd，
    // 不能因为「目录缺失」就回落到对话根。
    const persistedPath = join(root, "2026-10-11", "a1b2c3d4");
    const resolved = resolveConversationSessionWorkspaceForResume({
      conversationRoot: root,
      createdAtMs: new Date(2026, 9, 12).getTime(),
      persistedDirectory: root,
      persistedPath,
      sessionId: SESSION_ID,
      workspacePath: root,
    });
    assert.equal(resolved?.directory, persistedPath);
    assert.equal(resolved?.backfilled, false);
    await assertMissing(persistedPath);
    // mkdir 幂等重建同一个目录（含中间日期目录），不重新定名。
    await ensureConversationSessionWorkspaceDir(resolved.directory);
    await assertPresent(persistedPath);
    assert.equal(
      resolveConversationSessionWorkspaceForResume({
        conversationRoot: root,
        createdAtMs: new Date(2026, 9, 13).getTime(),
        persistedDirectory: root,
        persistedPath,
        sessionId: SESSION_ID,
        workspacePath: root,
      })?.directory,
      persistedPath,
    );
  });
});

test("恢复边界：存量会话（path 仍是对话根 / 缺 path）补发，日期取会话自身创建日", () => {
  const createdAtMs = new Date(2026, 8, 3, 8, 30, 0).getTime();
  const stock = resolveConversationSessionWorkspaceForResume({
    conversationRoot: "/root/default",
    createdAtMs,
    persistedDirectory: "/root/default",
    persistedPath: "/root/default",
    sessionId: SESSION_ID,
    workspacePath: "/root/default",
  });
  assert.equal(stock?.directory, resolve("/root/default", "2026-09-03", "a1b2c3d4"));
  assert.equal(stock?.backfilled, true);
  // 旧记录只有 directory、没有 path：同样按存量补发，且不能被当成「已有执行 cwd」。
  const legacy = resolveConversationSessionWorkspaceForResume({
    conversationRoot: "/root/default",
    createdAtMs,
    persistedDirectory: "/root/default",
    persistedPath: undefined,
    sessionId: SESSION_ID,
    workspacePath: "/root/default",
  });
  assert.equal(legacy?.directory, resolve("/root/default", "2026-09-03", "a1b2c3d4"));
  assert.equal(legacy?.backfilled, true);
});

test("恢复/补发边界：日期目录不可用时不补发、不建目录、不写 path（回退旧行为）", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 8, 3, 8, 30, 0).getTime();
    const dateDir = join(root, "2026-09-03");
    await writeFile(dateDir, "occupied by a user file");
    const logger = createRecordingLogger();
    const store = createFakeSessionStore({ directory: root, path: root, updatedAt: 1234 });
    // ① 存量补发分支（`path` 仍等于对话根）：铸造新目录之前必须先确认日期目录可用，
    // 否则补发的 mkdir 报 ENOTDIR（或跟着链接写到根外）。
    const planned = resolveConversationSessionWorkspaceForResume({
      conversationRoot: root,
      createdAtMs,
      logger,
      persistedDirectory: store.row.directory,
      persistedPath: store.row.path,
      sessionId: SESSION_ID,
      workspacePath: root,
    });
    assert.equal(planned, undefined);
    // 调用方契约：undefined ⇒ 沿用旧行为 `cwd = workspacePath`，补发落盘拿不到可写目录。
    // 这里**无条件**调用落盘（解析被拒时传它本来会用的那个路径），断言它必须拒绝且一个字节都
    // 不写：早先版本用 `if (planned)` 包住这段调用，而上一行已经断言 `planned === undefined`，
    // 于是补发根本没被执行——「行不变」的三条断言恒真，删掉整个 if 块测试照样绿。
    const persistOutcome = await persistConversationSessionBackfillDirectory({
      directory: planned?.directory ?? join(dateDir, "a1b2c3d4"),
      sessionId: SESSION_ID,
      store,
      timeUpdated: store.row.timeUpdated,
    });
    assert.equal(
      persistOutcome.status,
      "unavailable",
      `日期目录被非目录占位时补发落盘必须拒绝，实际: ${JSON.stringify(persistOutcome)}`,
    );
    // reason 必须精确定位到「建目录失败」：`store_unavailable` / `path_missing` 同样是
    // `unavailable`，只断言 status 的话这条用例可能在补发压根没跑的情况下变绿。
    // 错误码不参与断言（Windows 的 mkdir-under-file 是 ENOENT，POSIX 是 ENOTDIR）。
    assert.equal(persistOutcome.reason, "write_failed");
    assert.ok(persistOutcome.error, "建目录失败必须带上原始错误");
    assert.equal(store.row.path, root);
    assert.equal(store.row.directory, root);
    assert.equal(store.row.timeUpdated, 1234);
    // ② 复用分支（持久化 `path` 落在对话根下）：调用方随后会对这个 cwd 幂等 mkdir，
    // 同一个坏日期目录会让它 ENOTDIR 或写到根外，因此复用分支也必须拒绝。
    const persistedPath = join(dateDir, "a1b2c3d4");
    assert.equal(
      resolveConversationSessionWorkspaceForResume({
        conversationRoot: root,
        createdAtMs,
        logger,
        persistedDirectory: root,
        persistedPath,
        sessionId: SESSION_ID,
        workspacePath: root,
      }),
      undefined,
    );
    // 日期目录仍是那个文件，对话根下没有多出任何条目（`stat` 在这里是 ENOTDIR 而不是 ENOENT，
    // 因此直接查父目录的条目而不是复用 assertMissing）。
    assert.equal((await lstat(dateDir)).isFile(), true);
    assert.deepEqual(await readdir(root), ["2026-09-03"]);
    // 两次判定各一条 warn，都只带稳定原因、不带真实路径。
    assert.deepEqual(logger.warnContexts, [
      { reason: CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON },
      { reason: CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON },
    ]);
  });
});

test("恢复边界：不劫持对话根之外的持久化路径，未启用时返回 undefined", () => {
  const base = {
    conversationRoot: "/root/default",
    createdAtMs: new Date(2026, 9, 11).getTime(),
    persistedDirectory: "/root/project",
    persistedPath: "/root/project",
    sessionId: SESSION_ID,
    workspacePath: "/root/default",
  };
  // 项目工作区的会话被带进对话根请求时，不能改写到对话根目录树。
  assert.equal(resolveConversationSessionWorkspaceForResume(base), undefined);
  assert.equal(
    resolveConversationSessionWorkspaceForResume({
      ...base,
      persistedDirectory: "/root/default",
      persistedPath: "/root/default/../project",
      workspacePath: "/root/project",
    }),
    undefined,
  );
  assert.equal(
    resolveConversationSessionWorkspaceForResume({
      ...base,
      persistedDirectory: "/root/default",
      persistedPath: "/root/default",
      workspaceIdentity: "remote:ssh:host",
      workspacePath: "/root/default",
    }),
    undefined,
  );
});

test("派生会话：父会话执行 cwd 存在时继承同一个目录，缺席时不推断", () => {
  const parentExecutionWorkspacePath = "/root/default/2026-10-11/a1b2c3d4";
  assert.equal(
    resolveConversationSessionWorkspaceInherited(parentExecutionWorkspacePath),
    resolve(parentExecutionWorkspacePath),
  );
  // 存量父会话（尚未补发）没有内存事实：返回 undefined，由调用方走持久化行判定，
  // 不允许在这里按会话 id 另造一个目录。
  assert.equal(resolveConversationSessionWorkspaceInherited(undefined), undefined);
  assert.equal(resolveConversationSessionWorkspaceInherited("   "), undefined);
});

test("派生会话继承复核父目录占位，不跟随链接并保留降级落盘路径", async () => {
  await withRoot(async (root) => {
    const dateDir = join(root, "2026-10-11");
    const directory = join(dateDir, "a1b2c3d4");
    await mkdir(directory, { recursive: true });
    assert.equal(resolveConversationSessionWorkspaceInherited(directory, root), directory);
    await rm(directory, { recursive: true });
    await writeFile(directory, "user-owned");
    assert.equal(resolveConversationSessionWorkspaceInherited(directory, root), undefined);
    // 旧宿主没有启用根标记时，不新增文件系统裁决，沿用持久化路径。
    assert.equal(resolveConversationSessionWorkspaceInherited(directory), directory);
    assert.equal(await readFile(directory, "utf8"), "user-owned");
    await rm(directory);
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, directory, "dir");
    assert.equal(resolveConversationSessionWorkspaceInherited(directory, root), undefined);
    assert.deepEqual(await readdir(outside), []);
    assert.equal((await lstat(directory)).isSymbolicLink(), true);
    // 继承被拒后仍由既有 resume 判据裁决子行，让 registerForkedSession 走降级落盘。
    assert.equal(
      resolveConversationSessionWorkspaceForResume({
        conversationRoot: root,
        workspacePath: root,
        persistedPath: directory,
        sessionId: SESSION_ID,
        createdAtMs: Date.now(),
      }),
      undefined,
    );
    await rm(directory);
    await rm(dateDir, { recursive: true });
    await symlink(outside, dateDir, "dir");
    assert.equal(resolveConversationSessionWorkspaceInherited(directory, root), undefined);
    assert.deepEqual(await readdir(outside), []);
  });
});

test("存量补发必须落盘：只改 path、第二次恢复走复用分支", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 8, 3, 8, 30, 0).getTime();
    const store = createFakeSessionStore({ directory: root, path: root, updatedAt: 1234 });
    const backfilled = resolveConversationSessionWorkspaceForResume({
      conversationRoot: root,
      createdAtMs,
      persistedDirectory: store.row.directory,
      persistedPath: store.row.path,
      sessionId: SESSION_ID,
      workspacePath: root,
    });
    assert.equal(backfilled?.backfilled, true);

    const persisted = await persistConversationSessionBackfillDirectory({
      directory: backfilled.directory,
      sessionId: SESSION_ID,
      store,
      timeUpdated: store.row.timeUpdated,
    });
    const expectedDirectory = join(root, "2026-09-03", "a1b2c3d4");
    assert.equal(persisted.status, "available");
    assert.equal(persisted.applied, true);
    assert.equal(persisted.directory, expectedDirectory);
    // 落盘事实：path = 会话目录，directory 仍是对话根，活动时间不被顶新（维护性写入）。
    assert.equal(store.row.path, expectedDirectory);
    assert.equal(store.row.directory, root);
    assert.equal(store.row.timeUpdated, 1234);
    await assertPresent(expectedDirectory);

    // 一次性：第二次恢复（哪怕跨到另一天）走复用分支，不再补发、不重算日期。
    const second = resolveConversationSessionWorkspaceForResume({
      conversationRoot: root,
      createdAtMs: new Date(2026, 8, 5, 1, 0, 0).getTime(),
      persistedDirectory: store.row.directory,
      persistedPath: store.row.path,
      sessionId: SESSION_ID,
      workspacePath: root,
    });
    assert.equal(second?.backfilled, false);
    assert.equal(second?.directory, expectedDirectory);
  });
});

test("补发落盘失败时不得分叉：用不了补发目录就回退对话根，下次仍会补发", async () => {
  await withRoot(async (root) => {
    const backfillDirectory = join(root, "2026-09-03", "a1b2c3d4");
    // 1) 没有会话库（理论上到不了这里，但契约要明确失败而不是假装成功）。
    const noStore = await persistConversationSessionBackfillDirectory({
      directory: backfillDirectory,
      sessionId: SESSION_ID,
      store: undefined,
    });
    assert.equal(noStore.status, "unavailable");
    assert.equal(noStore.reason, "store_unavailable");
    // 2) 写库抛错（锁/磁盘）：返回 unavailable 且行保持对话根 → 调用方回退 cwd = workspacePath。
    const throwingStore = {
      getSession: async () => ({ directory: root, path: root }),
      updateSession: async () => {
        throw new Error("database is locked");
      },
    };
    const writeFailed = await persistConversationSessionBackfillDirectory({
      directory: backfillDirectory,
      sessionId: SESSION_ID,
      store: throwingStore,
    });
    assert.equal(writeFailed.status, "unavailable");
    assert.equal(writeFailed.reason, "write_failed");
    assert.match(String(writeFailed.error?.message), /locked/u);
    // 3) 写库静默不生效（被并发写覆盖）：以重读值为准，绝不认内存里的补发结果。
    const notAppliedStore = {
      getSession: async () => ({ directory: root, path: root }),
      updateSession: async () => ({ directory: root, path: root }),
    };
    const notApplied = await persistConversationSessionBackfillDirectory({
      directory: backfillDirectory,
      sessionId: SESSION_ID,
      store: notAppliedStore,
    });
    assert.equal(notApplied.status, "available");
    assert.equal(notApplied.applied, false);
    // 关键：cwd 取重读值（对话根）而不是补发目录 ⇒ runtime 与库仍然一致。
    assert.equal(notApplied.directory, root);
    // 行仍等于对话根 ⇒ 下次恢复的判定仍是「补发」，会再试一次。
    assert.equal(
      resolveConversationSessionWorkspaceForResume({
        conversationRoot: root,
        createdAtMs: new Date(2026, 8, 3).getTime(),
        persistedDirectory: root,
        persistedPath: root,
        sessionId: SESSION_ID,
        workspacePath: root,
      })?.backfilled,
      true,
    );
  });
});

test("补发写库失败时不回收目录（所有权判据不精确）：重试仍落在同一个 8 位目录", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 8, 3, 10, 0, 0).getTime();
    const firstPlan = resolveConversationSessionWorkspaceForResume({
      conversationRoot: root,
      createdAtMs,
      persistedDirectory: root,
      persistedPath: root,
      sessionId: SESSION_ID,
      workspacePath: root,
    });
    assert.equal(firstPlan?.backfilled, true);
    const throwingStore = {
      getSession: async () => ({ directory: root, path: root }),
      updateSession: async () => {
        throw new Error("database is locked");
      },
    };
    const failed = await persistConversationSessionBackfillDirectory({
      directory: firstPlan.directory,
      sessionId: SESSION_ID,
      store: throwingStore,
    });
    assert.equal(failed.status, "unavailable");
    // 关键：失败路径**不能** rmdir。`stat` 与 `mkdir` 之间不原子，「我查看时它不存在」不等于
    // 「它是我建出来的」——两个进程并发冷恢复同一个存量会话时，后 stat 的一方会把对方刚建出的空
    // 目录删掉，那个进程下一次相对写入即 ENOENT。误删的代价高于留一个空目录。
    await assertPresent(firstPlan.directory);
    // 残留无害：定名对同一会话幂等（同名真目录一律复用），重试仍落在同一个名字上；真没人要的
    // 空目录由启动清扫的 7 天年龄门禁兜底。
    const retried = resolveConversationSessionWorkspaceForResume({
      conversationRoot: root,
      createdAtMs,
      persistedDirectory: root,
      persistedPath: root,
      sessionId: SESSION_ID,
      workspacePath: root,
    });
    assert.equal(retried?.backfilled, true);
    assert.equal(retried?.directory, firstPlan.directory, "补发重试必须落在同一个目录");

    // 目录里有文件时同样原样保留（回收从来只针对空目录，失败补偿也一样）。
    await writeFile(join(firstPlan.directory, "agent-output.txt"), "keep");
    const secondFailure = await persistConversationSessionBackfillDirectory({
      directory: firstPlan.directory,
      sessionId: SESSION_ID,
      store: throwingStore,
    });
    assert.equal(secondFailure.status, "unavailable");
    await stat(join(firstPlan.directory, "agent-output.txt"));
  });
});

test("补发读回拿不到 path 时同样不回收目录（失败分支一致）", async () => {
  await withRoot(async (root) => {
    const createdAtMs = new Date(2026, 8, 3, 10, 0, 0).getTime();
    const plan = resolveConversationSessionWorkspaceForResume({
      conversationRoot: root,
      createdAtMs,
      persistedDirectory: root,
      persistedPath: root,
      sessionId: SESSION_ID,
      workspacePath: root,
    });
    assert.equal(plan?.backfilled, true);
    // 写库成功但读回没有 path（库关闭 / 行被并发删掉）：同样是"补发没落进库"，失败分支与上面一致。
    const store = {
      getSession: async () => ({ directory: root, path: undefined }),
      updateSession: async () => ({ id: SESSION_ID, directory: root, path: plan.directory }),
    };
    const outcome = await persistConversationSessionBackfillDirectory({
      directory: plan.directory,
      sessionId: SESSION_ID,
      store,
    });
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.reason, "path_missing");
    await assertPresent(plan.directory);
    const retried = resolveConversationSessionWorkspaceForResume({
      conversationRoot: root,
      createdAtMs,
      persistedDirectory: root,
      persistedPath: root,
      sessionId: SESSION_ID,
      workspacePath: root,
    });
    assert.equal(retried?.directory, plan.directory, "重试必须落在同一个目录");
  });
});

/**
 * 恢复/派生边界的兜底裁决（第五轮回归的收口）。
 *
 * `resolveConversationSessionWorkspaceForResume` 返回 undefined 有两种含义，调用方必须分开：
 * - **本规则不适用**（未注入标记的旧宿主 / 回滚态 / 项目工作区 / 远端）：core 冷恢复无论如何都按
 *   库里的 `path` 取 cwd，协议层必须同口径，否则 UI 快照回落对话根、看到的目录不是 Agent 真正
 *   落盘的地方；
 * - **规则适用但被拒**（`<对话根>/<日期>` 被文件/符号链接占位）：这里必须返回 undefined 让调用方
 *   降级到工作区键路径。回归形态是内联的 `?? (isPersistedConversationExecutionPath(...) ?
 *   session.path : undefined)` 把刚被拒的路径又捞了回来：`createRecord` 的 provided 分支随后
 *   `mkdir`，日期目录是文件时抛 ENOTDIR（`session/resume` 整体失败），是符号链接时跟着链接把会话
 *   目录建到对话根之外（词法说在根内，回收与清扫都不认）。见 E2E A10/A11。
 */
test("兜底裁决：规则适用时不得沿用已被拒的持久化路径，规则不适用时按它回落", () => {
  const root = resolve("/home/dev/.zcodium/workspace/default");
  const sessionDir = join(root, "2026-10-11", "a1b2c3d4");
  const projectDir = resolve("/home/dev/projects/demo");

  // 规则适用（有标记且路径等于对话根）+ 行里就是本规则的会话目录 ⇒ 不沿用（降级由调用方写回）。
  assert.equal(
    resolvePersistedConversationExecutionFallback({
      conversationRoot: root,
      persistedPath: sessionDir,
      workspacePath: root,
    }),
    undefined,
  );
  // 规则适用 + 存量行（path = 对话根）⇒ 也不沿用（它本来就不等于会话目录）。
  assert.equal(
    resolvePersistedConversationExecutionFallback({
      conversationRoot: root,
      persistedPath: root,
      workspacePath: root,
    }),
    undefined,
  );
  // 带 identity（远端）⇒ `isConversationWorkspaceEnabled` 为假 = 不适用本规则，与「未注入标记」
  // 同一支：core 同样只用库里的 path，沿用才同口径。健康远端会话的 `path` 恒等于工作区键路径
  // （`isPersistedConversationExecutionPath` 为假），因此这一支实际到不了「严格在根之下」的形态。
  assert.equal(
    resolvePersistedConversationExecutionFallback({
      conversationRoot: root,
      persistedPath: sessionDir,
      workspaceIdentity: "remote:wsl://dev/home",
      workspacePath: root,
    }),
    sessionDir,
  );
  // 规则不适用（未注入标记）+ 行里已是本规则铸造的会话目录（严格落在工作区键路径之下）⇒ 沿用，
  // core 冷恢复只会用库里的 path，协议层必须同口径。
  assert.equal(
    resolvePersistedConversationExecutionFallback({
      conversationRoot: undefined,
      persistedPath: sessionDir,
      workspacePath: root,
    }),
    sessionDir,
  );
  // 规则不适用 + 行里的路径就是工作区键路径本身（存量）⇒ 不沿用（等于没独立目录）。
  assert.equal(
    resolvePersistedConversationExecutionFallback({
      conversationRoot: undefined,
      persistedPath: root,
      workspacePath: root,
    }),
    undefined,
  );
  // 规则不适用 + 路径在本次工作区键路径之外（别的 workspace 的同 id 旧行）⇒ 不沿用。
  assert.equal(
    resolvePersistedConversationExecutionFallback({
      conversationRoot: undefined,
      persistedPath: join(projectDir, "2026-10-11", "a1b2c3d4"),
      workspacePath: projectDir,
    }),
    join(projectDir, "2026-10-11", "a1b2c3d4"),
  );
  assert.equal(
    resolvePersistedConversationExecutionFallback({
      conversationRoot: undefined,
      persistedPath: sessionDir,
      workspacePath: projectDir,
    }),
    undefined,
  );
  // 判据与 `isPersistedConversationExecutionPath` 同源（严格在根之下、不等于根）。
  assert.equal(isPersistedConversationExecutionPath(sessionDir, root), true);
  assert.equal(isPersistedConversationExecutionPath(root, root), false);
  assert.equal(isPersistedConversationExecutionPath(undefined, root), false);
});

/**
 * 创建侧复用一支的门禁（第七轮回归的收口）。
 *
 * 导入类创建带 `sessionId` 重放时，行里的 `path` 会被当作 provided 直接 `mkdir`：provided 分支不过
 * 「日期目录可用性」这道门，于是坏掉的日期目录会在**创建**边界重演规则 8 的两种结局——普通文件 ⇒
 * `mkdir` ENOTDIR（整个创建失败），活链接 ⇒ 跟随链接把目录建到对话根之外（回收与清扫都不认）。
 * E2E A12/A13 覆盖真实链路，这里把判据矩阵钉住。
 */
test("创建侧复用门禁：会话目录要过日期目录可用性，其余持久化路径一律可复用", async () => {
  await withRoot(async (root) => {
    const dateDir = join(root, "2026-10-11");
    const sessionDir = join(dateDir, "a1b2c3d4");
    await mkdir(sessionDir, { recursive: true });
    // 日期目录可用（或缺席，会由 mkdir 建出）⇒ 可复用。
    assert.equal(
      isReusablePersistedConversationExecutionPath({
        conversationRoot: root,
        persistedPath: sessionDir,
      }),
      true,
    );
    assert.equal(
      isReusablePersistedConversationExecutionPath({
        conversationRoot: root,
        persistedPath: join(root, "2026-12-31", "ffffffff"),
      }),
      true,
    );
    // 不归本规则的持久化路径（项目工作区 / 远端）没有日期目录这一层：不拦。
    assert.equal(
      isReusablePersistedConversationExecutionPath({
        conversationRoot: root,
        persistedPath: join(root, "..", "projects", "demo", "sub"),
      }),
      true,
    );
    assert.equal(
      isReusablePersistedConversationExecutionPath({ conversationRoot: root, persistedPath: root }),
      true,
    );
    // 缺席 / 空白：没有可复用的事实。
    assert.equal(
      isReusablePersistedConversationExecutionPath({
        conversationRoot: root,
        persistedPath: undefined,
      }),
      false,
    );
    assert.equal(
      isReusablePersistedConversationExecutionPath({
        conversationRoot: root,
        persistedPath: "   ",
      }),
      false,
    );

    // 普通文件占位 ⇒ 不可复用（否则整次导入创建以 ENOTDIR 失败）。
    await rm(sessionDir, { recursive: true, force: true });
    await rm(dateDir, { recursive: true, force: true });
    await writeFile(dateDir, "not a directory");
    assert.equal(
      isReusablePersistedConversationExecutionPath({
        conversationRoot: root,
        persistedPath: sessionDir,
      }),
      false,
    );

    // 活链接占位 ⇒ 同样不可复用（否则 mkdir 跟随链接把目录建到对话根之外）。
    const outside = join(root, "..", `outside-${basename(root)}`);
    await mkdir(outside, { recursive: true });
    await rm(dateDir, { recursive: true, force: true });
    await symlink(outside, dateDir, "dir");
    assert.equal(
      isReusablePersistedConversationExecutionPath({
        conversationRoot: root,
        persistedPath: sessionDir,
      }),
      false,
    );

    // 悬空链接占位 ⇒ 也不可复用（`existsSync` 会跟随链接把断链判成"不存在"，必须 lstat 语义）。
    await rm(dateDir, { recursive: true, force: true });
    await symlink(join(root, "..", "missing-target"), dateDir, "dir");
    assert.equal(
      isReusablePersistedConversationExecutionPath({
        conversationRoot: root,
        persistedPath: sessionDir,
      }),
      false,
    );
    await rm(outside, { recursive: true, force: true });

    // 日录目录健康、**会话目录自身**被占位：同一道门必须也覆盖最后一层。恢复/导入复用的 provided
    // 分支随后会对这个路径直接 `mkdir`，末段是文件 ⇒ EEXIST（整次恢复/导入失败），是活链接 ⇒
    // 跟随链接把会话跑在对话根之外（回收与清扫都不认）。E2E A14/A15 覆盖真实恢复链路。
    await rm(dateDir, { recursive: true, force: true });
    await mkdir(dateDir, { recursive: true });
    await writeFile(sessionDir, "not a directory");
    assert.equal(
      isReusablePersistedConversationExecutionPath({
        conversationRoot: root,
        persistedPath: sessionDir,
      }),
      false,
    );
    await rm(sessionDir, { force: true });
    const outsideLeaf = join(root, "..", `outside-leaf-${basename(root)}`);
    await mkdir(outsideLeaf, { recursive: true });
    await symlink(outsideLeaf, sessionDir, "dir");
    assert.equal(
      isReusablePersistedConversationExecutionPath({
        conversationRoot: root,
        persistedPath: sessionDir,
      }),
      false,
    );
    // 真目录仍然复用（幂等命名：重试/并发恢复看到的是自己上一次的目录）。
    await rm(sessionDir, { force: true });
    await mkdir(sessionDir, { recursive: true });
    assert.equal(
      isReusablePersistedConversationExecutionPath({
        conversationRoot: root,
        persistedPath: sessionDir,
      }),
      true,
    );
    await rm(outsideLeaf, { recursive: true, force: true });
  });
});

test("会话删除边界：空目录被回收且不留空日期目录，含文件的目录保留", async () => {
  await withRoot(async (root) => {
    const emptyDir = join(root, "2026-10-11", "a1b2c3d4");
    await mkdir(emptyDir, { recursive: true });
    assert.equal(
      await reclaimEmptyConversationSessionDir({ directory: emptyDir, conversationRoot: root }),
      true,
    );
    await assertMissing(emptyDir);
    await assertMissing(join(root, "2026-10-11"));

    const usedDir = join(root, "2026-10-12", "b2c3d4e5");
    await mkdir(usedDir, { recursive: true });
    await writeFile(join(usedDir, "notes.md"), "keep me");
    assert.equal(
      await reclaimEmptyConversationSessionDir({ directory: usedDir, conversationRoot: root }),
      false,
    );
    await assertPresent(usedDir);
    await assertPresent(join(root, "2026-10-12"));
  });
});

test("启动清扫只删除超过 7 天的空目录，非日期目录与非空目录都不动", async () => {
  await withRoot(async (root) => {
    const now = Date.now();
    const oldEmpty = join(root, "2026-01-01", "aaaaaaaa");
    const freshEmpty = join(root, "2026-01-02", "bbbbbbbb");
    const oldUsed = join(root, "2026-01-03", "cccccccc");
    const oldOther = join(root, "not-a-date-dir");
    for (const dir of [oldEmpty, freshEmpty, oldUsed, oldOther]) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(join(oldUsed, "artifact.txt"), "keep");
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
    for (const dir of [
      oldEmpty,
      oldUsed,
      oldOther,
      join(root, "2026-01-01"),
      join(root, "2026-01-03"),
      freshEmpty,
      join(root, "2026-01-02"),
    ]) {
      await utimes(dir, eightDaysAgo, eightDaysAgo);
    }
    // freshEmpty 的 mtime 单独恢复为「刚刚」，验证年龄门禁而不是目录名。
    const justNow = new Date(now);
    await utimes(freshEmpty, justNow, justNow);
    assert.equal(
      await sweepEmptyConversationSessionDirs({
        conversationRoot: root,
        nowMs: now,
        sessionPathSource: createFakeSessionPathSource(),
      }),
      1,
    );
    await assertMissing(oldEmpty);
    await assertMissing(join(root, "2026-01-01"));
    await assertPresent(freshEmpty);
    await assertPresent(oldUsed);
    await assertPresent(oldOther);
  });
});

test("启动清扫：只删本规则命名的空目录（8 / 12 位小写十六进制），用户自建目录与日期目录不碰", async () => {
  await withRoot(async (root) => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
    // 用户/模型自建的空目录：名字不是会话 id 派生的形状（非十六进制名、10 位、大写），
    // 年龄再老也不属于本规则，清扫无权删——删除边界本来就要求名字由会话 id 派生。
    const userDateDir = join(root, "2026-01-05");
    const userNotes = join(userDateDir, "notes");
    const tenHex = join(userDateDir, "a1b2c3d4e5");
    const upperHex = join(userDateDir, "A1B2C3D4");
    // 本规则铸造的两种形状：8 位与 12 位小写十六进制。
    const sessionDateDir = join(root, "2026-01-06");
    const shortHex = join(sessionDateDir, "aaaaaaaa");
    const longHex = join(sessionDateDir, "bbbbbbbbbbbb");
    for (const dir of [userNotes, tenHex, upperHex, shortHex, longHex]) {
      await mkdir(dir, { recursive: true });
    }
    for (const dir of [
      userNotes,
      tenHex,
      upperHex,
      userDateDir,
      shortHex,
      longHex,
      sessionDateDir,
    ]) {
      await utimes(dir, eightDaysAgo, eightDaysAgo);
    }
    assert.equal(
      await sweepEmptyConversationSessionDirs({
        conversationRoot: root,
        nowMs: now,
        sessionPathSource: createFakeSessionPathSource(),
      }),
      2,
    );
    await assertMissing(shortHex);
    await assertMissing(longHex);
    // 非本规则命名的一律保留；日期目录里还有内容，因此也不删。
    await assertPresent(userNotes);
    await assertPresent(tenHex);
    await assertPresent(upperHex);
    await assertPresent(userDateDir);
    // 两个会话目录删光后日期目录随之变空，仍按既有规则回收。
    await assertMissing(sessionDateDir);
  });
});

test("启动清扫：在册会话的执行目录即使空且超期也不删，同批不在册残留照旧回收", async () => {
  await withRoot(async (root) => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
    const dateDir = join(root, "2026-01-01");
    // 另一个 CLI 进程 7 天前激活后一直开着：目录空、mtime 停在那一刻，年龄上完全像残留。
    const registeredDir = join(dateDir, "aaaaaaaa");
    const orphanDir = join(dateDir, "bbbbbbbb");
    await mkdir(registeredDir, { recursive: true });
    await mkdir(orphanDir, { recursive: true });
    for (const dir of [registeredDir, orphanDir, dateDir]) {
      await utimes(dir, eightDaysAgo, eightDaysAgo);
    }
    // 会话库里有它的 path ⇒ 仍被使用 ⇒ 不删；日期目录因此没变空，也不删。
    const source = createFakeSessionPathSource([{ path: registeredDir }]);
    assert.equal(
      await sweepEmptyConversationSessionDirs({
        conversationRoot: root,
        nowMs: now,
        sessionPathSource: source,
      }),
      1,
    );
    await assertPresent(registeredDir);
    await assertPresent(dateDir);
    await assertMissing(orphanDir);
  });
});

test("启动清扫：在册判定不依赖 directory 过滤（工作区键路径形态不同也认）", async () => {
  await withRoot(async (root) => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
    const dateDir = join(root, "2026-01-01");
    const registeredDir = join(dateDir, "aaaaaaaa");
    await mkdir(registeredDir, { recursive: true });
    for (const dir of [registeredDir, dateDir]) {
      await utimes(dir, eightDaysAgo, eightDaysAgo);
    }
    // 行里的 directory 与传入的 conversationRoot 只是形态不同（尾分隔符）。清扫若用 directory
    // 精确过滤，这一行会被静默漏掉 → 目录被删、守卫静默失效且没有任何报错；因此查询只能取全表。
    const source = createFakeSessionPathSource([{ directory: `${root}/`, path: registeredDir }]);
    assert.equal(
      await sweepEmptyConversationSessionDirs({
        conversationRoot: root,
        nowMs: now,
        sessionPathSource: source,
      }),
      0,
    );
    await assertPresent(registeredDir);
    assert.deepEqual(source.inputs, [{ includeArchived: true }]);
  });
});

test("启动清扫：在册路径与清扫侧只是写法不同（符号链接形态）时仍不删", async () => {
  await withRoot(async (root) => {
    const staleDir = join(root, "2026-01-01", "aaaaaaaa");
    await mkdir(staleDir, { recursive: true });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(staleDir, eightDaysAgo, eightDaysAgo);
    await utimes(join(root, "2026-01-01"), eightDaysAgo, eightDaysAgo);
    // 库里那行记的是**同一个物理目录的另一种写法**：对话根经符号链接访问
    // （macOS 的 /var vs /private/var、用户把数据根软链到外接盘、盘符/目录名大小写）。
    // 纯词法比较（resolve 后字符串相等）会判「不在册」并删掉它；realpath 归一后才认得出。
    const linkedParent = await mkdtemp(join(tmpdir(), "zcode-linked-root-"));
    try {
      const linkedRoot = join(linkedParent, "root-link");
      await symlink(root, linkedRoot, "dir");
      const source = createFakeSessionPathSource([
        { id: SESSION_ID, directory: root, path: join(linkedRoot, "2026-01-01", "aaaaaaaa") },
      ]);
      assert.equal(
        await sweepEmptyConversationSessionDirs({
          conversationRoot: root,
          nowMs: Date.now(),
          sessionPathSource: source,
        }),
        0,
      );
      await assertPresent(staleDir);
    } finally {
      await rm(linkedParent, { recursive: true, force: true });
    }
  });
});

test("启动清扫：查会话库失败时一个目录都不删（fail-closed）", async () => {
  await withRoot(async (root) => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
    const dirs = [join(root, "2026-01-01", "aaaaaaaa"), join(root, "2026-01-02", "bbbbbbbb")];
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
    for (const dir of [...dirs, join(root, "2026-01-01"), join(root, "2026-01-02")]) {
      await utimes(dir, eightDaysAgo, eightDaysAgo);
    }
    const logger = createRecordingLogger();
    assert.equal(
      await sweepEmptyConversationSessionDirs({
        conversationRoot: root,
        nowMs: now,
        sessionPathSource: createThrowingSessionPathSource(),
        logger,
      }),
      0,
    );
    // 拿不到事实就不动手：两个超期空目录与它们的日期目录都必须原样保留。
    for (const dir of dirs) {
      await assertPresent(dir);
    }
    await assertPresent(join(root, "2026-01-01"));
    await assertPresent(join(root, "2026-01-02"));
    assert.deepEqual(logger.warnMessages, [
      "conversation session empty sweep skipped: session registry unavailable",
    ]);
  });
});

test("启动清扫：会话库返回非行数组（undefined / 对象）同样视为拿不到事实（fail-closed）", async () => {
  await withRoot(async (root) => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
    const sessionDir = join(root, "2026-01-05", "cccccccc");
    await mkdir(sessionDir, { recursive: true });
    await utimes(sessionDir, eightDaysAgo, eightDaysAgo);
    await utimes(join(root, "2026-01-05"), eightDaysAgo, eightDaysAgo);
    // `rows ?? []` 的旧写法会把契约外的返回当成**空的在册集合**：超期空目录照样被删，日志却显示
    // 清扫正常完成。判据是「拿不到事实就不动手」，抛错与非法返回必须同解。
    for (const rows of [undefined, null, { sessions: [] }]) {
      const logger = createRecordingLogger();
      assert.equal(
        await sweepEmptyConversationSessionDirs({
          conversationRoot: root,
          nowMs: now,
          sessionPathSource: { listSessions: async () => rows },
          logger,
        }),
        0,
      );
      await assertPresent(sessionDir);
      await assertPresent(join(root, "2026-01-05"));
      assert.deepEqual(logger.warnMessages, [
        "conversation session empty sweep skipped: session registry unavailable",
      ]);
    }
  });
});

test("对话根不存在时清扫是空操作", async () => {
  await withRoot(async (root) => {
    assert.equal(
      await sweepEmptyConversationSessionDirs({
        conversationRoot: join(root, "missing"),
        nowMs: Date.now(),
        sessionPathSource: createFakeSessionPathSource(),
      }),
      0,
    );
  });
});

// ── 删除边界的空目录回收接线（v4 deleteSession → closeSession）──────────────
// 判定条件必须严：只有「本进程启用对话根规则 + 会话工作区就是对话根 + 执行 cwd 严格落在
// 对话根之下 + 目录归该会话自己所有」才回收。定向用例在下面逐条固定这些边界。

const OTHER_SESSION_ID = "sess_ffffffff-1111-4111-8111-111111111111";

test("回收启用判定：workspaceKey 必须等于对话根，且没有 identity / remoteSessionId", () => {
  const conversationRoot = "/root/default";
  assert.equal(
    isConversationSessionReclaimEnabled({ conversationRoot, workspaceKey: conversationRoot }),
    true,
  );
  assert.equal(
    isConversationSessionReclaimEnabled({ conversationRoot, workspaceKey: "/root/default/" }),
    true,
  );
  // 项目 workspace 与远端 workspace：不是对话会话。
  assert.equal(
    isConversationSessionReclaimEnabled({ conversationRoot, workspaceKey: "/root/project" }),
    false,
  );
  assert.equal(
    isConversationSessionReclaimEnabled({
      conversationRoot,
      workspaceIdentity: "remote:ssh:host:/root/default",
      workspaceKey: conversationRoot,
    }),
    false,
  );
  assert.equal(
    isConversationSessionReclaimEnabled({
      conversationRoot,
      remoteSessionId: "rs_1",
      workspaceKey: conversationRoot,
    }),
    false,
  );
  // 未注入标记（CLI/TUI、项目工作区、远端）一律不启用。
  assert.equal(
    isConversationSessionReclaimEnabled({
      conversationRoot: undefined,
      workspaceKey: conversationRoot,
    }),
    false,
  );
  assert.equal(
    isConversationSessionReclaimEnabled({ conversationRoot, workspaceKey: "  " }),
    false,
  );
});

test("目录所有权：名字必须由本会话 id 派生，继承父目录的派生会话不算", () => {
  const conversationRoot = "/root/default";
  assert.equal(
    ownsConversationSessionDirectory({
      executionPath: join(conversationRoot, "2026-10-11", "a1b2c3d4"),
      sessionId: SESSION_ID,
    }),
    true,
  );
  // 前 8 位碰撞时创建边界回退 12 位；两种派生名都算本会话所有。
  assert.equal(
    ownsConversationSessionDirectory({
      executionPath: join(conversationRoot, "2026-10-11", "a1b2c3d45e6f"),
      sessionId: SESSION_ID,
    }),
    true,
  );
  // fork / 侧会话 / 子会话继承父会话执行 cwd：目录名来自父会话 id。
  assert.equal(
    ownsConversationSessionDirectory({
      executionPath: join(conversationRoot, "2026-10-11", "a1b2c3d4"),
      sessionId: OTHER_SESSION_ID,
    }),
    false,
  );
});

test("回收判定：启用 + 严格在对话根之下 + 目录归本会话所有", () => {
  const conversationRoot = "/root/default";
  const executionPath = join(conversationRoot, "2026-10-11", "a1b2c3d4");
  assert.equal(
    shouldReclaimConversationSessionDir({
      conversationRoot,
      enabled: true,
      executionPath,
      sessionId: SESSION_ID,
    }),
    true,
  );
  // 未启用（未注入标记 / 项目 / 远端）。
  assert.equal(
    shouldReclaimConversationSessionDir({
      conversationRoot,
      enabled: false,
      executionPath,
      sessionId: SESSION_ID,
    }),
    false,
  );
  // `path` 等于对话根 = 存量会话的旧值，不回收。
  assert.equal(
    shouldReclaimConversationSessionDir({
      conversationRoot,
      enabled: true,
      executionPath: conversationRoot,
      sessionId: SESSION_ID,
    }),
    false,
  );
  // 对话根之外（项目目录、`..` 逃逸）。
  assert.equal(
    shouldReclaimConversationSessionDir({
      conversationRoot,
      enabled: true,
      executionPath: "/root/other",
      sessionId: SESSION_ID,
    }),
    false,
  );
  assert.equal(
    shouldReclaimConversationSessionDir({
      conversationRoot,
      enabled: true,
      executionPath: join(conversationRoot, "..", "other"),
      sessionId: SESSION_ID,
    }),
    false,
  );
  // 形状不是布局本身：深度多一层（`<根>/<中间目录>/<日期>/<名字>`）不回收——
  // 只按「严格在根下 + 名字由 id 派生」判会连这种本规则从不产生的路径一起删，
  // 还会顺手删掉那个日期目录。
  assert.equal(
    shouldReclaimConversationSessionDir({
      conversationRoot,
      enabled: true,
      executionPath: join(conversationRoot, "nested", "2026-10-11", "a1b2c3d4"),
      sessionId: SESSION_ID,
    }),
    false,
  );
  // 日期父目录形状不对（不是 YYYY-MM-DD）同样不回收。
  assert.equal(
    shouldReclaimConversationSessionDir({
      conversationRoot,
      enabled: true,
      executionPath: join(conversationRoot, "not-a-date", "a1b2c3d4"),
      sessionId: SESSION_ID,
    }),
    false,
  );
  // 没有执行 cwd（旧 record）与空输入都不回收。
  assert.equal(
    shouldReclaimConversationSessionDir({
      conversationRoot,
      enabled: true,
      executionPath: undefined,
      sessionId: SESSION_ID,
    }),
    false,
  );
  assert.equal(
    shouldReclaimConversationSessionDir({
      conversationRoot: undefined,
      enabled: true,
      executionPath,
      sessionId: SESSION_ID,
    }),
    false,
  );
});

test("删除接线：草稿（未落库）空目录被回收且不留空日期目录，含文件的目录保留", async () => {
  await withRoot(async (root) => {
    const draftDir = join(root, "2026-10-11", "a1b2c3d4");
    await mkdir(draftDir, { recursive: true });
    assert.equal(
      await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: draftDir,
        sessionId: SESSION_ID,
        workspaceKey: root,
      }),
      true,
    );
    await assertMissing(draftDir);
    await assertMissing(join(root, "2026-10-11"));

    const usedDir = join(root, "2026-10-12", "a1b2c3d4");
    await mkdir(usedDir, { recursive: true });
    await writeFile(join(usedDir, "artifact.bin"), "keep");
    assert.equal(
      await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: usedDir,
        sessionId: SESSION_ID,
        workspaceKey: root,
      }),
      false,
    );
    await assertPresent(usedDir);
    await assertPresent(join(root, "2026-10-12"));
  });
});

test("删除边界的跨进程复检：库里别的会话认领同一执行目录（或事实不可得）时不回收", async () => {
  await withRoot(async (root) => {
    const sessionDir = join(root, "2026-10-13", "a1b2c3d4");
    await mkdir(sessionDir, { recursive: true });
    const foreignSessionId = "sess_ffffffff-1111-2222-3333-444444444444";

    // 本进程注册表为空（子会话在**别的** app-server 里 fork）：只有会话库能证明目录仍被使用。
    const withForeignRow = await isConversationSessionDirectoryInUseAcrossProcesses({
      executionPath: sessionDir,
      excludeSessionId: SESSION_ID,
      registrySessions: [],
      sessionPathSource: { listSessions: async () => [{ id: foreignSessionId, path: sessionDir }] },
    });
    assert.equal(withForeignRow, true);
    assert.equal(
      await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: sessionDir,
        sessionId: SESSION_ID,
        sharedByOtherSession: withForeignRow,
        workspaceKey: root,
      }),
      false,
    );
    await assertPresent(sessionDir);

    // 尾分隔符/多余分隔符只是同一路径的另一种写法，规范化后必须命中（否则守卫会漏判）。
    assert.equal(
      await isConversationSessionDirectoryInUseAcrossProcesses({
        executionPath: sessionDir,
        excludeSessionId: SESSION_ID,
        registrySessions: [],
        sessionPathSource: {
          listSessions: async () => [{ id: foreignSessionId, path: `${sessionDir}${sep}` }],
        },
      }),
      true,
    );

    // 被关会话**自己**的行仍在库里（v4 deleteSession 不真删 record）：必须排除，否则空目录永不回收。
    const selfOnly = await isConversationSessionDirectoryInUseAcrossProcesses({
      executionPath: sessionDir,
      excludeSessionId: SESSION_ID,
      registrySessions: [],
      sessionPathSource: { listSessions: async () => [{ id: SESSION_ID, path: sessionDir }] },
    });
    assert.equal(selfOnly, false);
    assert.equal(
      await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: sessionDir,
        sessionId: SESSION_ID,
        sharedByOtherSession: selfOnly,
        workspaceKey: root,
      }),
      true,
    );
    await assertMissing(sessionDir);
    await assertMissing(join(root, "2026-10-13"));

    // 拿不到事实（端口缺席 / 查库抛错）一律保守判为「在用」：宁可不回收空目录。
    for (const source of [
      undefined,
      {
        listSessions: async () => {
          throw new Error("session store unavailable");
        },
      },
    ]) {
      assert.equal(
        await isConversationSessionDirectoryInUseAcrossProcesses({
          executionPath: sessionDir,
          excludeSessionId: SESSION_ID,
          registrySessions: [],
          sessionPathSource: source,
        }),
        true,
      );
    }

    // 本进程注册表命中时不必查库（原判据不退化为「只查库」）。
    assert.equal(
      await isConversationSessionDirectoryInUseAcrossProcesses({
        executionPath: sessionDir,
        excludeSessionId: SESSION_ID,
        registrySessions: [{ executionWorkspacePath: sessionDir }],
        sessionPathSource: { listSessions: async () => [] },
      }),
      true,
    );
    // 没有任何会话认领时仍然回收（护栏不能让空目录永久残留）。
    assert.equal(
      await isConversationSessionDirectoryInUseAcrossProcesses({
        executionPath: sessionDir,
        excludeSessionId: SESSION_ID,
        registrySessions: [],
        sessionPathSource: {
          listSessions: async () => [
            { id: foreignSessionId, path: join(root, "2026-10-14", "deadbeef") },
          ],
        },
      }),
      false,
    );
  });
});

test("删除边界的跨进程复检：只有**行侧**经过符号链接时也认得出（不能只看目标侧决定 realpath）", async () => {
  // 根建在 tmpdir 的**规范形态**下：macOS 的 tmpdir 本身是 /var → /private/var 的链接形态，
  // 根落在链接形态下时目标侧天然非规范、行侧 realpath 分支会被无条件启用，用例就失去判别力
  // （红证实测：非规范根下旧代码也命中）。这里必须保证目标拼写规范、只有行侧是链接形态。
  const parent = await mkdtemp(join(await realpath(tmpdir()), "zcode-linked-row-"));
  try {
    const root = join(parent, "workspace-default");
    const sessionDir = join(root, "2026-10-13", "a1b2c3d4");
    await mkdir(sessionDir, { recursive: true });
    const foreignSessionId = "sess_ffffffff-1111-2222-3333-444444444444";
    // 目标（被删会话的执行 cwd）拼写规范、而库里别的会话行把**同一个物理目录**记成符号链接
    // 形态（/var vs /private/var、数据根软链到外接盘）：预筛（resolve 后字符串相等）全 miss。
    // 过去由目标侧决定要不要做行侧 realpath，这一形态被判「不在册」→ rmdir 掉别的进程在用的
    // 空目录。清扫侧对每行都 realpath，删除侧不能比它弱。
    const linkedRoot = join(parent, "root-link");
    await symlink(root, linkedRoot, "dir");
    const inUse = await isConversationSessionDirectoryInUseAcrossProcesses({
      executionPath: sessionDir,
      excludeSessionId: SESSION_ID,
      registrySessions: [],
      sessionPathSource: {
        listSessions: async () => [
          { id: foreignSessionId, path: join(linkedRoot, "2026-10-13", "a1b2c3d4") },
        ],
      },
    });
    assert.equal(inUse, true, "行侧链接形态也必须命中在册判定");
    assert.equal(
      await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: sessionDir,
        sessionId: SESSION_ID,
        sharedByOtherSession: inUse,
        workspaceKey: root,
      }),
      false,
    );
    await assertPresent(sessionDir);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("回收的跨进程复检是惰性的：判定链被拒时不查库，通过时只查一次", async () => {
  await withRoot(async (root) => {
    // 与「项目、远端、未注入标记…」那条用例同形：enabled / 所有权 的被拒分支都在 resolver 之前。
    const rejected = [
      { label: "项目 workspace", workspaceKey: "/root/project" },
      { label: "远端 identity", workspaceIdentity: "remote:ssh:host", workspaceKey: root },
      { label: "未注入对话根标记", conversationRoot: undefined, workspaceKey: root },
      { label: "派生会话继承父目录", sessionId: OTHER_SESSION_ID, workspaceKey: root },
    ];
    for (const overrides of rejected) {
      let called = 0;
      const reclaimed = await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: join(root, "2026-10-15", "a1b2c3d4"),
        sessionId: SESSION_ID,
        resolveSharedByOtherSession: async () => {
          called += 1;
          return false;
        },
        workspaceKey: root,
        ...overrides,
      });
      assert.equal(reclaimed, false, overrides.label);
      // 急切求值（调用点写 `sharedByOtherSession: await …`）会让每次 session/close 白跑一次
      // 全表 listSessions：项目工作区 / 远端 / 旧宿主每次都必然被 enabled 拒掉。
      assert.equal(called, 0, `${overrides.label}：判定被拒时不得查库`);
    }

    // 判定链通过 ⇒ 恰好复检一次；resolver 给 true ⇒ 目录保留。
    const sessionDir = join(root, "2026-10-15", "a1b2c3d4");
    await mkdir(sessionDir, { recursive: true });
    let called = 0;
    assert.equal(
      await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: sessionDir,
        sessionId: SESSION_ID,
        resolveSharedByOtherSession: async () => {
          called += 1;
          return true;
        },
        workspaceKey: root,
      }),
      false,
    );
    assert.equal(called, 1, "回收判定通过时必须复检一次跨进程事实");
    await assertPresent(sessionDir);

    // resolver 抛错 ⇒ 外层按「拿不到事实 = 在用」收口：不回收、不抛给调用方、目录原样。
    assert.equal(
      await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: sessionDir,
        sessionId: SESSION_ID,
        resolveSharedByOtherSession: async () => {
          throw new Error("session store unavailable");
        },
        workspaceKey: root,
      }),
      false,
    );
    await assertPresent(sessionDir);
  });
});

test("删除接线：日期父目录是符号链接时一律不回收（rmdir 会跟随中间链接）", async () => {
  await withRoot(async (root) => {
    // `<根>/<日期>` 被换成指向对话根**之外**的链接：包含判定全是词法的，
    // `rmdir(<链接>/<名字>)` 会跟随中间链接删到外部目录。护栏是「日期父目录必须是 lstat 真目录」。
    const outside = await mkdtemp(join(tmpdir(), "zcode-outside-"));
    try {
      const linkedSessionDir = join(outside, "a1b2c3d4");
      await mkdir(linkedSessionDir, { recursive: true });
      await symlink(outside, join(root, "2026-10-11"), "dir");
      assert.equal(
        await reclaimConversationSessionDirOnDelete({
          conversationRoot: root,
          executionPath: join(root, "2026-10-11", "a1b2c3d4"),
          sessionId: SESSION_ID,
          workspaceKey: root,
        }),
        false,
      );
      // 外部目录与其内容必须原样存活；链接本身也不动。
      await assertPresent(linkedSessionDir);
      assert.equal((await lstat(join(root, "2026-10-11"))).isSymbolicLink(), true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("启动清扫：日期目录是符号链接时不进入，外部目录原样保留", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "zcode-outside-"));
    try {
      const staleDir = join(outside, "aaaaaaaa");
      await mkdir(staleDir, { recursive: true });
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await utimes(staleDir, eightDaysAgo, eightDaysAgo);
      await utimes(outside, eightDaysAgo, eightDaysAgo);
      await symlink(outside, join(root, "2026-01-01"), "dir");
      const removed = await sweepEmptyConversationSessionDirs({
        conversationRoot: root,
        nowMs: Date.now(),
        sessionPathSource: createFakeSessionPathSource(),
      });
      // readdir 的 dirent 对链接 `isDirectory()` 为 false ⇒ 整个日期目录被跳过。
      assert.equal(removed, 0);
      await assertPresent(staleDir);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("删除接线：目录仍被别的在册会话使用时一律不回收（父删不连坐派生子会话）", async () => {
  await withRoot(async (root) => {
    const sharedDir = join(root, "2026-10-11", "a1b2c3d4");
    await mkdir(sharedDir, { recursive: true });
    // fork / 侧会话继承父会话 cwd：目录名来自父会话 id，因此只看名字无法发现「仍有人在用」。
    const liveSessions = [
      { executionWorkspacePath: join(root, "2026-10-11", "ffffffff") },
      { executionWorkspacePath: sharedDir },
    ];
    assert.equal(
      isConversationSessionDirectoryInUse({ executionPath: sharedDir, sessions: liveSessions }),
      true,
    );
    assert.equal(
      isConversationSessionDirectoryInUse({
        executionPath: sharedDir,
        sessions: [{ executionWorkspacePath: `${sharedDir}/` }, { executionWorkspacePath: "  " }],
      }),
      true,
      "尾部分隔符与空白值不能漏判",
    );
    assert.equal(
      isConversationSessionDirectoryInUse({ executionPath: sharedDir, sessions: [] }),
      false,
    );
    assert.equal(
      isConversationSessionDirectoryInUse({
        executionPath: undefined,
        sessions: liveSessions,
      }),
      false,
    );
    // 接线：sharedByOtherSession 为真时不回收（父会话被删，子会话仍在这个目录里工作）。
    assert.equal(
      await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: sharedDir,
        sessionId: SESSION_ID,
        sharedByOtherSession: true,
        workspaceKey: root,
      }),
      false,
    );
    await assertPresent(sharedDir);
    await assertPresent(join(root, "2026-10-11"));
    // 没有共用者时照旧回收（不能因为加了护栏就永不清空目录）。
    assert.equal(
      await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: sharedDir,
        sessionId: SESSION_ID,
        sharedByOtherSession: false,
        workspaceKey: root,
      }),
      true,
    );
    await assertMissing(sharedDir);
  });
});

test("在册判定折叠大小写：win32 / darwin 下同一目录的不同大小写形态仍算「在用」", () => {
  const sessionDir = join("/root/default", "2026-10-11", "a1b2c3d4");
  const upperDir = join("/root/default", "2026-10-11", "A1B2C3D4");
  // 判据方向是「保守 = 保留」：漏判（把同一个目录的大小写写法判成"没有别人在用"）会让删除边界
  // rmdir 掉存活子会话的工作目录，它下一次相对写入就 ENOENT；多判只会少删一个空目录。
  // win32 / darwin 的默认文件系统大小写不敏感，两种写法是同一个目录；Linux 大小写敏感，
  // 两个真实不同的目录不能折叠——必须与清扫的在册命中共用同一条规则。
  assert.equal(
    isConversationSessionDirectoryInUse({
      executionPath: upperDir,
      sessions: [{ executionWorkspacePath: sessionDir }],
    }),
    process.platform !== "linux",
  );
  assert.equal(
    isConversationSessionDirectoryInUse({
      executionPath: sessionDir,
      sessions: [{ executionWorkspacePath: sessionDir }],
    }),
    true,
  );
  // 规范化仍生效：尾分隔符写法不能漏判（折叠大小写不能替代 resolve）。
  assert.equal(
    isConversationSessionDirectoryInUse({
      executionPath: `${sessionDir}/`,
      sessions: [{ executionWorkspacePath: sessionDir }],
    }),
    true,
  );
});

test("删除接线：项目、远端、未注入标记、存量与继承目录一律不回收", async () => {
  await withRoot(async (root) => {
    const sessionDir = join(root, "2026-10-11", "a1b2c3d4");
    await mkdir(sessionDir, { recursive: true });
    const rejected = [
      {
        input: {
          conversationRoot: root,
          executionPath: sessionDir,
          sessionId: SESSION_ID,
          workspaceKey: "/root/project",
        },
        label: "项目 workspace",
      },
      {
        input: {
          conversationRoot: root,
          executionPath: sessionDir,
          sessionId: SESSION_ID,
          workspaceIdentity: "remote:ssh:host",
          workspaceKey: root,
        },
        label: "远端 identity",
      },
      {
        input: {
          conversationRoot: root,
          executionPath: sessionDir,
          remoteSessionId: "rs_1",
          sessionId: SESSION_ID,
          workspaceKey: root,
        },
        label: "远端 attachment",
      },
      {
        input: {
          conversationRoot: undefined,
          executionPath: sessionDir,
          sessionId: SESSION_ID,
          workspaceKey: root,
        },
        label: "未注入对话根标记",
      },
      {
        input: {
          conversationRoot: root,
          executionPath: root,
          sessionId: SESSION_ID,
          workspaceKey: root,
        },
        label: "存量会话（path = 对话根）",
      },
      {
        input: {
          conversationRoot: root,
          executionPath: sessionDir,
          sessionId: OTHER_SESSION_ID,
          workspaceKey: root,
        },
        label: "派生会话继承父会话目录",
      },
    ];
    for (const { input, label } of rejected) {
      assert.equal(await reclaimConversationSessionDirOnDelete(input), false, label);
    }
    await assertPresent(sessionDir);
  });
});

test("删除接线：回收失败或日志抛错都不阻断删除（不抛给调用方）", async () => {
  await withRoot(async (root) => {
    const throwingLogger = {
      debug: () => {
        throw new Error("log boom");
      },
      info: () => {
        throw new Error("log boom");
      },
      warn: () => {
        throw new Error("log boom");
      },
    };
    const draftDir = join(root, "2026-10-11", "a1b2c3d4");
    await mkdir(draftDir, { recursive: true });
    assert.equal(
      await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: draftDir,
        logger: throwingLogger,
        sessionId: SESSION_ID,
        workspaceKey: root,
      }),
      true,
    );
    await assertMissing(draftDir);

    // 目录不存在（已被手工删除）：rmdir 失败只当作「保留」，仍然不抛错。
    assert.equal(
      await reclaimConversationSessionDirOnDelete({
        conversationRoot: root,
        executionPath: join(root, "2026-10-13", "a1b2c3d4"),
        logger: throwingLogger,
        sessionId: SESSION_ID,
        workspaceKey: root,
      }),
      false,
    );
  });
});

test("启动清扫：未注入标记零 IO（不查会话库），有标记但没接线会话库时 fail-closed", async () => {
  await withRoot(async (root) => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const staleDir = join(root, "2026-01-01", "aaaaaaaa");
    await mkdir(staleDir, { recursive: true });
    await utimes(staleDir, eightDaysAgo, eightDaysAgo);
    await utimes(join(root, "2026-01-01"), eightDaysAgo, eightDaysAgo);

    // 未注入标记（CLI/TUI 直接运行、项目工作区、远端）：连会话库都不查——用一个必抛错的 source
    // 证明它一次都没被调用，目录也原样保留。
    // 先复位「已排过清扫」的一次性标志：本用例要在同一个进程里自证两条 fail-closed 分支都**没有
    // 消耗**那一次机会，否则断言会依赖同文件内其它用例的执行顺序（单跑本用例时失去证明力）。
    resetConversationSessionEmptySweepScheduleForTests();
    const throwing = createThrowingSessionPathSource();
    assert.equal(
      scheduleConversationSessionEmptySweep({ env: {}, sessionPathSource: throwing }),
      false,
    );
    assert.equal(throwing.calls.length, 0);
    await assertPresent(staleDir);

    // 注入了标记但没有会话库窄面：**不排清扫**（返回 false），绝不静默退回「只按年龄删」
    // ——那正是会误删别的进程正在使用的会话目录的版本。接线缺陷必须以 warn 暴露。
    // 这一支**没有**端口可查，因此「零 IO」的判据是「返回 false + 目录原样 + 没有消耗掉那次
    // 机会（下面第三次调用仍能排清扫）」；不要在这里断言某个 source 没被调用——那个 source
    // 根本没传进来，断言恒真（第九轮审查实测）。「端口在但查库失败」的 fail-closed 另有用例。
    const logger = createRecordingLogger();
    assert.equal(
      scheduleConversationSessionEmptySweep({
        env: { ZCODE_CONVERSATION_WORKSPACE_ROOT: root },
        logger,
      }),
      false,
    );
    await assertPresent(staleDir);
    assert.equal(logger.warnMessages.length, 1);
    assert.match(logger.warnMessages[0], /not wired/u);

    // 上面两次「不排清扫」都没有消耗那一次机会：补上端口后同一进程仍能排清扫
    // （这正是「不置标志」的意义——接线缺陷被修好后不必重启进程）。
    // 后台清扫仍会读取/删除夹具；调度成功不代表完成，必须在临时根 teardown 前等待真实完成日志。
    const completed = Promise.withResolvers();
    assert.equal(
      scheduleConversationSessionEmptySweep({
        env: { ZCODE_CONVERSATION_WORKSPACE_ROOT: root },
        sessionPathSource: createFakeSessionPathSource(),
        logger: {
          debug: (message) => {
            if (message === "conversation session empty sweep completed") completed.resolve();
          },
          warn: (message) => completed.reject(new Error(message)),
        },
      }),
      true,
    );
    await completed.promise;
    await assertMissing(staleDir);
    // 复位，保证本用例不会因为自身顺序给后面的用例留下已消耗的标志。
    resetConversationSessionEmptySweepScheduleForTests();
  });
});

test("启动清扫只在注入对话根标记且接线了会话库时排一次，未注入零动作", async () => {
  // 先把一次性标志复位：本用例断言「第一次排、第二次不排」，不能依赖文件内执行顺序。
  resetConversationSessionEmptySweepScheduleForTests();
  // 未注入标记、空串、纯空白都完全跳过（不产生任何 IO）。
  assert.equal(scheduleConversationSessionEmptySweep({ env: {} }), false);
  assert.equal(
    scheduleConversationSessionEmptySweep({ env: { ZCODE_CONVERSATION_WORKSPACE_ROOT: "  " } }),
    false,
  );

  await withRoot(async (root) => {
    const staleSessionDir = join(root, "2026-01-01", "aaaaaaaa");
    await mkdir(staleSessionDir, { recursive: true });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(staleSessionDir, eightDaysAgo, eightDaysAgo);
    await utimes(join(root, "2026-01-01"), eightDaysAgo, eightDaysAgo);
    // 未注入标记时上面这次「跳过」必须没有动过任何目录。
    await assertPresent(staleSessionDir);

    const env = { ZCODE_CONVERSATION_WORKSPACE_ROOT: root };
    // 库里没有任何行 ⇒ 在册集合为空，这条超期空目录照旧被回收。
    const source = createFakeSessionPathSource();
    assert.equal(scheduleConversationSessionEmptySweep({ env, sessionPathSource: source }), true);
    // 每个进程生命周期只跑一次：第二次调用不再排清扫。
    assert.equal(scheduleConversationSessionEmptySweep({ env, sessionPathSource: source }), false);
    await waitForMissing(staleSessionDir);
    await assertMissing(join(root, "2026-01-01"));
    assert.deepEqual(source.inputs, [{ includeArchived: true }]);
  });
});

test("嵌套 cwd：恢复与裸 CLI 不跟随上层日期/会话目录活链接", async () => {
  for (const linkedLayer of ["date", "session"]) {
    await withRoot(async (root) => {
      await withRoot(async (external) => {
        const dateDir = join(root, "2026-10-11");
        const sessionDir = join(dateDir, "a1b2c3d4");
        if (linkedLayer === "date") {
          await symlink(external, dateDir, "dir");
        } else {
          await mkdir(dateDir);
          await symlink(external, sessionDir, "dir");
        }
        const nested = join(sessionDir, "child", "work");
        const warnings = [];
        const logger = { warn: (_message, data) => warnings.push(data.reason) };
        assert.equal(
          resolveConversationSessionWorkspaceForResume({
            conversationRoot: root,
            workspacePath: root,
            persistedDirectory: root,
            persistedPath: nested,
            sessionId: SESSION_ID,
            createdAtMs: Date.now(),
            logger,
          }),
          undefined,
        );
        await assert.rejects(
          () =>
            ensureConversationSessionDirForBareResume({
              sessionId: SESSION_ID,
              store: { getSession: async () => ({ directory: root, path: nested }) },
              logger,
            }),
          ConversationSessionWorkspaceUnavailableError,
        );
        assert.deepEqual(
          warnings,
          Array(2).fill(linkedLayer === "date" ? "date_dir_unusable" : "session_dir_unusable"),
        );
        assert.deepEqual(await readdir(external), []);
      });
    });
  }
});

test("嵌套 cwd：正常恢复保持路径，裸 CLI 幂等补建缺失后代", async () => {
  await withRoot(async (root) => {
    const nested = join(root, "2026-10-11", "a1b2c3d4", "child", "work");
    await mkdir(join(root, "2026-10-11", "a1b2c3d4"), { recursive: true });
    assert.deepEqual(
      resolveConversationSessionWorkspaceForResume({
        conversationRoot: root,
        workspacePath: root,
        persistedPath: nested,
        sessionId: SESSION_ID,
        createdAtMs: Date.now(),
      }),
      { backfilled: false, directory: nested },
    );
    await ensureConversationSessionDirForBareResume({
      sessionId: SESSION_ID,
      store: { getSession: async () => ({ directory: root, path: nested }) },
    });
    await assertPresent(nested);
    await ensureConversationSessionWorkspaceForExecution({
      conversationRoot: root,
      workspacePath: root,
      executionWorkspacePath: nested,
    });
  });
});

test("存量补发遵守在册目录占用，持久化复用不重新定名", async () => {
  await withRoot(async (root) => {
    const sessionId = "sess_aabbccdd-2222-4222-8222-222222222222";
    const createdAtMs = Date.now();
    const shortPath = planConversationSessionWorkspace({
      conversationRoot: root,
      sessionId,
      createdAtMs,
    }).directory;
    await mkdir(shortPath, { recursive: true });
    const common = {
      conversationRoot: root,
      workspacePath: root,
      sessionId,
      createdAtMs,
      occupiedDirectories: [shortPath],
    };
    const backfill = resolveConversationSessionWorkspaceForResume({
      ...common,
      persistedPath: root,
    });
    assert.equal(backfill.backfilled, true);
    assert.notEqual(backfill.directory, shortPath);
    assert.equal(basename(backfill.directory), buildConversationSessionDirName(sessionId, 12));
    const reused = resolveConversationSessionWorkspaceForResume({
      ...common,
      persistedPath: shortPath,
    });
    assert.equal(reused.backfilled, false);
    assert.equal(reused.directory, shortPath);
  });
});
