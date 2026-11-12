import assert from "node:assert/strict";
import test from "node:test";
import { getModelUsageTotalTokens } from "@zcode/contracts";
import { runNativeMaintenance } from "../src/runtime/native-context-compression/maintenance.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";
import { projectNativeEntries } from "../src/runtime/native-context-compression/projection.js";
import { ownedNativeSourceText } from "../src/runtime/native-context-compression/read.js";
import {
  finalCommitFixture,
  NEW_SUMMARY,
  OLD_SUMMARY,
} from "./native-context-final-commit-fixture.js";
import { USAGE } from "./native-context-maintenance-fixture.js";
import { PARENT } from "./native-context-boundary-fixture.js";

for (const settlementFails of [false, true]) {
  test(`a paid successful native candidate commit failure preserves the durable old view across cold restart (settlement also fails=${settlementFails})`, async (t) => {
    const f = await finalCommitFixture(t, settlementFails);
    // 内核可含显式 undefined；SQLite JSON 持久化会省略它，不能把该格式差异误判为半提交。
    const durableKernelBefore = JSON.parse(JSON.stringify(kernelOf(f.before)));
    const execution = runNativeMaintenance(f.runtime, f.safePoint(), "manual");
    if (settlementFails) await assert.rejects(execution);
    else {
      const outcome = await execution;
      assert.equal(outcome.operation?.status, "error");
      assert.equal(outcome.operation?.reason, "storage-error");
      assert.notEqual(outcome.operation?.status, "completed");
    }
    assert.equal(f.candidateWrites.length, 1);
    assert.equal(f.calls.length, 2);
    assert.equal(f.owner.phase, "idle");
    assert.equal(
      f.owner.pendingOperationIds.length,
      1,
      "only the successful seed may be pending for the next main request",
    );
    assert.deepEqual(kernelOf(f.owner.state!), kernelOf(f.before));
    assert.deepEqual(f.owner.state!.sources, f.before.sources);
    assert.deepEqual(await f.store.messages({ sessionID: PARENT }), f.canonicalBefore);
    const durable = await f.store.getNativeContextState(PARENT);
    assert.ok(durable);
    assert.deepEqual(kernelOf(durable), durableKernelBefore);
    const usageBeforeRestart = await f.store.queryTaskUsage({ sessionID: PARENT });
    const goalBeforeRestart = await f.store.readTarget({ sessionID: PARENT });
    assert.ok(USAGE.inputTokens !== undefined && USAGE.outputTokens !== undefined);
    assert.equal(usageBeforeRestart.modelRequestCount, 2);
    assert.equal(usageBeforeRestart.inputTokens, USAGE.inputTokens * 2);
    assert.equal(usageBeforeRestart.outputTokens, USAGE.outputTokens * 2);
    assert.equal(goalBeforeRestart?.tokensUsed, getModelUsageTotalTokens(USAGE) * 2);
    const paidRows = (
      await f.store.listNativeContextObservations(PARENT, { purpose: "maintenance", limit: 200 })
    ).items;
    assert.equal(paidRows.length, 2);
    assert.ok(
      paidRows.every(
        (row) => row.status === "completed" && row.actualInputTokens === USAGE.inputTokens,
      ),
    );
    const rejectedId = [...f.rejectedOperationIds][0]!;
    const operationBefore = await f.store.getNativeContextOperation(PARENT, rejectedId);
    assert.equal(operationBefore?.status, settlementFails ? "running" : "error");
    if (!settlementFails) assert.equal(operationBefore?.reason, "storage-error");
    assert.equal(f.settlementRejections() > 0, settlementFails);
    const cold = await f.coldRestart();
    const recovered = await cold.store.getNativeContextOperation(PARENT, rejectedId);
    assert.equal(recovered?.status, settlementFails ? "obsolete" : "error");
    if (!settlementFails) assert.equal(recovered?.reason, "storage-error");
    assert.notEqual(
      recovered?.status,
      "completed",
      "recovery cannot promote an uncommitted candidate",
    );
    assert.deepEqual(kernelOf(cold.owner.state!), durableKernelBefore);
    assert.deepEqual(await cold.store.messages({ sessionID: PARENT }), f.canonicalBefore);
    assert.deepEqual(await cold.store.queryTaskUsage({ sessionID: PARENT }), usageBeforeRestart);
    assert.equal(
      (await cold.store.readTarget({ sessionID: PARENT }))?.tokensUsed,
      goalBeforeRestart?.tokensUsed,
    );
    assert.equal(f.calls.length, 2, "cold recovery cannot issue a replacement model request");
    const projection = projectNativeEntries(
      cold.runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
      cold.owner.state!,
    );
    const projected = JSON.stringify(projection);
    assert.ok(projected.includes(OLD_SUMMARY));
    assert.equal(projected.includes(NEW_SUMMARY), false);
    for (const source of cold.owner.state!.sources.filter((item) => item.kind !== "image")) {
      assert.equal(source.originalAvailable, true);
      assert.ok(
        await ownedNativeSourceText(cold.owner, source),
        "all current canonical originals remain readable",
      );
    }
  });
}
