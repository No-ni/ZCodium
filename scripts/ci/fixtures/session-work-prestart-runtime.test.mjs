import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";
import { resolveCliSourceAliases } from "./cli-source-aliases.mjs";
import { modelConfig, modelOptions } from "./local-model-config.mjs";

// 真实 Core/App 与公开 contracts 都从当前源码打包；ports 只用内存，不启动模型或持久化。
const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT ?? "");
const fixturePath = await assertProjectPath(join(sandbox, "prestart-runtime.cjs"));
const { build, stop } = await import("esbuild");
const aliases = await resolveCliSourceAliases();
for (const directory of await readdir(join(projectRoot, "packages"), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const packageRoot = join(projectRoot, "packages", directory.name);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const [subpath, exported] of Object.entries(manifest.exports ?? {})) {
    const target = typeof exported === "string" ? exported : (exported.import ?? exported.default);
    if (typeof target !== "string" || !target.startsWith("./") || subpath.includes("*")) continue;
    aliases[subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`] = join(
      packageRoot,
      target,
    );
  }
}
let bundle;
try {
  bundle = await build({
    stdin: {
      contents: [
        'export { executeTurn, executeTurnCommand } from "./apps/zcode-cli/packages/core/src/runtime/methods/turn.ts";',
        'export { admitPrompt } from "./apps/zcode-cli/packages/core/src/runtime/methods/prompt-admission.ts";',
        'export { createRuntimeCommandQueue } from "./apps/zcode-cli/packages/core/src/runtime/command-queue.ts";',
        'export { enqueueRuntimeCommand, drainRuntimeCommandQueue, hasActiveOrQueuedTurnWork } from "./apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts";',
        'export { executeManualCompact } from "./apps/zcode-cli/packages/core/src/runtime/methods/compact.ts";',
        'export { executeRewindCommand } from "./apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts";',
        'export { createInputFacade } from "./apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts";',
        'export { SessionEventType, createSessionEvent } from "@zcode/contracts";',
      ].join("\n"),
      resolveDir: projectRoot,
      loader: "ts",
    },
    outfile: fixturePath,
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    alias: aliases,
    logLevel: "silent",
  });
} finally {
  stop();
}
await writeFile(fixturePath, bundle.outputFiles[0].contents, { flag: "wx" });
const {
  executeTurn,
  executeTurnCommand,
  admitPrompt,
  createRuntimeCommandQueue,
  enqueueRuntimeCommand,
  drainRuntimeCommandQueue,
  hasActiveOrQueuedTurnWork,
  executeManualCompact,
  executeRewindCommand,
  createInputFacade,
  SessionEventType,
  createSessionEvent,
} = (await import(pathToFileURL(fixturePath).href)).default;

const SESSION = "session-prestart-fixture";
const SOURCE = "source-promoted-fixture";
const QUEUE_ITEM = "queue-promoted-fixture";
const TURN = "turn-reserved-fixture";
const traceContext = { traceId: "trace-prestart-fixture", spanId: "span-prestart-fixture" };
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const modes = [
  { name: "普通", input: "Synthetic accepted input", compact: false },
  { name: "compact", input: "/compact synthetic", compact: true },
];

function acceptedOptions(controller, compact) {
  return {
    abortSignal: controller.signal,
    inputId: SOURCE,
    queryId: "different-query-fixture",
    traceContext,
    intent: {
      sourceCommandId: SOURCE,
      queueItemId: QUEUE_ITEM,
      clientId: "client-fixture",
      kind: compact ? "compact" : "prompt",
      requestedDelivery: "queue",
      admittedDelivery: "queue",
      admissionSeq: 2,
      admittedAt: 1_700_000_000_000,
    },
  };
}

function abortError() {
  return Object.assign(new Error("Synthetic preparation cancelled"), { name: "AbortError" });
}

function coreFixture(mode, stage, cancelled = false) {
  const controller = new AbortController();
  const events = [];
  const calls = [];
  const subscribers = new Set();
  let unsubscribed = 0;
  const failAt = (current) => {
    calls.push(current);
    if (stage !== current) return;
    if (cancelled) {
      controller.abort();
      throw abortError();
    }
    throw new Error(`Synthetic ${current} failure`);
  };
  const model = {
    providerId: "synthetic-provider",
    modelId: "synthetic-model",
    ...modelConfig,
    options: modelOptions,
    bind() {
      return this;
    },
    generateText() {
      assert.fail("preparation fixtures must not request a model");
    },
    streamText() {
      assert.fail("preparation fixtures must not request a model");
    },
  };
  const runtime = {
    config: { outputStyle: "default", taskType: "interactive" },
    logger,
    rootTraceContext: traceContext,
    sessionId: SESSION,
    turnNumber: 1,
    contextInitialized: false,
    queueAutoDrain: true,
    queueExternalDrainActive: true,
    getSessionModelSelection: () => ({ providerId: model.providerId, modelId: model.modelId }),
    modelFactory: () => model,
    reserveTurnStart: (turnId) => calls.push(`reserve:${turnId}`),
    releaseTurnStart: (turnId) => calls.push(`release:${turnId}`),
    beginActiveTurn: () => ({ pendingInputs: [], steerable: true }),
    finishActiveTurn: () => calls.push("finish"),
    ensureContextInitialized: async () => failAt("context"),
    runSessionStartHooks: async () => {
      failAt("session-hooks");
      return { additionalContexts: [] };
    },
    injectHookAdditionalContextIntoMessageHistory() {},
    ensureSessionPersisted: async () => failAt("persistence"),
    readSessionTargetForContext: async () => null,
    startTargetTurnAccounting: async () => null,
    finishTargetTurnAccounting: async () => null,
    pauseActiveTargetForCancellation: async () => {},
    fallbackPendingGuidesToQueue: async () => {},
    rebuildProjection: async () => ({ pendingSteerInputs: [] }),
    runUserPromptSubmitHooks: async () => {
      failAt("after-start");
      assert.fail("ordinary fixtures must stop at the user prompt hook");
    },
    compactActiveConversation: async () => {
      failAt("after-start");
      assert.fail("compact fixtures must stop at the compact port");
    },
    executeManualCompact,
    createEvent(type, payload, context) {
      return createSessionEvent(type, SESSION, payload, {
        turnId: context.turnId,
        traceId: context.traceId,
        sequenceNumber: events.length + 1,
      });
    },
    async appendEvent(event) {
      events.push(event);
      for (const subscriber of subscribers) await subscriber(event);
    },
    subscribeEvents({ onSessionEvent }) {
      subscribers.add(onSessionEvent);
      return () => {
        subscribers.delete(onSessionEvent);
        unsubscribed++;
      };
    },
  };
  if (stage === "initial-abort") controller.abort();
  const options = acceptedOptions(controller, mode.compact);
  const reservation = { turnId: TURN, traceContext: { ...traceContext, turnId: TURN } };
  runtime.executeTurn = (input, attachments, submittedOptions) =>
    executeTurnCommand.call(runtime, input, attachments, submittedOptions, reservation);
  return {
    runtime,
    controller,
    options,
    reservation,
    events,
    calls,
    getUnsubscribed: () => unsubscribed,
  };
}

function assertTerminal(events, cancelled, { started, core = true } = {}) {
  const terminal = events.filter((event) =>
    [SessionEventType.TurnComplete, SessionEventType.TurnError].includes(event.type),
  );
  assert.equal(terminal.length, 1, "the lifecycle owner must publish exactly one terminal fact");
  const [event] = terminal;
  assert.equal(event.sessionId, SESSION);
  assert.equal(event.payload.inputId, SOURCE, "keep the admitted source id, never queue/query id");
  if (core) assert.equal(event.turnId, TURN, "keep the admitted turn reservation");
  if (cancelled) {
    assert.equal(event.type, SessionEventType.TurnComplete);
    assert.equal(event.payload.resultType, "cancelled");
    assert.ok(event.payload.duration >= 0);
  } else {
    assert.equal(event.type, SessionEventType.TurnError);
    assert.ok(event.payload.error);
  }
  if (started !== undefined) {
    const starts = events.filter((item) => item.type === SessionEventType.TurnStarted);
    assert.equal(starts.length, started ? 1 : 0);
    if (started) {
      assert.equal(starts[0].payload.inputId, SOURCE);
      assert.ok(events.indexOf(starts[0]) < events.indexOf(event));
    }
  }
  return event;
}

for (const mode of modes) {
  for (const [stage, cancelled] of [
    ["initial-abort", true],
    ["context", false],
    ["context", true],
    ["session-hooks", false],
    ["session-hooks", true],
    ["persistence", false],
    ["persistence", true],
  ]) {
    test(`${mode.name}：真实 Core ${stage} ${cancelled ? "取消" : "失败"}结算且释放 reservation`, async () => {
      const fixture = coreFixture(mode, stage, cancelled);
      await assert.rejects(
        executeTurnCommand.call(
          fixture.runtime,
          mode.input,
          undefined,
          fixture.options,
          fixture.reservation,
        ),
      );
      if (stage === "initial-abort") assert.equal(fixture.calls.includes("context"), false);
      else
        assert.ok(
          fixture.calls.includes(stage),
          "failure must reach the requested real preparation port",
        );
      assertTerminal(fixture.events, cancelled, { started: false });
      assert.ok(fixture.calls.includes(`release:${TURN}`));
      assert.ok(fixture.calls.includes("finish"));
      assert.equal(fixture.runtime.queueAutoDrain, false);
      assert.equal(fixture.runtime.queueExternalDrainActive, false);
    });
  }
  for (const cancelled of [false, true]) {
    test(`${mode.name}：真实 Core 已开始后${cancelled ? "取消" : "失败"}不重复终态`, async () => {
      const fixture = coreFixture(mode, "after-start", cancelled);
      await assert.rejects(
        executeTurnCommand.call(
          fixture.runtime,
          mode.input,
          undefined,
          fixture.options,
          fixture.reservation,
        ),
      );
      assert.ok(
        fixture.calls.includes("after-start"),
        "failure must occur after the real TurnStarted",
      );
      assertTerminal(fixture.events, cancelled, { started: true });
      if (mode.compact) {
        assert.equal(fixture.events[0].payload.inputVisibility, "model-only");
      }
    });
  }
  for (const cancelled of [false, true]) {
    test(`${mode.name}：真实 App prepare boundary ${cancelled ? "取消" : "失败"}未交 Core 时同源结算`, async () => {
      const fixture = coreFixture(mode, "after-start");
      const observed = [];
      fixture.runtime.executeTurn = () => assert.fail("prepare failure must not enter Core");
      const app = createInputFacade({
        runtime: fixture.runtime,
        logger,
        sessionId: SESSION,
        traceContext,
        prepareUserExecutionBoundary: async () => {
          if (cancelled) {
            fixture.controller.abort();
            throw abortError();
          }
          throw new Error("Synthetic boundary failure");
        },
      });
      await assert.rejects(
        app.submitPrompt(mode.input, {
          ...fixture.options,
          onEvent: (event) => observed.push(event),
        }),
      );
      const event = assertTerminal(fixture.events, cancelled, { started: false, core: false });
      assert.deepEqual(
        observed,
        fixture.events,
        "subscription spans preparation and terminal append",
      );
      assert.equal(fixture.getUnsubscribed(), 1);
      if (!cancelled) {
        assert.equal(event.payload.error.code, "fault.runtime.unknown");
        assert.equal(event.payload.error.message, "Input preparation failed");
      }
    });
  }
  for (const cancelled of [false, true]) {
    test(`${mode.name}：真实 App→Core 已交接后${cancelled ? "取消" : "失败"}仅 Core 发布终态`, async () => {
      const fixture = coreFixture(mode, "after-start", cancelled);
      const app = createInputFacade({
        runtime: fixture.runtime,
        logger,
        sessionId: SESSION,
        traceContext,
        prepareUserExecutionBoundary: async () => {},
      });
      await assert.rejects(app.submitPrompt(mode.input, fixture.options));
      assertTerminal(fixture.events, cancelled, { started: true });
    });
  }
  test(`${mode.name}：真实 App 命令展开失败也在 Core 前结算`, async () => {
    const fixture = coreFixture(mode, "after-start");
    fixture.runtime.executeTurn = () => assert.fail("command resolver failure must not enter Core");
    const app = createInputFacade({
      runtime: fixture.runtime,
      logger,
      sessionId: SESSION,
      traceContext,
      prepareUserExecutionBoundary: async () => {},
      customCommandPromptResolver: async () => {
        throw new Error("Synthetic command resolution failure");
      },
    });
    await assert.rejects(app.submitPrompt(mode.input, fixture.options));
    assertTerminal(fixture.events, false, { started: false, core: false });
  });
}

test("真实 App 未接受的直接输入准备拒绝沿用调用拒绝，不生成执行终态", async () => {
  const fixture = coreFixture(modes[0], "after-start");
  const app = createInputFacade({
    runtime: fixture.runtime,
    logger,
    sessionId: SESSION,
    traceContext,
    prepareUserExecutionBoundary: async () => {
      throw new Error("Synthetic direct rejection");
    },
  });
  await assert.rejects(
    app.submitPrompt(modes[0].input, {
      inputId: "direct-fixture",
      traceContext,
    }),
  );
  assert.deepEqual(fixture.events, []);
});

function publicSchedulingFixture(mode) {
  const fixture = coreFixture(mode, "after-start");
  const { runtime } = fixture;
  runtime.runtimeCommandQueue = createRuntimeCommandQueue();
  runtime.runtimeCommandDrainActive = false;
  runtime.branchGeneration = 0;
  runtime.executeTurn = executeTurn;
  runtime.admitPrompt = admitPrompt;
  runtime.enqueueRuntimeCommand = enqueueRuntimeCommand;
  runtime.hasActiveOrQueuedTurnWork = hasActiveOrQueuedTurnWork;
  // 仅暂停自动 flush 作为可控调度屏障；命令创建、队列操作和手动 flush 都执行真实源码。
  runtime.drainRuntimeCommandQueue = async () => {};
  runtime.executeTurnCommand = (...args) => {
    fixture.calls.push("command-body");
    return executeTurnCommand.call(runtime, ...args);
  };
  runtime.reserveTurnStart = (turnId, context, kind) => {
    fixture.calls.push(`reserve:${turnId}`);
    runtime.activeTurnStartReservation = { turnId, traceContext: context, kind };
  };
  runtime.releaseTurnStart = (turnId) => {
    fixture.calls.push(`release:${turnId}`);
    if (runtime.activeTurnStartReservation?.turnId === turnId) {
      runtime.activeTurnStartReservation = undefined;
    }
  };
  return fixture;
}

function consumeCancellationBarrier(fixture) {
  const queue = fixture.runtime.runtimeCommandQueue;
  const dequeue = queue.dequeueNextBatch;
  const consume = queue.consumeCancelPending;
  let consumed = 0;
  queue.dequeueNextBatch = () => {
    const batch = dequeue();
    if (batch.length > 0) {
      fixture.calls.push("dequeued-before-abort");
      fixture.controller.abort();
    }
    return batch;
  };
  queue.consumeCancelPending = (id) => {
    const result = consume(id);
    if (result) consumed++;
    return result;
  };
  return () => consumed;
}

async function schedulePublic(fixture, mode, entry, options = fixture.options) {
  if (entry === "admitPrompt") {
    const receipt = await fixture.runtime.admitPrompt(mode.input, undefined, options);
    assert.equal(receipt.kind, "started");
    return { completion: receipt.completion, turnId: receipt.turnId };
  }
  // 不 await completion：保留命令仍在队列内的真实取消窗口。
  return { completion: fixture.runtime.executeTurn(mode.input, undefined, options) };
}

for (const mode of modes) {
  for (const entry of ["executeTurn", "admitPrompt"]) {
    for (const cancelAt of ["already-aborted", "queued", "consumeCancelPending"]) {
      test(`${mode.name}：真实公开 ${entry} 在 ${cancelAt} 取消时由调度 owner 结算一次`, async () => {
        const fixture = publicSchedulingFixture(mode);
        if (cancelAt === "already-aborted") fixture.controller.abort();
        const submitted = await schedulePublic(fixture, mode, entry);
        const rejected = assert.rejects(submitted.completion);
        let command;
        if (cancelAt !== "already-aborted") {
          [command] = fixture.runtime.runtimeCommandQueue.snapshot();
          assert.ok(command, "the public method must create the actual queued command");
          assert.equal(command.options.inputId, SOURCE);
          if (cancelAt === "consumeCancelPending") {
            const consumedCount = consumeCancellationBarrier(fixture);
            await drainRuntimeCommandQueue.call(fixture.runtime);
            assert.equal(consumedCount(), 1, "the real drain must consume the cancellation marker");
            assert.ok(fixture.calls.includes("dequeued-before-abort"));
            assert.equal(
              fixture.runtime.runtimeCommandQueue.consumeCancelPending(command.id),
              false,
            );
          } else {
            fixture.controller.abort();
          }
        }
        await rejected;
        const event = assertTerminal(fixture.events, true, { started: false, core: false });
        if (submitted.turnId) {
          assert.equal(
            event.turnId,
            submitted.turnId,
            "admission cancellation keeps its reserved turn id",
          );
          assert.ok(fixture.calls.includes(`release:${submitted.turnId}`));
        }
        assert.equal(fixture.calls.includes("command-body"), false);
        assert.equal(fixture.runtime.runtimeCommandQueue.size(), 0);
        assert.equal(fixture.runtime.activeTurnStartReservation, undefined);
        assert.equal(fixture.runtime.activeForegroundExecution, undefined);
        assert.equal(fixture.runtime.queueAutoDrain, false);
        assert.equal(fixture.runtime.queueExternalDrainActive, false);
      });
    }
  }
}

for (const entry of ["executeTurn", "admitPrompt"]) {
  test(`真实公开 ${entry} 未接受直接输入在 admission 前已取消时只拒绝`, async () => {
    const fixture = publicSchedulingFixture(modes[0]);
    fixture.controller.abort();
    const submitted = await schedulePublic(fixture, modes[0], entry, {
      abortSignal: fixture.controller.signal,
      inputId: "unaccepted-direct-fixture",
      traceContext,
    });
    await assert.rejects(submitted.completion);
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.runtime.runtimeCommandQueue.size(), 0);
    assert.equal(fixture.runtime.activeTurnStartReservation, undefined);
    assert.equal(fixture.calls.includes("command-body"), false);
  });
}

for (const cancelAt of ["already-aborted", "queued", "consumeCancelPending"]) {
  test(`真实 App→公开 executeTurn 在 ${cancelAt} 取消时交接给调度 owner`, async () => {
    const mode = modes[1];
    const fixture = publicSchedulingFixture(mode);
    const observed = [];
    const app = createInputFacade({
      runtime: fixture.runtime,
      logger,
      sessionId: SESSION,
      traceContext,
      prepareUserExecutionBoundary: async () => {},
    });
    if (cancelAt === "already-aborted") fixture.controller.abort();
    const completion = app.submitPrompt(mode.input, {
      ...fixture.options,
      onEvent: (event) => observed.push(event),
    });
    const rejected = assert.rejects(completion);
    if (cancelAt !== "already-aborted") {
      // prepare/command expansion 的真实 await 已跨过；条件屏障只观察 public 方法创建的 command。
      for (
        let attempts = 0;
        fixture.runtime.runtimeCommandQueue.size() === 0 && attempts < 20;
        attempts++
      ) {
        await Promise.resolve();
      }
      assert.equal(fixture.runtime.runtimeCommandQueue.size(), 1);
      if (cancelAt === "consumeCancelPending") {
        const consumedCount = consumeCancellationBarrier(fixture);
        await drainRuntimeCommandQueue.call(fixture.runtime);
        assert.equal(consumedCount(), 1);
      } else {
        fixture.controller.abort();
      }
    }
    await rejected;
    assertTerminal(fixture.events, true, { started: false, core: false });
    assert.deepEqual(observed, fixture.events);
    assert.equal(fixture.getUnsubscribed(), 1);
    assert.equal(fixture.calls.includes("command-body"), false);
  });
}

for (const cancelled of [false, true]) {
  test(`真实 rewind 在启动持久化${cancelled ? "取消" : "失败"}时由已交接 owner 结算一次`, async () => {
    const fixture = coreFixture(modes[0], "persistence", cancelled);
    await assert.rejects(
      executeRewindCommand.call(
        fixture.runtime,
        "/rewind status",
        { action: "status" },
        TURN,
        fixture.reservation.traceContext,
        fixture.controller.signal,
        SOURCE,
      ),
    );
    assert.ok(fixture.calls.includes("persistence"));
    assertTerminal(fixture.events, cancelled, { started: false });
    assert.ok(fixture.calls.includes("finish"));
  });
}

for (const mode of modes) {
  for (const entry of ["executeTurn", "admitPrompt"]) {
    for (const cancelled of [false, true]) {
      test(`${mode.name}：真实公开 ${entry} 进入主体后${cancelled ? "取消" : "失败"}不由调度重复结算`, async () => {
        const fixture = publicSchedulingFixture(mode);
        // 故障发生在真实 TurnStarted 后的 hook/compact port；取消从调用方 signal 传至前台 scope。
        if (cancelled) {
          const port = mode.compact ? "compactActiveConversation" : "runUserPromptSubmitHooks";
          fixture.runtime[port] = async () => {
            fixture.controller.abort();
            throw abortError();
          };
        }
        const submitted = await schedulePublic(fixture, mode, entry);
        const rejected = assert.rejects(submitted.completion);
        const [command] = fixture.runtime.runtimeCommandQueue.snapshot();
        assert.ok(command);
        await drainRuntimeCommandQueue.call(fixture.runtime);
        await rejected;
        const event = assertTerminal(fixture.events, cancelled, { started: true, core: false });
        if (submitted.turnId) assert.equal(event.turnId, submitted.turnId);
        assert.equal(fixture.calls.filter((call) => call === "command-body").length, 1);
        assert.equal(fixture.runtime.runtimeCommandQueue.consumeCancelPending(command.id), false);
        assert.equal(fixture.runtime.activeForegroundExecution, undefined);
        assert.equal(fixture.runtime.activeTurnStartReservation, undefined);
      });
    }
  }
}

test("真实公开 executeTurn 的调度取消等待唯一 terminal append 后才拒绝 completion", async () => {
  const fixture = publicSchedulingFixture(modes[0]);
  const append = fixture.runtime.appendEvent;
  const durable = Promise.withResolvers();
  let appendEntered = false;
  fixture.runtime.appendEvent = async (event) => {
    appendEntered = true;
    await durable.promise;
    await append(event);
  };
  const submitted = await schedulePublic(fixture, modes[0], "executeTurn");
  let completionSettled = false;
  void submitted.completion.then(
    () => {
      completionSettled = true;
    },
    () => {
      completionSettled = true;
    },
  );
  const rejected = assert.rejects(submitted.completion);
  try {
    fixture.controller.abort();
    for (let attempt = 0; !appendEntered && attempt < 20; attempt++) await Promise.resolve();
    assert.equal(appendEntered, true, "the actual scheduling owner must begin terminal append");
    assert.equal(
      completionSettled,
      false,
      "a pending append must keep command completion unsettled",
    );
    assert.deepEqual(fixture.events, []);
  } finally {
    durable.resolve();
  }
  await rejected;
  assertTerminal(fixture.events, true, { started: false, core: false });
});
