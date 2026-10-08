import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { AutomationService } from "../src/session/automationService.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "zcodium-automation-controls-"));
  const path = join(directory, "tasks.sqlite");
  const repo = new AutomationRepo(path);
  const userRepo = new AutomationRepo(path);
  const service = new AutomationService(userRepo);
  t.after(async () => {
    userRepo.close();
    repo.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const now = Date.now();
  const create = (recurring = true, maxRuns?: number, endAt?: number) =>
    repo.create(
      {
        title: "Lifecycle fixture",
        prompt: "Synthetic task; never dispatched to a model",
        cronExpr: "* * * * *",
        workspacePath: "/synthetic-workspace",
        recurring,
        maxRuns,
        endAt,
      },
      { nextRunAt: now - 1 },
    );
  return { repo, service, now, create };
}

test("a successful in-flight dispatch preserves pause until the user resumes", async (t) => {
  const { repo, service, now, create } = await fixture(t);
  const { automationId } = await create();
  assert.equal((await repo.claimDue(now)).length, 1);
  await service.setEnabled(automationId, false);
  await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt: now + 60_000 });
  const paused = await repo.get(automationId);
  assert.equal(paused?.runCount, 1);
  assert.equal(paused?.enabled, false);
  assert.equal(paused?.lifecycleStatus, "paused");
  assert.deepEqual(await repo.claimDue(now + 60_001), []);
  await service.setEnabled(automationId, true);
  assert.equal((await repo.claimDue(now + 60_001)).length, 1);
});

test("the final accepted run still completes a paused finite automation", async (t) => {
  const { repo, service, now, create } = await fixture(t);
  const { automationId } = await create(false, 1);
  await repo.claimDue(now);
  await service.setEnabled(automationId, false);
  await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt: now + 60_000 });
  const completed = await repo.get(automationId);
  assert.equal(completed?.lifecycleStatus, "completed");
  assert.equal(completed?.enabled, false);
  assert.equal(completed?.nextRunAt, undefined);
});

for (const edit of ["extend", "clear"] as const) {
  test(`editing only endAt (${edit}) cannot revive an exhausted automation`, async (t) => {
    const { repo, service, now, create } = await fixture(t);
    const { automationId } = await create(false, 1, now + 60_000);
    await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt: now + 60_000 });
    const updated = await service.update(automationId, {
      endAt: edit === "extend" ? now + 86_400_000 : null,
    });
    assert.equal(updated?.lifecycleStatus, "completed");
    assert.equal(updated?.enabled, false);
    assert.equal(updated?.nextRunAt, undefined);
    assert.deepEqual(await repo.claimDue(now + 120_000), []);
  });
}

test("extending the deadline revives a finite automation with remaining runs", async (t) => {
  const { repo, service, now, create } = await fixture(t);
  const { automationId } = await create(false, 3, now + 1);
  await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt: now + 60_000 });
  assert.equal((await repo.get(automationId))?.lifecycleStatus, "completed");
  const updated = await service.update(automationId, { endAt: now + 86_400_000 });
  assert.equal(updated?.lifecycleStatus, "active");
  assert.equal(updated?.enabled, true);
  assert.ok(updated?.nextRunAt);
  assert.equal((await repo.claimDue(updated.nextRunAt)).length, 1);
});

test("increasing the run limit cannot override an expired deadline", async (t) => {
  const { repo, service, now, create } = await fixture(t);
  const { automationId } = await create(false, 1, now - 1);
  await repo.claimDue(now);
  const updated = await service.update(automationId, { maxRuns: 3 });
  assert.equal(updated?.lifecycleStatus, "completed");
  assert.equal(updated?.enabled, false);
  assert.equal(updated?.nextRunAt, undefined);
});

test("manual runs do not consume the scheduled limit when extending a deadline", async (t) => {
  const { repo, service, now, create } = await fixture(t);
  const { automationId } = await create(false, 1);
  const manual = await service.runNow(automationId);
  assert.ok(manual);
  await repo.markManualRunDispatched({ runId: manual.run.runId, dispatchedAt: now });
  await repo.releaseManualClaim(automationId, "/synthetic-workspace");
  const updated = await service.update(automationId, { endAt: now + 86_400_000 });
  assert.equal(updated?.runCount, 1);
  assert.equal(await repo.getScheduledRunCount(automationId), 0);
  assert.equal(updated?.lifecycleStatus, "active");
  assert.ok(updated?.nextRunAt);
  assert.equal((await repo.claimDue(updated.nextRunAt)).length, 1);
});

test("deadline changes preserve workspace identity isolation", async (t) => {
  const { service, now, create } = await fixture(t);
  const { automationId } = await create(false, 1);
  assert.equal(
    await service.update(
      automationId,
      { endAt: now + 86_400_000 },
      {
        workspacePath: "/synthetic-workspace",
        workspaceIdentity: "different-workspace",
      },
    ),
    null,
  );
});
