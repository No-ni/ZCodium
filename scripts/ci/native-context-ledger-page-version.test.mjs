import assert from "node:assert/strict";
import test from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

const root = "packages/desktop/test/e2e/helpers/native-context-compression/";
const seedVersion = { revision: 0, generation: 0, historyVersion: "a".repeat(64) };
const resumeVersion = { revision: 1, generation: 0, historyVersion: "b".repeat(64) };

async function fixture(changeEnvelope = (_read, version) => version) {
  const operations = Array.from({ length: 15 }, (_, index) => ({
    operationId: "ledger-operation-" + index,
    sequence: index + 1,
    status: index % 3 === 0 ? "failed" : "completed",
    ...seedVersion,
  }));
  const observations = Array.from({ length: 3000 }, (_, index) => ({
    id: "ledger-observation-" + index,
    sequence: index + 1,
    purpose: index < 2970 ? "main" : index < 2985 ? "maintenance" : "decision",
    operationIds: index >= 2970 ? [operations[(index - 2970) % 15].operationId] : [],
    ...seedVersion,
  })).reverse();
  const manifest = {
    ...seedVersion,
    resumeExpected: resumeVersion,
    counts: { observations: 3000, main: 2970, maintenance: 15, decision: 15 },
    operations,
  };
  const original = JSON.stringify({ observations, operations, manifest });
  const target = { sessionId: "ledger-fixture-session" };
  const status = { ...resumeVersion, policy: { mode: "manual", policyVersion: 0 } };
  let reads = 0;
  let observationChecks = 0;
  const collect = await loadComponentCallback(
    root + "ledger-assertions.ts",
    "collectNativeContextLedgerPages",
    { assert },
  );
  const page = (rows, options) => {
    const eligible = rows.filter(
      (row) => options.cursor === undefined || row.sequence < options.cursor,
    );
    const items = eligible.slice(0, options.limit);
    reads++;
    return {
      ...changeEnvelope(reads, resumeVersion),
      items,
      nextCursor: eligible.length > options.limit ? items.at(-1).sequence : null,
    };
  };
  const run = await loadComponentCallback(
    root + "ledger.ts",
    "assertNativeContextLargeLedgerHostPages",
    {
      assert,
      openNativeContextLargeLedger: async (input) => {
        assert.equal(input, manifest);
        return { target, status, requestsBefore: 0 };
      },
      collectNativeContextLedgerPages: collect,
      assertNativeContextLedgerObservations: (input, items) => {
        observationChecks++;
        assert.equal(input, manifest);
        assert.deepEqual(items, observations);
        assert.ok(items.every((item) => item.revision === 0));
      },
      listNativeContextObservations: async (address, version, options) => {
        assert.equal(address, target);
        assert.equal(version, status);
        return page(
          observations.filter(
            (item) =>
              (!options.purpose || item.purpose === options.purpose) &&
              (!options.operationId || item.operationIds.includes(options.operationId)),
          ),
          options,
        );
      },
      listNativeContextRecords: async (address, version, options) => {
        assert.equal(address, target);
        assert.equal(version, status);
        return page([...operations].reverse(), options);
      },
      readNativeContextRecord: async (_address, version, operationId) => {
        assert.equal(version, status);
        const operation = operations.find((item) => item.operationId === operationId);
        assert.ok(operation);
        return {
          sourceTotal: 4,
          nextSourceCursor: null,
          summary: operation.status === "completed" ? "fixture summary" : "",
        };
      },
    },
  );
  return {
    run: () => run(manifest),
    reads: () => reads,
    observationChecks: () => observationChecks,
    assertUnchanged: () =>
      assert.equal(JSON.stringify({ observations, operations, manifest }), original),
  };
}

test("实际 Host 分页以精确恢复版本查询，3000 观察和15记录保持冻结种子版本", async () => {
  const f = await fixture();
  const result = await f.run();
  assert.equal(result.allPages, 15);
  assert.equal(result.recordPages, 5);
  assert.equal(result.status.revision, 1);
  assert.equal(result.status.historyVersion, resumeVersion.historyVersion);
  assert.equal(f.observationChecks(), 1);
  assert.ok(f.reads() > 30);
  f.assertUnchanged();
});

test("实际恢复分页拒绝旧 seed envelope，即使页内冻结观察完全正确", async () => {
  const f = await fixture(() => seedVersion);
  await assert.rejects(f.run(), { name: "AssertionError" });
  assert.equal(f.reads(), 1);
  assert.equal(f.observationChecks(), 0);
  f.assertUnchanged();
});

for (const [name, late] of [
  ["同 revision 的旧 hash", { ...resumeVersion, historyVersion: seedVersion.historyVersion }],
  ["未来 revision", { ...resumeVersion, revision: 2 }],
])
  test("实际恢复分页拒绝续页的" + name + "，不合并迟到记录", async () => {
    const f = await fixture((read, version) => (read === 2 ? late : version));
    await assert.rejects(f.run(), { name: "AssertionError" });
    assert.equal(f.reads(), 2);
    assert.equal(f.observationChecks(), 0);
    f.assertUnchanged();
  });
