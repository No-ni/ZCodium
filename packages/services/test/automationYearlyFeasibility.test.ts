import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ZCodeAutomationScheduleRule } from "@zcode/shared";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../scripts/ci/project-test-sandbox.mjs";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { AutomationService } from "../src/session/automationService.js";
import { prepareTasksIndexStorage } from "../src/session/tasksDatabase/startup.js";

/**
 * yearly 调度规则可行性校验回归（docs/specs/automation-lifecycle-controls.md
 * 「调度规则可行性校验（yearly 窄口径）」）。窄口径：仅拒绝「解析后 (月,日) 对所有年份不存在」
 * 的 yearly 规则；Feb 29 与 monthly 一律不拒（防错拒）。
 *
 * 原夹具先建目录再校验，未经 runner 运行时会先污染系统 TEMP。改用中央沙箱，
 * 未绑定 PROJECT_TEST_SANDBOX_ROOT 时写前拒绝；清理也只接受重新校验的当前夹具。
 */
const FIXTURE_LABEL = "automation-yearly";

async function fixture(t: TestContext) {
  const directory = await createProjectTestFixture(FIXTURE_LABEL);
  const path = join(directory, "tasks.sqlite");
  const repo = new AutomationRepo(path);
  const service = new AutomationService(repo);
  t.after(async () => {
    repo.close();
    await rm(await assertProjectPath(directory), { recursive: true, force: true });
  });
  await prepareTasksIndexStorage(path, () => {});
  return { repo, service };
}

const baseRule = (
  overrides?: Partial<ZCodeAutomationScheduleRule>,
): ZCodeAutomationScheduleRule => ({
  unit: "yearly",
  interval: 1,
  hour: 9,
  minute: 0,
  anchorAt: Date.now(),
  ...overrides,
});

test("yearly selecting a calendar-impossible month/day is rejected at creation", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(
    service.create({
      title: "t",
      prompt: "p",
      cronExpr: "0 9 31 4 *",
      workspacePath: "/synthetic-workspace",
      recurring: true,
      scheduleRule: baseRule({ months: [4], monthDays: [31] }),
    }),
    /非法的定时任务调度规则/,
  );
  await assert.rejects(
    service.create({
      title: "t",
      prompt: "p",
      cronExpr: "0 9 30 2 *",
      workspacePath: "/synthetic-workspace",
      recurring: true,
      scheduleRule: baseRule({ months: [2], monthDays: [30] }),
    }),
    /非法的定时任务调度规则/,
  );
});

test("yearly with months[0] infeasible is rejected even when a later month is feasible", async (t) => {
  // 引擎只读 months[0]；months=[2,7] 解析为 Feb 31 → 不可行。多值语义仅记录，不在本校验扩展。
  const { service } = await fixture(t);
  await assert.rejects(
    service.create({
      title: "t",
      prompt: "p",
      cronExpr: "0 9 31 2 *",
      workspacePath: "/synthetic-workspace",
      recurring: true,
      scheduleRule: baseRule({ months: [2, 7], monthDays: [31] }),
    }),
    /非法的定时任务调度规则/,
  );
});

test("Feb 29 stays valid and resolves to the next leap year", async (t) => {
  const { service } = await fixture(t);
  const created = await service.create({
    title: "t",
    prompt: "p",
    cronExpr: "0 9 29 2 *",
    workspacePath: "/synthetic-workspace",
    recurring: true,
    scheduleRule: baseRule({ months: [2], monthDays: [29] }),
  });
  assert.ok(created.nextRunAt);
  const next = new Date(created.nextRunAt);
  assert.equal(next.getMonth(), 1);
  assert.equal(next.getDate(), 29);
  assert.equal(
    (next.getFullYear() % 4 === 0 && next.getFullYear() % 100 !== 0) ||
      next.getFullYear() % 400 === 0,
    true,
  );
});

test("update re-anchors changed definitions before feasibility: caller-anchor infeasible is accepted", async (t) => {
  // 重锚定误拒回归：调用方携带的 rule.anchorAt（Jan 31）会让 months=[2] 无 monthDays 回退出
  // Feb 31，但定义已变更 → 引擎实际重锚定到 updatedAt（mock 当前 7 月 15 日）→ Feb 15 可行。
  // 可行性校验只允许作用于最终 canonical rule，不得用调用方旧 anchor 提前拒绝。
  const { repo, service } = await fixture(t);
  const clock = t.mock.timers;
  clock.enable({ apis: ["Date"], now: new Date(2026, 6, 15, 10, 0, 0).getTime() }); // 7 月 15 日
  try {
    const created = await service.create({
      title: "t",
      prompt: "p",
      cronExpr: "0 9 15 7 *",
      workspacePath: "/synthetic-workspace",
      recurring: true,
      scheduleRule: baseRule({ months: [7], monthDays: [15] }),
    });
    const updated = await service.update(created.automationId, {
      scheduleRule: {
        unit: "yearly",
        interval: 1,
        hour: 9,
        minute: 0,
        months: [2], // 定义变更（7→2）→ 重锚定到 updatedAt；monthDays 省略回退 anchor 日 15
        anchorAt: new Date(2026, 0, 31, 10, 0, 0).getTime(), // 调用方旧 anchor（Jan 31），不再代表引擎解析
      },
    });
    assert.ok(updated?.scheduleRule);
    assert.deepEqual(updated.scheduleRule.months, [2]);
    assert.equal(updated.scheduleRule.monthDays, undefined);
    // 重锚定后的 anchor 是 updatedAt（7 月 15 日），而非调用方旧 anchor。
    assert.equal(updated.scheduleRule.anchorAt, new Date(2026, 6, 15, 10, 0, 0).getTime());
    assert.ok(updated.nextRunAt); // Feb 15 2027 可行，任务有真实下一轮
  } finally {
    clock.reset();
  }
  assert.ok(await repo.get((await service.list()).at(0)?.automationId ?? ""));
});

test("monthly monthDays 31 stays valid (guard must not over-reject)", async (t) => {
  const { service } = await fixture(t);
  const created = await service.create({
    title: "t",
    prompt: "p",
    cronExpr: "0 9 31 * *",
    workspacePath: "/synthetic-workspace",
    recurring: true,
    scheduleRule: {
      unit: "monthly",
      interval: 1,
      hour: 9,
      minute: 0,
      monthDays: [31],
      monthlyMode: "date",
      anchorAt: Date.now(),
    },
  });
  assert.ok(created.nextRunAt);
});

test("anchor fallback: yearly February without monthDays resolves anchor day and rejects when impossible", async (t) => {
  const { service } = await fixture(t);
  const clock = t.mock.timers;
  // 创建于 1 月 30 日：anchor 回退取 anchor 日 → Feb 30 在所有年份都不存在。
  clock.enable({ apis: ["Date"], now: new Date(2026, 0, 30, 10, 0, 0).getTime() });
  try {
    await assert.rejects(
      service.create({
        title: "t",
        prompt: "p",
        cronExpr: "0 9 1 2 *",
        workspacePath: "/synthetic-workspace",
        recurring: true,
        scheduleRule: baseRule({ months: [2], anchorAt: Date.now() }),
      }),
      /非法的定时任务调度规则/,
    );
  } finally {
    clock.reset();
  }
});

test("updating an existing automation to an infeasible yearly rule is rejected atomically", async (t) => {
  const { repo, service } = await fixture(t);
  const created = await service.create({
    title: "t",
    prompt: "p",
    cronExpr: "0 9 15 7 *",
    workspacePath: "/synthetic-workspace",
    recurring: true,
    scheduleRule: baseRule({ months: [7], monthDays: [15] }),
  });
  const before = await repo.get(created.automationId);
  assert.ok(before);
  await assert.rejects(
    service.update(created.automationId, {
      scheduleRule: baseRule({ months: [4], monthDays: [31] }),
    }),
    /非法的定时任务调度规则/,
  );
  const after = await repo.get(created.automationId);
  assert.deepEqual(after, before);
  // months[0]=7 → Jul 31 可行：允许更新（引擎只读首项的既有语义）。
  const updated = await service.update(created.automationId, {
    scheduleRule: baseRule({ months: [7, 2], monthDays: [31] }),
  });
  assert.ok(updated?.scheduleRule);
  assert.deepEqual(updated.scheduleRule.months, [7, 2]);
});
