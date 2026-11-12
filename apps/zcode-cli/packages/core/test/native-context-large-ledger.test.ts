import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createMessageId, createPartId, createProjectId, createSessionId } from "@zcode/contracts";
import {
  createRecommendedNativeContextConfiguration,
  nativeContextCacheHitPercent,
} from "@zcode/shared/native-context-compression";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";
import {
  assertNativeContextLedgerObservations,
  collectNativeContextLedgerPages,
} from "../../../../../packages/desktop/test/e2e/helpers/native-context-compression/ledger-assertions.js";
import { nativeContextLedgerManifestSchema } from "../../../../../packages/desktop/test/e2e/helpers/native-context-compression/ledger-fixture-contract.js";
import { seedNativeContextLargeLedgerForE2E } from "../../../../../packages/desktop/test/e2e/helpers/native-context-compression/ledger-seed.js";
import {
  buildNativeContextChartRows,
  type NativeContextChartPoint,
} from "../../../../../packages/ui/src/native-context-compression/domain/chart.js";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { historyVersionOf } from "../src/runtime/native-context-compression/identity.js";
import { recoverNativeContext } from "../src/runtime/native-context-compression/boundaries.js";
import { initialNativeState, kernelOf } from "../src/runtime/native-context-compression/state.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";
import { resolveNativeContextLedgerSeedPaths } from "./native-context-large-ledger-seed.js";

const model = { providerId: "nctx-ledger-replay", modelId: "nctx-ledger-model" };

test("ledger seed rejects a home or Host DB outside its explicit sandbox before writing", async () => {
  const sandboxRoot = await createProjectTestFixture("nctx-ledger-paths");
  const base = { sandboxRoot, homeDir: join(sandboxRoot, "home"), model, version: "3.17.1" };
  await assert.rejects(
    resolveNativeContextLedgerSeedPaths({
      ...base,
      homeDir: join(sandboxRoot, "..", "other-home"),
    }),
    /NCTX_LEDGER_HOME_OUTSIDE_SANDBOX/,
  );
  await assert.rejects(
    resolveNativeContextLedgerSeedPaths({
      ...base,
      expectedDbPath: join(sandboxRoot, "wrong.sqlite"),
    }),
    /NCTX_LEDGER_HOST_DB_MISMATCH/,
  );
  await assert.rejects(
    resolveNativeContextLedgerSeedPaths({
      ...base,
      sandboxRoot: join(sandboxRoot, "..", "..", "..", "outside"),
    }),
    /NCTX_LEDGER_SANDBOX_MISMATCH/,
  );
});

test("NCTX-58 public SQLite seed preserves the 3000 original observation ledger", async (t) => {
  const sandboxRoot = await createProjectTestFixture("nctx-large-ledger");
  const seedOptions = { sandboxRoot, homeDir: join(sandboxRoot, "home"), model, version: "3.17.1" };
  const paths = await resolveNativeContextLedgerSeedPaths(seedOptions);
  await mkdir(dirname(paths.dbPath), { recursive: true });
  const neighbor = await createSqliteSessionStore({ dbPath: paths.dbPath });
  t.after(() => neighbor.close());
  const neighborId = createSessionId("nctx-ledger-existing-neighbor");
  await neighbor.createSession({
    id: neighborId,
    projectID: createProjectId("nctx-ledger-existing"),
    slug: "existing-neighbor",
    title: "已存在的合成任务",
    titleSource: "custom",
    version: "3.17.1",
    directory: paths.workspacePath,
  });
  const messageId = createMessageId("nctx-ledger-existing-message");
  const neighborMessages = [
    {
      info: {
        id: messageId,
        sessionID: neighborId,
        agent: "fixture",
        role: "user" as const,
        time: { created: 100 },
      },
      parts: [
        {
          id: createPartId("nctx-ledger-existing-text"),
          messageID: messageId,
          sessionID: neighborId,
          type: "text" as const,
          text: "既有任务保留原内容",
        },
      ],
    },
  ];
  await neighbor.commitMessageBundle({ sessionID: neighborId, messages: neighborMessages });
  const neighborHistory = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({ history: neighborHistory, messages: neighborMessages });
  const neighborRuntime = {
    sessionId: neighborId,
    branchGeneration: 0,
    config: {},
    messageHistory: neighborHistory,
    workingDirectory: paths.workspacePath,
    workspaceRoot: paths.workspacePath,
  } as unknown as AgentRuntimeInternal;
  const neighborState = initialNativeState(neighborRuntime);
  neighborState.policy = {
    ...createRecommendedNativeContextConfiguration("manual"),
    policyVersion: 2,
  };
  syncNativeSources(neighborState, neighborHistory.borrowReadOnlyRuntimeEntries(), (text) =>
    Math.ceil(text.length / 4),
  );
  await neighbor.commitNativeContext(neighborId, {
    expectedRevision: null,
    expectedGeneration: 0,
    state: neighborState,
  });
  const neighborBefore = {
    session: await neighbor.getSession(neighborId),
    messages: await neighbor.messages({ sessionID: neighborId }),
    native: await neighbor.getNativeContextForkBundle(neighborId),
  };
  const previousEnv = Object.fromEntries(
    ["PROJECT_TEST_SANDBOX_ROOT", "ZCODE_E2E_HOME_DIR", "ZCODE_SESSION_DB_PATH"].map((name) => [
      name,
      process.env[name],
    ]),
  );
  process.env.PROJECT_TEST_SANDBOX_ROOT = sandboxRoot;
  process.env.ZCODE_E2E_HOME_DIR = seedOptions.homeDir;
  process.env.ZCODE_SESSION_DB_PATH = paths.dbPath;
  const manifest = await (async () => {
    try {
      return await seedNativeContextLargeLedgerForE2E({
        model,
        version: "3.17.1",
        hostPreferences: { memoryEnabled: false },
      });
    } finally {
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  })();
  const manifestPath = join(sandboxRoot, `${manifest.namespace}.json`);
  assert.deepEqual(
    nativeContextLedgerManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8"))),
    manifest,
  );
  const sessionId = createSessionId(manifest.namespace);
  assert.equal(sessionId, manifest.sessionId);
  // seed 已经关闭 writer；此处是真正的磁盘冷打开，不把 :memory: 查读当作持久化证据。
  const store = await createSqliteSessionStore({ dbPath: manifest.dbPath });
  t.after(() => store.close());
  const page = (purpose?: "main" | "maintenance" | "decision") =>
    collectNativeContextLedgerPages(
      manifest,
      purpose ? manifest.counts[purpose] : manifest.counts.observations,
      (cursor, limit) =>
        store.listNativeContextObservations(sessionId, {
          cursor,
          limit,
          purpose,
          expectedRevision: 0,
        }),
      (item) => item.id,
    );
  const all = await page();

  await t.test(
    "seeding an already-open database preserves every neighboring session fact",
    async () => {
      assert.deepEqual(
        {
          session: await neighbor.getSession(neighborId),
          messages: await neighbor.messages({ sessionID: neighborId }),
          native: await neighbor.getNativeContextForkBundle(neighborId),
        },
        neighborBefore,
      );
      assert.equal(
        (await neighbor.getNativeContextForkBundle(sessionId))!.observations.length,
        3000,
      );
      assert.equal((await store.getNativeContextState(neighborId)) !== null, true);
    },
  );

  await t.test(
    "all-purpose and purpose-specific pages reach null without duplicate physical attempts",
    async () => {
      assert.equal(all.pages, 15);
      assertNativeContextLedgerObservations(manifest, all.items);
      for (const purpose of ["main", "maintenance", "decision"] as const) {
        const result = await page(purpose);
        assert.ok(result.items.every((item) => item.purpose === purpose));
        assert.deepEqual(
          result.items,
          all.items.filter((item) => item.purpose === purpose),
        );
        assert.equal(result.pages, purpose === "main" ? 15 : 1);
      }
    },
  );

  await t.test(
    "old maintenance events keep reported failure costs and exact observation associations",
    async () => {
      const records = await collectNativeContextLedgerPages(
        manifest,
        15,
        (cursor, limit) =>
          store.listNativeContextOperations(sessionId, { cursor, limit, expectedRevision: 0 }),
        (item) => item.operationId,
      );
      assert.deepEqual([...records.items].reverse(), manifest.operations);
      for (const record of records.items) {
        const associated = all.items.filter((item) =>
          item.operationIds.includes(record.operationId),
        );
        const result = await collectNativeContextLedgerPages(
          manifest,
          associated.length,
          (cursor, limit) =>
            store.listNativeContextObservations(sessionId, {
              cursor,
              limit,
              operationId: record.operationId,
              expectedRevision: 0,
            }),
          (item) => item.id,
        );
        assert.deepEqual(result.items, associated);
        assert.ok(record.observationIds.every((id) => result.items.some((item) => item.id === id)));
        assert.equal(
          result.items.find((item) => item.purpose === "maintenance")!.actualInputTokens,
          800,
        );
        const detail = await store.getNativeContextOperation(sessionId, record.operationId);
        assert.equal(detail!.sources.length, 4);
        assert.equal(detail!.summary.length > 0, record.status === "completed");
        assert.equal(detail!.blockIds.length > 0, record.status === "completed");
      }
      assert.ok(records.items.some((item) => item.status === "error"));
      assert.ok(records.items.some((item) => item.status === "cancelled"));
    },
  );

  await t.test(
    "real hydration resolves every source and request anchor with matching prefix history hashes",
    async () => {
      const messages = await store.messages({ sessionID: sessionId });
      assert.equal(messages.length, manifest.counts.messages);
      const history = new MessageHistoryImpl();
      await hydrateMessageHistoryFromSession({ history, messages });
      const entries = history.borrowReadOnlyRuntimeEntries();
      assert.equal(entries.length, manifest.counts.messages);
      assert.equal(historyVersionOf(entries), manifest.historyVersion);
      for (const sentinel of Object.values(manifest.sentinels)) {
        assert.equal(
          historyVersionOf(entries.slice(0, sentinel.requestSeq * 2 - 1)),
          sentinel.historyVersion,
        );
        assert.equal(messages[sentinel.requestSeq * 2 - 1]!.info.id, sentinel.anchorMessageId);
      }
      const state = await store.getNativeContextState(sessionId);
      assert.equal(state!.sources.length, manifest.counts.messages);
      for (const [index, source] of state!.sources.entries()) {
        assert.equal(source.rawId, `${entries[index]!.canonical!.messageId}#e0`);
        assert.equal(source.partId, messages[index]!.parts[0]!.id);
        assert.equal(kernelOf(state!).compression.messageRefs.byRaw[source.rawId], source.ref);
      }
      const runtime = {
        sessionId,
        branchGeneration: 0,
        sessionPersisted: true,
        sessionStore: store,
        messageHistory: history,
        config: {},
        workingDirectory: manifest.workspacePath,
        workspaceRoot: manifest.workspacePath,
        getSessionModelSelection: () => undefined,
        createEvent: (type: string, payload: unknown) => ({ type, payload }),
        appendEvent: async () => undefined,
      } as unknown as AgentRuntimeInternal;
      await recoverNativeContext(runtime);
      assert.deepEqual(await store.getNativeContextState(sessionId), state);
      assert.equal((await page()).items.length, 3000);
    },
  );

  await t.test(
    "actual chart aggregation retains extremes, unknown gaps, events and the unsampled selected original",
    () => {
      const main = all.items.filter((item) => item.purpose === "main").reverse();
      const points: NativeContextChartPoint[] = main.map((observation) => ({
        observation,
        values: {
          before: observation.beforeEstimate,
          after: observation.afterEstimate,
          actual: observation.actualInputTokens,
          budget: observation.inputBudget,
          start: observation.startTokens,
          target: observation.targetTokens,
        },
      }));
      assert.ok(
        !buildNativeContextChartRows(points, null).some(
          (row) => row.observation?.id === manifest.sentinels.selected.id,
        ),
      );
      const rows = buildNativeContextChartRows(points, manifest.sentinels.selected.id);
      const byId = new Map(
        rows.flatMap((row) => (row.observation ? [[row.observation.id, row] as const] : [])),
      );
      assert.ok(rows.length < main.length, "large range must actually reduce the drawing workload");
      for (const key of ["first", "last", "peak", "zero", "selected"] as const) {
        const original = manifest.sentinels[key];
        const sampled = byId.get(original.id)!;
        assert.deepEqual(sampled.observation, original);
        assert.equal(sampled.index, original.requestSeq - 1);
        assert.deepEqual(sampled.values, points[original.requestSeq - 1]!.values);
      }
      for (const id of manifest.eventPointIds) assert.ok(byId.has(id));
      const cache = buildNativeContextChartRows(
        main.map((observation) => ({
          observation,
          values: { hit: nativeContextCacheHitPercent(observation) },
        })),
        null,
      );
      for (const gap of manifest.unknownGaps) {
        for (const seq of [gap.first - 1, gap.first, gap.last, gap.last + 1])
          assert.ok(cache.some((row) => row.observation?.requestSeq === seq));
        assert.equal(
          cache.find((row) => row.observation?.requestSeq === gap.first)!.values.hit,
          null,
        );
      }
    },
  );

  await t.test(
    "replaying an identical atomic initialization never adds or mutates ledger rows",
    async () => {
      const bundle = await store.getNativeContextForkBundle(sessionId);
      assert.ok(bundle);
      await store.commitNativeContext(sessionId, {
        expectedRevision: null,
        expectedGeneration: 0,
        ...bundle,
      });
      assert.deepEqual(await store.getNativeContextForkBundle(sessionId), bundle);
      assert.deepEqual((await page()).items, all.items);
    },
  );
});
