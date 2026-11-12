import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeContextStoreConflictError,
  SessionEventType,
  type MessageCommitBundle,
  type MessageWithParts,
} from "@zcode/contracts";
import type { NativeContextCommit } from "@zcode/shared/native-context-compression";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";
import { PARENT } from "./native-context-boundary-fixture.js";
import { MAIN_USAGE } from "./native-context-maintenance-goal-fixture.js";
import { USAGE } from "./native-context-maintenance-fixture.js";
import {
  COMPACT_SUMMARY,
  compactPersistenceFixture,
  persistedValue,
} from "./native-context-compact-persistence-fixture.js";

function savedSummary(messages: MessageWithParts[]) {
  return messages.find((message) =>
    message.parts.some((part) => part.type === "compaction" && part.compactBoundary !== undefined),
  );
}

async function assertPaidCompact(f: Awaited<ReturnType<typeof compactPersistenceFixture>>) {
  assert.equal(f.calls.length, 2, "one native summary and one complete compact physical call");
  const compactRecords = f.usageRecords.filter((record) => record.querySource === "compact");
  assert.equal(compactRecords.length, 1);
  const record = compactRecords[0]!;
  assert.equal(
    record.status,
    "completed",
    "content/reset storage rejection is not a model failure",
  );
  assert.equal(record.logicalRequestId, f.calls[1]!.requestId);
  assert.equal(record.attemptIndex, 0);
  assert.equal(record.inputTokens, MAIN_USAGE.inputTokens);
  assert.equal(record.outputTokens, MAIN_USAGE.outputTokens);
  assert.equal(record.cacheReadInputTokens, 0);
  assert.equal(record.providerTotalTokens, undefined);
  assert.deepEqual(record.rawUsage, MAIN_USAGE);
  assert.equal(
    JSON.stringify(f.calls[1]!.request.messages).includes(f.rawText),
    true,
    "deep compact reads the canonical full history despite the existing native summary view",
  );
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(usage.modelRequestCount, 2);
  assert.equal(usage.modelErrorCount, 0);
  assert.equal(usage.inputTokens, USAGE.inputTokens! + MAIN_USAGE.inputTokens!);
  assert.equal(usage.outputTokens, USAGE.outputTokens! + MAIN_USAGE.outputTokens!);
  assert.equal(
    usage.totalTokens,
    USAGE.inputTokens! + USAGE.outputTokens! + MAIN_USAGE.inputTokens! + MAIN_USAGE.outputTokens!,
  );
  return usage;
}

async function assertOriginals(
  f: Awaited<ReturnType<typeof compactPersistenceFixture>>,
  target: Pick<typeof f, "agent" | "store"> = f,
) {
  for (const original of f.originals)
    assert.deepEqual(
      await target.store.messageWithParts({
        sessionID: PARENT,
        messageID: original.info.id,
      }),
      original,
    );
  for (const [ref, text] of f.sourceTexts) {
    const page = await target.agent.readNativeContextSource({ ref, limitTokens: 25_000 });
    assert.equal(page.originalAvailable, true);
    assert.equal(page.nextOffset, null);
    assert.equal(
      page.text === text,
      true,
      "the exact canonical original remains readable by its old ref",
    );
  }
}

test("NCTX-54 complete /compact summary bundle failure preserves the real committed native view and paid model facts", async (t) => {
  const f = await compactPersistenceFixture(t);
  const summaryAttempts: {
    bundle: MessageCommitBundle;
    before: Awaited<ReturnType<typeof f.snapshot>>;
  }[] = [];
  let resetAttempts = 0;
  f.runtime.sessionStore = new Proxy(f.port, {
    get(target, key) {
      if (key === "commitMessageBundle")
        return async (bundle: MessageCommitBundle) => {
          if (savedSummary(bundle.messages)) {
            // 普通 compact timeline 也有 compaction part，只有真实 boundary bundle 是本次故障窗口。
            summaryAttempts.push({ bundle: structuredClone(bundle), before: await f.snapshot() });
            throw new Error("Synthetic compact summary bundle storage rejection.");
          }
          await f.store.commitMessageBundle(bundle);
        };
      if (key === "commitNativeContext")
        return async (sessionId: typeof PARENT, commit: NativeContextCommit) => {
          if (commit.state.compactBoundaryId !== f.seeded.state.compactBoundaryId) resetAttempts++;
          await f.store.commitNativeContext(sessionId, commit);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(f.agent.executeTurn("/compact"));
  assert.equal(summaryAttempts.length, 1, "reach the real atomically persisted summary bundle");
  assert.equal(resetAttempts, 0, "unsaved summary cannot reset native state");
  const checkpoint = summaryAttempts[0]!.before;
  const summary = savedSummary(summaryAttempts[0]!.bundle.messages)!;
  assert.ok(summary.info.role === "user" && summary.info.summary?.body?.includes(COMPACT_SUMMARY));
  assert.equal(
    await f.store.messageWithParts({ sessionID: PARENT, messageID: summary.info.id }),
    null,
  );
  assert.equal(savedSummary(await f.store.messages({ sessionID: PARENT })), undefined);
  assert.equal(
    f.events.some((event) => event.type === SessionEventType.CompactBoundary),
    false,
  );
  assert.deepEqual(f.runtime.messageHistory.borrowReadOnlyRuntimeEntries(), checkpoint.entries);
  assert.deepEqual(f.view(f.runtime), checkpoint.projection);
  assert.deepEqual(persistedValue(f.owner.state), checkpoint.native.state);
  assert.deepEqual(await f.store.getNativeContextForkBundle(PARENT), checkpoint.native);
  assert.equal(f.owner.state?.compactBoundaryId, f.seeded.state.compactBoundaryId);
  assert.equal(f.owner.state?.generation, f.seeded.state.generation);
  assert.deepEqual(checkpoint.native.observations, f.seeded.observations);
  assert.deepEqual(checkpoint.native.operations, f.seeded.operations);
  await assertOriginals(f);
  const paid = await assertPaidCompact(f);
  const goal = await f.store.readTarget({ sessionID: PARENT });
  const callsBeforeRecovery = f.calls.length;
  const cold = await f.coldRestart();
  const recovered = await cold.store.getNativeContextForkBundle(PARENT);
  assert.ok(recovered);
  assert.equal(recovered.state.compactBoundaryId, f.seeded.state.compactBoundaryId);
  assert.deepEqual(kernelOf(recovered.state), kernelOf(checkpoint.native.state));
  assert.deepEqual(recovered.operations, checkpoint.native.operations);
  assert.deepEqual(recovered.observations, checkpoint.native.observations);
  assert.deepEqual(await cold.store.queryTaskUsage({ sessionID: PARENT }), paid);
  assert.equal((await cold.store.readTarget({ sessionID: PARENT }))?.tokensUsed, goal?.tokensUsed);
  assert.equal(f.calls.length, callsBeforeRecovery);
  await assertOriginals(f, cold);
});

test("NCTX-54 complete /compact native reset CAS failure repairs the saved real boundary through file-backed fresh-owner resume", async (t) => {
  const f = await compactPersistenceFixture(t);
  const resetAttempts: {
    commit: NativeContextCommit;
    before: Awaited<ReturnType<typeof f.snapshot>>;
  }[] = [];
  const rejected: unknown[] = [];
  f.runtime.sessionStore = new Proxy(f.port, {
    get(target, key) {
      if (key === "commitNativeContext")
        return async (sessionId: typeof PARENT, commit: NativeContextCommit) => {
          if (commit.state.compactBoundaryId !== f.seeded.state.compactBoundaryId) {
            const before = await f.snapshot();
            resetAttempts.push({ commit: structuredClone(commit), before });
            assert.ok(
              savedSummary(await f.store.messages({ sessionID: PARENT })),
              "summary must be durable before injecting native CAS rejection",
            );
            // 用公开 SQLite CAS 保存一次竞争的旧段 revision，让真实 reset 的冻结 compare 失效；
            // 原转换与数字不变，禁止 stub reset/recover 或预先假写 compact 边界。
            await f.store.commitNativeContext(sessionId, {
              expectedRevision: before.native.state.revision,
              expectedGeneration: before.native.state.generation,
              state: {
                ...structuredClone(before.native.state),
                revision: before.native.state.revision + 1,
              },
            });
            try {
              await f.store.commitNativeContext(sessionId, commit);
            } catch (error) {
              rejected.push(error);
              throw error;
            }
            return;
          }
          await f.store.commitNativeContext(sessionId, commit);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(f.agent.executeTurn("/compact"));
  assert.equal(resetAttempts.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0] instanceof NativeContextStoreConflictError);
  assert.equal(rejected[0].reason, "revision");
  const attempted = resetAttempts[0]!;
  const saved = savedSummary(await f.store.messages({ sessionID: PARENT }));
  assert.ok(saved?.info.role === "user" && saved.info.summary?.body?.includes(COMPACT_SUMMARY));
  const boundaryPart = saved.parts.find(
    (part) => part.type === "compaction" && part.compactBoundary,
  );
  assert.ok(boundaryPart?.type === "compaction" && boundaryPart.compactBoundary);
  const boundary = boundaryPart.compactBoundary;
  assert.notEqual(boundary.boundaryId, f.seeded.state.compactBoundaryId);
  assert.equal(attempted.commit.state.compactBoundaryId, boundary.boundaryId);
  assert.ok(
    f.runtime.messageHistory
      .borrowReadOnlyRuntimeEntries()
      .some((entry) => entry.canonical?.messageId === saved.info.id),
    "Runtime already replaced the history with the real persisted summary",
  );
  assert.equal(f.runtime.latestConversationMessageId, saved.info.id);
  assert.equal(
    f.events.some((event) => event.type === SessionEventType.CompactBoundary),
    true,
  );
  const stale = await f.store.getNativeContextForkBundle(PARENT);
  assert.ok(stale);
  assert.equal(stale.state.revision, attempted.before.native.state.revision + 1);
  assert.deepEqual(
    { ...stale.state, revision: attempted.before.native.state.revision },
    attempted.before.native.state,
  );
  assert.deepEqual(stale.operations, f.seeded.operations);
  assert.deepEqual(stale.observations, f.seeded.observations);
  assert.ok(kernelOf(stale.state).compression.blocks.some((block) => block.active));
  assert.deepEqual(persistedValue(f.owner.state), attempted.before.native.state);
  await assertOriginals(f);
  const paid = await assertPaidCompact(f);
  const goal = await f.store.readTarget({ sessionID: PARENT });
  const callsBeforeRecovery = f.calls.length;
  const cold = await f.coldRestart();
  const recovered = await cold.store.getNativeContextForkBundle(PARENT);
  assert.ok(recovered);
  assert.equal(recovered.state.compactBoundaryId, boundary.boundaryId);
  assert.equal(recovered.state.generation, stale.state.generation);
  assert.equal(cold.runtime.branchGeneration, stale.state.generation);
  assert.deepEqual(recovered.state.policy, stale.state.policy);
  assert.ok(recovered.state.revision > stale.state.revision);
  assert.equal(
    (await cold.agent.getNativeContextCompression()).currentSegmentId,
    boundary.boundaryId,
  );
  assert.deepEqual(kernelOf(recovered.state).compression.blocks, []);
  assert.deepEqual(kernelOf(recovered.state).views, {});
  assert.deepEqual(kernelOf(recovered.state).projectionOperations?.blocks ?? {}, {});
  assert.deepEqual(kernelOf(recovered.state).projectionOperations?.views ?? {}, {});
  assert.deepEqual(recovered.state.sources, stale.state.sources);
  assert.deepEqual(
    kernelOf(recovered.state).compression.messageRefs,
    kernelOf(stale.state).compression.messageRefs,
  );
  assert.equal(recovered.state.requestSeq, stale.state.requestSeq);
  assert.deepEqual(recovered.observations, stale.observations);
  assert.deepEqual(
    (await cold.store.listNativeContextObservations(PARENT, { purpose: "main" })).items,
    [],
  );
  const markers = recovered.operations.filter((operation) => operation.kind === "compact-boundary");
  assert.equal(markers.length, 1);
  assert.equal(markers[0]!.status, "completed");
  assert.equal(markers[0]!.segmentId, boundary.boundaryId);
  assert.equal(markers[0]!.anchorMessageId, saved.info.id);
  assert.equal(markers[0]!.beforeEstimate, null);
  assert.equal(markers[0]!.afterEstimate, null);
  assert.equal(markers[0]!.model, null);
  assert.equal(markers[0]!.anchorRequestSeq, null);
  assert.deepEqual(markers[0]!.observationIds, []);
  assert.deepEqual(
    recovered.operations.filter((operation) => operation.kind !== "compact-boundary"),
    stale.operations,
  );
  await assertOriginals(f, cold);
  assert.deepEqual(await cold.store.queryTaskUsage({ sessionID: PARENT }), paid);
  assert.equal((await cold.store.readTarget({ sessionID: PARENT }))?.tokensUsed, goal?.tokensUsed);
  await cold.agent.resumeFromStore();
  const repeated = await cold.store.getNativeContextForkBundle(PARENT);
  assert.ok(repeated);
  assert.equal(repeated.state.compactBoundaryId, boundary.boundaryId);
  assert.deepEqual(repeated.operations, recovered.operations);
  assert.deepEqual(repeated.observations, recovered.observations);
  assert.deepEqual(await cold.store.queryTaskUsage({ sessionID: PARENT }), paid);
  assert.equal(
    f.calls.length,
    callsBeforeRecovery,
    "cold or repeated resume never reissues the paid compact",
  );
});
