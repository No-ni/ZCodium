import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  buildStoragePreparationFixture,
  runStoragePreparation,
} from "./fixtures/native-context-storage-worker.mjs";

let fixture;
before(async () => {
  fixture = await buildStoragePreparationFixture();
});

test(
  "storage preparation Worker retains its transport through prepared and then exits naturally",
  { timeout: 15000 },
  async (t) => {
    const result = await runStoragePreparation(t, fixture);
    assert.equal(
      result.prepared,
      true,
      "ACK must lead to completed storage preparation, not an early exit0",
    );
    assert.equal(
      result.settledWorker,
      true,
      "the real prepare promise must settle after its final write callback",
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.databaseBytes > 0);
    assert.equal(result.phases.at(-1)?.phase, "ready");
    assert.ok(result.phases.at(-1)?.committedCount > 0);
  },
);

test(
  "a real SQLite startup failure never reports prepared and the Worker exits unsuccessfully",
  { timeout: 15000 },
  async (t) => {
    const result = await runStoragePreparation(t, fixture, {
      failDatabase: true,
    });
    assert.equal(result.pathReceived, true);
    assert.equal(result.acknowledged, true);
    assert.equal(result.prepared, false);
    assert.equal(result.failed, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.phases.at(-1)?.phase, "failed");
    assert.equal(result.databaseBytes, null);
  },
);

test(
  "a Host-authorized reuse ACK completes without opening or creating another database",
  { timeout: 15000 },
  async (t) => {
    const result = await runStoragePreparation(t, fixture, { reuse: true });
    assert.equal(result.prepared, true);
    assert.equal(result.settledWorker, true);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.phases, []);
    assert.equal(result.databaseBytes, null);
  },
);

test(
  "the same real storage entry remains valid as a child process with parentPort null",
  { timeout: 15000 },
  async (t) => {
    const result = await runStoragePreparation(t, fixture, {
      childProcess: true,
    });
    assert.equal(result.prepared, true);
    assert.equal(result.settledParentNull, true);
    assert.equal(result.settledWorker, false);
    assert.equal(result.exitCode, 0);
    assert.ok(result.databaseBytes > 0);
    assert.equal(result.phases.at(-1)?.phase, "ready");
  },
);
