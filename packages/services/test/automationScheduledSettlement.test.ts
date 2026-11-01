import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveWorkspaceKey, type ZCodeAutomation } from "@zcode/shared";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../scripts/ci/project-test-sandbox.mjs";
import { computeAutomationNextRunAt } from "../src/session/automationCron.js";
import {
  AutomationRepo,
  CLAIM_STALE_MS,
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_RETRY_BASE_MS,
} from "../src/session/automationRepo.js";
import { AutomationService } from "../src/session/automationService.js";
import { prepareTasksIndexStorage } from "../src/session/tasksDatabase/startup.js";

/**
 * scheduled run 成功结算的幂等边界回归（docs/specs/automation-lifecycle-controls.md
 * 「成功结算的事务 owner」）。
 *
 * 原夹具先建目录再校验，未经 runner 运行时会先污染系统 TEMP。改用中央沙箱，
 * 未绑定 PROJECT_TEST_SANDBOX_ROOT 时写前拒绝；清理也只接受重新校验的当前夹具。
 */
const FIXTURE_LABEL = "automation-settlement";

async function fixture(t: TestContext) {
  const directory = await createProjectTestFixture(FIXTURE_LABEL);
  const path = join(directory, "tasks.sqlite");
  const schedulerRepo = new AutomationRepo(path);
  const userRepo = new AutomationRepo(path);
  const service = new AutomationService(userRepo);
  t.after(async () => {
    userRepo.close();
    schedulerRepo.close();
    await rm(await assertProjectPath(directory), { recursive: true, force: true });
  });
  // Repo 只校验迁移账本；夹具必须先经过唯一异步启动 owner。
  await prepareTasksIndexStorage(path, () => {});
  const now = Date.now();
  const create = (recurring = true, maxRuns?: number, endAt?: number) =>
    schedulerRepo.create(
      {
        title: "Settlement fixture",
        prompt: "Synthetic task; never dispatched to a model",
        cronExpr: "* * * * *",
        workspacePath: "/synthetic-workspace",
        recurring,
        maxRuns,
        endAt,
      },
      { nextRunAt: now - 1 },
    );
  const workspaceKey = resolveWorkspaceKey({ workspacePath: "/synthetic-workspace" });
  /** 镜像 scheduler handleClaimed：认领后先 upsertRunClaimed 记账，再派发。 */
  const recordClaim = async (
    repo: AutomationRepo,
    automationId: string,
    runId: string,
    scheduledAt: number,
  ) => {
    await repo.upsertRunClaimed({
      runId,
      automationId,
      workspaceKey,
      scheduledAt,
      trigger: "schedule",
    });
  };
  /** 镜像 scheduler settleDispatchResult：runId 沿入站消息，nextRunAt 由纯函数注入。 */
  const settle = (repo: AutomationRepo, runId: string, at: number, sessionId?: string) =>
    repo.markScheduledRunDispatched({
      runId,
      ...(sessionId === undefined ? {} : { sessionId }),
      dispatchedAt: at,
      nextRunAtFor: (automation: ZCodeAutomation) => computeAutomationNextRunAt(automation, at),
    });
  return { schedulerRepo, userRepo, service, now, create, recordClaim, settle };
}

test("first successful settlement advances run ledger and counters in one transaction", async (t) => {
  const { schedulerRepo, now, create, recordClaim, settle } = await fixture(t);
  const { automationId } = await create(false, 2);
  const [claimed] = await schedulerRepo.claimDue(now);
  assert.ok(claimed?.nextRunAt);
  const runId = `${automationId}:${claimed.nextRunAt}`;
  await recordClaim(schedulerRepo, automationId, runId, claimed.nextRunAt);
  assert.equal(await settle(schedulerRepo, runId, now + 1, "session-1"), true);
  const automation = await schedulerRepo.get(automationId);
  assert.equal(automation?.runCount, 1);
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 1);
  assert.equal(automation?.lifecycleStatus, "active");
  assert.equal(automation?.dispatchStatus, "dispatched");
  assert.ok(automation?.nextRunAt);
  const run = await schedulerRepo.getRun(runId);
  assert.equal(run?.dispatchStatus, "dispatched");
  assert.equal(run?.sessionId, "session-1");
});

test("duplicate cron-dispatch-result for the same runId neither counts nor clears the next claim", async (t) => {
  const { schedulerRepo, now, create, recordClaim, settle } = await fixture(t);
  const { automationId } = await create(true);
  const [claimed] = await schedulerRepo.claimDue(now);
  assert.ok(claimed?.nextRunAt);
  const runId = `${automationId}:${claimed.nextRunAt}`;
  await recordClaim(schedulerRepo, automationId, runId, claimed.nextRunAt);
  assert.equal(await settle(schedulerRepo, runId, now + 1, "session-1"), true);
  const afterFirst = await schedulerRepo.get(automationId);
  assert.ok(afterFirst?.nextRunAt);
  const nextRunAt = afterFirst.nextRunAt;

  // 迟到/重复回报：scheduler 重启后旧持有者的结果再次到达。
  assert.equal(await settle(schedulerRepo, runId, now + 2, "session-2"), false);
  const afterDuplicate = await schedulerRepo.get(automationId);
  assert.equal(afterDuplicate?.runCount, 1);
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 1);
  assert.equal(afterDuplicate?.lifecycleStatus, "active");
  assert.equal(afterDuplicate?.nextRunAt, nextRunAt);
  const run = await schedulerRepo.getRun(runId);
  assert.equal(run?.dispatchStatus, "dispatched");
  assert.equal(run?.sessionId, "session-1");

  // 下一轮已重新认领（在途 dispatch）时，重复回报不得清掉该认领。
  const [reclaimed] = await schedulerRepo.claimDue(nextRunAt);
  assert.ok(reclaimed);
  assert.equal(await settle(schedulerRepo, runId, now + 3), false);
  const afterLateDuplicate = await schedulerRepo.get(automationId);
  assert.equal(afterLateDuplicate?.dispatchStatus, "claimed");
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 1);
});

test("two distinct due occurrences still exhaust a finite automation normally", async (t) => {
  const { schedulerRepo, now, create, recordClaim, settle } = await fixture(t);
  const { automationId } = await create(false, 2);
  const [first] = await schedulerRepo.claimDue(now);
  assert.ok(first?.nextRunAt);
  const runIdA = `${automationId}:${first.nextRunAt}`;
  await recordClaim(schedulerRepo, automationId, runIdA, first.nextRunAt);
  assert.equal(await settle(schedulerRepo, runIdA, now + 1), true);
  const afterFirst = await schedulerRepo.get(automationId);
  assert.equal(afterFirst?.lifecycleStatus, "active");
  assert.ok(afterFirst?.nextRunAt);

  const [second] = await schedulerRepo.claimDue(afterFirst.nextRunAt);
  assert.ok(second);
  const runIdB = `${automationId}:${second.nextRunAt ?? now + 2}`;
  await recordClaim(schedulerRepo, automationId, runIdB, second.nextRunAt ?? now + 2);
  assert.equal(await settle(schedulerRepo, runIdB, now + 2), true);
  const completed = await schedulerRepo.get(automationId);
  assert.equal(completed?.lifecycleStatus, "completed");
  assert.equal(completed?.enabled, false);
  assert.equal(completed?.nextRunAt, undefined);
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 2);
});

test("transient retry keeps a stable runId and settles exactly once", async (t) => {
  const { schedulerRepo, now, create, recordClaim, settle } = await fixture(t);
  const { automationId } = await create(true);
  const [claimed] = await schedulerRepo.claimDue(now);
  assert.ok(claimed?.nextRunAt);
  const runId = `${automationId}:${claimed.nextRunAt}`;
  await recordClaim(schedulerRepo, automationId, runId, claimed.nextRunAt);
  await schedulerRepo.markDispatchFailed(automationId, {
    failedAt: now,
    error: "synthetic transient",
    kind: "transient",
  });
  const backedOff = await schedulerRepo.get(automationId);
  assert.ok(backedOff?.retryAt);
  const [retried] = await schedulerRepo.claimDue(backedOff.retryAt);
  assert.ok(retried);
  assert.equal(retried.dispatchAttempts, 1);
  await recordClaim(schedulerRepo, automationId, runId, retried.nextRunAt ?? now - 1);
  assert.equal(await settle(schedulerRepo, runId, now + 60_000), true);
  const settled = await schedulerRepo.get(automationId);
  assert.equal(settled?.runCount, 1);
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 1);
  assert.equal(settled?.retryAt, undefined);
  assert.equal(settled?.lifecycleStatus, "active");
  const run = await schedulerRepo.getRun(runId);
  assert.equal(run?.attempts, 1);
});

test("manual settlement semantics stay untouched by the scheduled gate", async (t) => {
  const { schedulerRepo, userRepo, service, now, create } = await fixture(t);
  const { automationId } = await create(true);
  const manual = await service.runNow(automationId);
  assert.ok(manual);
  assert.equal(
    await userRepo.markManualRunDispatched({
      runId: manual.run.runId,
      dispatchedAt: now + 1,
    }),
    true,
  );
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 0);
  assert.equal((await schedulerRepo.get(automationId))?.runCount, 1);
  // scheduled 结算闸门按 trigger 过滤，不得吞掉 manual run 的台账。
  assert.equal(
    await schedulerRepo.markScheduledRunDispatched({
      runId: manual.run.runId,
      dispatchedAt: now + 2,
      nextRunAtFor: () => null,
    }),
    false,
  );
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 0);
  assert.equal((await schedulerRepo.get(automationId))?.runCount, 1);
  await userRepo.releaseManualClaim(
    automationId,
    resolveWorkspaceKey({ workspacePath: "/synthetic-workspace" }),
  );
});

test("phantom runId results and deleted automations never resurrect counters", async (t) => {
  const { schedulerRepo, now, create, recordClaim, settle } = await fixture(t);
  const { automationId } = await create(true);
  const baseline = await schedulerRepo.getScheduledRunCount(automationId);
  assert.equal(await settle(schedulerRepo, `${automationId}:999999999`, now + 1), false);
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), baseline);

  const [claimed] = await schedulerRepo.claimDue(now);
  assert.ok(claimed?.nextRunAt);
  const runId = `${automationId}:${claimed.nextRunAt}`;
  await recordClaim(schedulerRepo, automationId, runId, claimed.nextRunAt);
  assert.ok(await schedulerRepo.delete(automationId));
  assert.equal(await settle(schedulerRepo, runId, now + 1), true);
  const run = await schedulerRepo.getRun(runId);
  assert.equal(run?.dispatchStatus, "dispatched");
  assert.equal(await schedulerRepo.get(automationId), null);
});

test("legacy compat surface stays available for historical callers", async (t) => {
  const { schedulerRepo, now, create } = await fixture(t);
  const { automationId } = await create(true);
  assert.equal(typeof schedulerRepo.markDispatched, "function");
  assert.equal(typeof schedulerRepo.markRunDispatch, "function");
  await schedulerRepo.markDispatched(automationId, { dispatchedAt: now, nextRunAt: now + 60_000 });
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 1);
});

test("legacy three-step settle sequence double-counts the same runId (contrast probe)", async (t) => {
  // 对照探针（父代理复核要求）：修复前 scheduler settleDispatchResult ok 路径的真实三步
  // markRunDispatch('dispatched') -> repo.get/compute -> markDispatched，对同一 runId 重复执行
  // 会二次推进计数。生产已改走 markScheduledRunDispatched，本测试用仍然存在的 legacy API
  // 记录旧行为作为红绿对照证据，不构成生产回归，不得据此恢复旧调用路径。
  const { schedulerRepo, now, create, recordClaim } = await fixture(t);
  const { automationId } = await create(false, 2);
  const [claimed] = await schedulerRepo.claimDue(now);
  assert.ok(claimed?.nextRunAt);
  const runId = `${automationId}:${claimed.nextRunAt}`;
  await recordClaim(schedulerRepo, automationId, runId, claimed.nextRunAt);
  const legacySettle = async (at: number) => {
    await schedulerRepo.markRunDispatch({
      runId,
      dispatchStatus: "dispatched",
      sessionId: null,
    });
    const automation = await schedulerRepo.get(automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, at) : null;
    await schedulerRepo.markDispatched(automationId, { dispatchedAt: at, nextRunAt });
  };
  await legacySettle(now + 1);
  await legacySettle(now + 2); // 同 runId 迟到/重复回报
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 2);
  assert.equal((await schedulerRepo.get(automationId))?.runCount, 2);
  assert.equal((await schedulerRepo.get(automationId))?.lifecycleStatus, "completed");
});

test("nextRunAtFor throwing inside settlement rolls the whole transaction back", async (t) => {
  const { schedulerRepo, now, create, recordClaim, settle } = await fixture(t);
  const { automationId } = await create(false, 2);
  const [claimed] = await schedulerRepo.claimDue(now);
  assert.ok(claimed?.nextRunAt);
  const runId = `${automationId}:${claimed.nextRunAt}`;
  await recordClaim(schedulerRepo, automationId, runId, claimed.nextRunAt);
  await assert.rejects(
    schedulerRepo.markScheduledRunDispatched({
      runId,
      dispatchedAt: now + 1,
      nextRunAtFor: () => {
        throw new Error("synthetic cron failure");
      },
    }),
    /synthetic cron failure/,
  );
  // 事务回滚：run 台账与 automation 计数都保持认领态原样，无部分提交。
  assert.equal((await schedulerRepo.getRun(runId))?.dispatchStatus, "claimed");
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 0);
  const automation = await schedulerRepo.get(automationId);
  assert.equal(automation?.runCount, 0);
  assert.equal(automation?.dispatchStatus, "claimed");
  // 回滚后正常结算仍可完成。
  assert.equal(await settle(schedulerRepo, runId, now + 1, "session-1"), true);
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 1);
});

test("late failure result after success cannot un-dispatch the run or start a phantom retry", async (t) => {
  const { schedulerRepo, now, create, recordClaim, settle } = await fixture(t);
  const { automationId } = await create(true);
  const [claimed] = await schedulerRepo.claimDue(now);
  assert.ok(claimed?.nextRunAt);
  const runId = `${automationId}:${claimed.nextRunAt}`;
  await recordClaim(schedulerRepo, automationId, runId, claimed.nextRunAt);
  assert.equal(await settle(schedulerRepo, runId, now + 1, "session-1"), true);
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 1);
  // 迟到失败回报（与 scheduler 失败结算同序：markRunDispatch(failed) + markDispatchFailed(runId)）。
  await schedulerRepo.markRunDispatch({
    runId,
    dispatchStatus: "failed_to_dispatch",
    error: "late failure",
  });
  await schedulerRepo.markDispatchFailed(automationId, {
    failedAt: now + 2,
    error: "late failure",
    kind: "transient",
    runId,
  });
  const run = await schedulerRepo.getRun(runId);
  assert.equal(run?.dispatchStatus, "dispatched");
  // rowToRun 将 NULL 列映射为 undefined；断言用 undefined 而非 null。
  assert.equal(run?.error, undefined);
  const automation = await schedulerRepo.get(automationId);
  assert.equal(automation?.retryAt, undefined);
  assert.equal(automation?.dispatchAttempts, 0);
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 1);
  // 重复成功回报不得再次计数。
  assert.equal(await settle(schedulerRepo, runId, now + 3), false);
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 1);
});

test("run ledger success is terminal: no writer may leave dispatched", async (t) => {
  const { schedulerRepo, now, create, recordClaim } = await fixture(t);
  const { automationId } = await create(true);
  const [claimed] = await schedulerRepo.claimDue(now);
  assert.ok(claimed?.nextRunAt);
  const runId = `${automationId}:${claimed.nextRunAt}`;
  await recordClaim(schedulerRepo, automationId, runId, claimed.nextRunAt);
  await schedulerRepo.markRunDispatch({ runId, dispatchStatus: "dispatched" });
  assert.equal((await schedulerRepo.getRun(runId))?.dispatchStatus, "dispatched");
  // 重复成功回写与迟到失败回写都不得改变终态。
  await schedulerRepo.markRunDispatch({ runId, dispatchStatus: "dispatched", sessionId: "s1" });
  await schedulerRepo.markRunDispatch({ runId, dispatchStatus: "failed_to_dispatch", error: "x" });
  const run = await schedulerRepo.getRun(runId);
  assert.equal(run?.dispatchStatus, "dispatched");
  // rowToRun 将 NULL 列映射为 undefined；被守卫拦截的重复回写不得写入 sessionId。
  assert.equal(run?.sessionId, undefined);
  // 陈旧再记账（僵尸回收后旧持有者的 upsertRunClaimed）不得拉回 claimed 或清 outcome。
  await schedulerRepo.upsertRunClaimed({
    runId,
    automationId,
    workspaceKey: resolveWorkspaceKey({ workspacePath: "/synthetic-workspace" }),
    scheduledAt: claimed.nextRunAt,
    trigger: "schedule",
  });
  const afterStaleUpsert = await schedulerRepo.getRun(runId);
  assert.equal(afterStaleUpsert?.dispatchStatus, "dispatched");
  assert.equal(afterStaleUpsert?.attempts, 0);
});

test("late first success of a superseded occurrence advances counters without releasing the newer claim", async (t) => {
  // owner 边界（spec「迟到成功与在途认领的 owner 边界」）：A 已认领/记账未结算，规则更新把
  // 调度前移到新 occurrence（B，不同 scheduledAt/runId），A 的首个成功晚到时只推进计数，
  // 绝不释放 B 的 running/claimed_at、不改写 next_run_at/dispatchStatus。
  const { schedulerRepo, now, create, recordClaim, settle } = await fixture(t);
  const { automationId } = await create(true); // "* * * * *"，next_run_at = now-1
  const [a] = await schedulerRepo.claimDue(now);
  assert.ok(a?.nextRunAt);
  const runIdA = `${automationId}:${a.nextRunAt}`;
  await recordClaim(schedulerRepo, automationId, runIdA, a.nextRunAt);
  // 规则更新把调度前移到 t2（repo.update 只写 next_run_at，不触碰认领字段）。
  const t2 = now + 60_000 + 10 * 60_000; // 让 A 的认领进入 CLAIM_STALE 可回收窗口
  await schedulerRepo.update(automationId, {}, { nextRunAt: t2 });
  // A 认领超时回收后 B 认领（不同 scheduledAt/runId）。
  const [b] = await schedulerRepo.claimDue(t2);
  assert.ok(b);
  const runIdB = `${automationId}:${b.nextRunAt ?? t2}`;
  await recordClaim(schedulerRepo, automationId, runIdB, b.nextRunAt ?? t2);
  // A 的首个成功晚到。
  assert.equal(await settle(schedulerRepo, runIdA, t2 + 1, "session-a"), true);
  // 计数按实际接受推进；B 的认领字段/next_run_at/dispatchStatus 全部保留。
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 1);
  const afterA = await schedulerRepo.get(automationId);
  assert.equal(afterA?.dispatchStatus, "claimed");
  assert.equal(afterA?.nextRunAt, t2);
  // B 仍在途：不允许第三个认领（single-flight 未被 A 的迟到成功破坏）。
  assert.deepEqual(await schedulerRepo.claimDue(t2 + 60_000), []);
  // B 自己的成功按当前 occurrence 全量结算。
  assert.equal(await settle(schedulerRepo, runIdB, t2 + 61_000, "session-b"), true);
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 2);
  const afterB = await schedulerRepo.get(automationId);
  assert.equal(afterB?.dispatchStatus, "dispatched");
  assert.ok(afterB?.nextRunAt);
  assert.notEqual(afterB?.nextRunAt, t2);
});

test("markDispatchFailed with a runId from another automation must not touch the target row", async (t) => {
  const { schedulerRepo, now, create, recordClaim } = await fixture(t);
  const x = await create(true);
  const y = await create(true);
  const claimed = await schedulerRepo.claimDue(now);
  const claimedY = claimed.find((c) => c.automationId === y.automationId);
  assert.ok(claimedY?.nextRunAt);
  const runIdY = `${y.automationId}:${claimedY.nextRunAt}`;
  await recordClaim(schedulerRepo, y.automationId, runIdY, claimedY.nextRunAt);
  // 跨 automation 的 runId 不得改写 x 的行。
  await schedulerRepo.markDispatchFailed(x.automationId, {
    failedAt: now + 1,
    error: "cross-tenant synthetic",
    kind: "transient",
    runId: runIdY,
  });
  const xAfter = await schedulerRepo.get(x.automationId);
  assert.equal(xAfter?.dispatchAttempts, 0);
  assert.equal(xAfter?.retryAt, undefined);
  assert.equal(xAfter?.lastError, undefined);
  // x 同样被 claimDue 认领（基线）；跨行调用只要求失败态字段不被污染，认领状态保持原样。
  assert.equal(xAfter?.dispatchStatus, "claimed");
  // y 自身的失败结算不受影响。
  await schedulerRepo.markDispatchFailed(y.automationId, {
    failedAt: now + 1,
    error: "own failure",
    kind: "transient",
    runId: runIdY,
  });
  const yAfter = await schedulerRepo.get(y.automationId);
  assert.equal(yAfter?.dispatchAttempts, 1);
  assert.ok(yAfter?.retryAt);
});

test("real transient retry on a failed run still re-claims and settles once", async (t) => {
  const { schedulerRepo, now, create, recordClaim, settle } = await fixture(t);
  const { automationId } = await create(true);
  const [claimed] = await schedulerRepo.claimDue(now);
  assert.ok(claimed?.nextRunAt);
  const runId = `${automationId}:${claimed.nextRunAt}`;
  await recordClaim(schedulerRepo, automationId, runId, claimed.nextRunAt);
  // 真失败（未结算成功）：终态单调守卫不得阻断 claimed→failed 与重试。
  await schedulerRepo.markRunDispatch({
    runId,
    dispatchStatus: "failed_to_dispatch",
    error: "boom",
  });
  assert.equal((await schedulerRepo.getRun(runId))?.dispatchStatus, "failed_to_dispatch");
  await schedulerRepo.markDispatchFailed(automationId, {
    failedAt: now,
    error: "boom",
    kind: "transient",
    runId,
  });
  const backedOff = await schedulerRepo.get(automationId);
  assert.ok(backedOff?.retryAt);
  const [retried] = await schedulerRepo.claimDue(backedOff.retryAt);
  assert.ok(retried);
  await recordClaim(schedulerRepo, automationId, runId, retried.nextRunAt ?? now - 1);
  assert.equal(await settle(schedulerRepo, runId, now + 60_000), true);
  assert.equal(await schedulerRepo.getScheduledRunCount(automationId), 1);
  assert.equal((await schedulerRepo.getRun(runId))?.dispatchStatus, "dispatched");
});

/**
 * 失败回执的 occurrence 归属回归（docs/specs/automation-lifecycle-controls.md「失败回执的
 * occurrence 归属」）。Bug 原因：markDispatchFailed 的 runId 闸门只校验 run 是否存在、归属是否
 * 一致、是否已 dispatched，不校验轮次归属，而三条失败写入分支都无条件 running = 0、
 * claimed_at = NULL；于是「A 尚未成功、B 已认领下一轮」时，A 的首个迟到失败会释放 B 的
 * single-flight 锁，claimDue 随即放出第三个认领，同一个 target task 被并发投递。
 * 契约：非当前 occurrence 的失败只允许改自己的 run 台账，automations 行一字不改，且不新增
 * 第二写入路径。前三条迟到失败用例与第四条在当前实现下应为红，补最小 owner 守卫后转绿；
 * 最后一条 legacy 用例是兼容 pin，守卫前后都应为绿。
 */
const CLAIM_HANDOFF_GAP_MS = 60_000;
const NEXT_OCCURRENCE_PROBE_MS = 3_600_000;

type RecordClaimFn = (
  repo: AutomationRepo,
  automationId: string,
  runId: string,
  scheduledAt: number,
) => Promise<void>;

/** 复刻 scheduler 的失败结算顺序：先记本次 run 台账，再推进 automation（同一条写入路径）。 */
async function settleFailureLikeScheduler(
  repo: AutomationRepo,
  params: {
    automationId: string;
    runId?: string;
    failedAt: number;
    error: string;
    kind: "transient" | "permanent";
    nextRunAt?: number;
  },
): Promise<void> {
  if (params.runId !== undefined) {
    await repo.markRunDispatch({
      runId: params.runId,
      dispatchStatus: "failed_to_dispatch",
      error: params.error,
    });
  }
  await repo.markDispatchFailed(params.automationId, {
    failedAt: params.failedAt,
    error: params.error,
    kind: params.kind,
    ...(params.runId === undefined ? {} : { runId: params.runId }),
    ...(params.nextRunAt === undefined ? {} : { nextRunAt: params.nextRunAt }),
  });
}

/**
 * 造出「A 已被下一轮 B 取代、B 正在途」：A 认领 occurrence T1（可先跑掉 priorAttempts 次真实
 * 重试，把 dispatch_attempts 抬到上限前一轮），再把调度前移到 T2（只写 next_run_at、不触碰认领
 * 字段），A 的认领越过 CLAIM_STALE 后由 claimDue 回收，并认领下一轮 B。
 */
async function prepareSupersededInFlightClaim(params: {
  repo: AutomationRepo;
  automationId: string;
  now: number;
  priorAttempts: number;
  recordClaim: RecordClaimFn;
}): Promise<{ runIdA: string; runIdB: string; occurrenceB: number }> {
  const { repo, automationId, now, priorAttempts, recordClaim } = params;
  const [first] = await repo.claimDue(now);
  const occurrenceA = first?.nextRunAt;
  assert.ok(occurrenceA);
  const runIdA = `${automationId}:${occurrenceA}`;
  await recordClaim(repo, automationId, runIdA, occurrenceA);
  let lastClaimedAt = now;
  // A 此时仍是当前 occurrence：这些失败是真实重试，必须照常生效（守卫不能把它们一起挡掉）。
  for (let attempt = 0; attempt < priorAttempts; attempt += 1) {
    await settleFailureLikeScheduler(repo, {
      automationId,
      runId: runIdA,
      failedAt: lastClaimedAt + 1_000,
      error: `synthetic retry ${attempt + 1}`,
      kind: "transient",
    });
    const backedOff = await repo.get(automationId);
    assert.ok(backedOff?.retryAt);
    lastClaimedAt = backedOff.retryAt;
    const [again] = await repo.claimDue(lastClaimedAt);
    assert.ok(again);
    await recordClaim(repo, automationId, runIdA, again?.nextRunAt ?? occurrenceA);
  }
  const occurrenceB = lastClaimedAt + CLAIM_STALE_MS + CLAIM_HANDOFF_GAP_MS;
  await repo.update(automationId, {}, { nextRunAt: occurrenceB });
  const [next] = await repo.claimDue(occurrenceB);
  assert.ok(next);
  const runIdB = `${automationId}:${occurrenceB}`;
  await recordClaim(repo, automationId, runIdB, next.nextRunAt ?? occurrenceB);
  return { runIdA, runIdB, occurrenceB };
}

const lateFailureCases = [
  { kind: "transient", label: "below-the-retry-cap", priorAttempts: 0 },
  { kind: "transient", label: "at-the-retry-cap", priorAttempts: DISPATCH_MAX_ATTEMPTS - 1 },
  { kind: "permanent", label: "terminal", priorAttempts: 0 },
] as const;

for (const lateCase of lateFailureCases) {
  const caseTitle = `late ${lateCase.kind} failure of a superseded occurrence (${lateCase.label})`;
  test(`${caseTitle} leaves the automation row untouched`, async (t) => {
    const { schedulerRepo, now, create, recordClaim } = await fixture(t);
    const { automationId } = await create(true);
    const { runIdA, runIdB, occurrenceB } = await prepareSupersededInFlightClaim({
      repo: schedulerRepo,
      automationId,
      now,
      priorAttempts: lateCase.priorAttempts,
      recordClaim,
    });
    const before = await schedulerRepo.get(automationId);
    assert.ok(before);
    assert.equal(before.dispatchStatus, "claimed");
    assert.equal(before.nextRunAt, occurrenceB);

    const error = `late ${lateCase.kind} of superseded occurrence`;
    await settleFailureLikeScheduler(schedulerRepo, {
      automationId,
      runId: runIdA,
      failedAt: occurrenceB + 1_000,
      error,
      kind: lateCase.kind,
      nextRunAt: occurrenceB + NEXT_OCCURRENCE_PROBE_MS,
    });

    // 核心不变量：automations 整行与结算前逐字段一致（含 updated_at）——既不释放 B 的认领，
    // 也不写幻影 retry_at / dispatch_attempts / last_error，更不改 lifecycle_status / enabled。
    assert.deepEqual(await schedulerRepo.get(automationId), before);
    // 失败事实仍记在 A 自己的 run 台账上（沿用既有写入路径，不新增第二条）。
    const runA = await schedulerRepo.getRun(runIdA);
    assert.equal(runA?.dispatchStatus, "failed_to_dispatch");
    assert.equal(runA?.error, error);
    assert.equal((await schedulerRepo.getRun(runIdB))?.dispatchStatus, "claimed");
    // B 的 single-flight 未被破坏：B 尚未越过 CLAIM_STALE 时不得放出第三个认领。
    assert.deepEqual(
      await schedulerRepo.claimDue(occurrenceB + 1_000 + DISPATCH_RETRY_BASE_MS),
      [],
    );
  });
}

test("the current occurrence keeps backing off after a superseded late failure is skipped", async (t) => {
  const { schedulerRepo, now, create, recordClaim } = await fixture(t);
  const { automationId } = await create(true);
  const { runIdA, runIdB, occurrenceB } = await prepareSupersededInFlightClaim({
    repo: schedulerRepo,
    automationId,
    now,
    priorAttempts: 0,
    recordClaim,
  });
  await settleFailureLikeScheduler(schedulerRepo, {
    automationId,
    runId: runIdA,
    failedAt: occurrenceB + 1_000,
    error: "late transient",
    kind: "transient",
  });
  const afterLate = await schedulerRepo.get(automationId);
  assert.equal(afterLate?.dispatchAttempts, 0);
  assert.equal(afterLate?.retryAt, undefined);
  assert.equal(afterLate?.dispatchStatus, "claimed");
  assert.equal(afterLate?.lastError, undefined);
  // 守卫不得反向挡住当前 occurrence：B 自己的失败必须照常进入 claimed→failed 与退避。
  await settleFailureLikeScheduler(schedulerRepo, {
    automationId,
    runId: runIdB,
    failedAt: occurrenceB + 2_000,
    error: "own transient",
    kind: "transient",
  });
  const afterOwn = await schedulerRepo.get(automationId);
  assert.equal(afterOwn?.dispatchAttempts, 1);
  assert.equal(afterOwn?.dispatchStatus, "failed_to_dispatch");
  assert.ok(afterOwn?.retryAt);
  assert.equal(afterOwn?.nextRunAt, occurrenceB);
  // A 的重复迟到失败持续无效：不叠加退避、不清 retry 态、不释放任何认领。
  const snapshot = await schedulerRepo.get(automationId);
  await settleFailureLikeScheduler(schedulerRepo, {
    automationId,
    runId: runIdA,
    failedAt: occurrenceB + 3_000,
    error: "late transient again",
    kind: "transient",
  });
  assert.deepEqual(await schedulerRepo.get(automationId), snapshot);
});

test("legacy markDispatchFailed without runId keeps its unconditional historical behaviour", async (t) => {
  // 兼容 pin（守卫前后都应为绿）：不带 runId 的旧调用无法判定轮次归属，必须保持原有无条件推进
  // 语义；owner 守卫只在携带 runId 时生效，否则会静默改变历史消费方与既有测试的行为。
  const { schedulerRepo, now, create, recordClaim } = await fixture(t);
  const { automationId } = await create(true);
  const { occurrenceB } = await prepareSupersededInFlightClaim({
    repo: schedulerRepo,
    automationId,
    now,
    priorAttempts: 0,
    recordClaim,
  });
  await settleFailureLikeScheduler(schedulerRepo, {
    automationId,
    failedAt: occurrenceB + 1_000,
    error: "legacy failure without runId",
    kind: "transient",
  });
  const after = await schedulerRepo.get(automationId);
  assert.equal(after?.dispatchAttempts, 1);
  assert.equal(after?.dispatchStatus, "failed_to_dispatch");
  assert.ok(after?.retryAt);
});
