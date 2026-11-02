// Project-internal regression for the fork privacy boundary of the local TTFT renderer observer.
// The real LocalTtftObserver class is extracted from product source and executed with injected
// boundary dependencies, so these assertions cover the actual diagnostics exit instead of a copy.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const OBSERVER_SOURCE = "packages/ui/src/v4/diagnostics/local-ttft/localTtftObserverCore.ts";
const RECORD_SOURCE = "packages/ui/src/v4/diagnostics/local-ttft/localTtftRecord.ts";
const FACTS_SOURCE = "packages/ui/src/v4/diagnostics/local-ttft/localTtftFacts.ts";
const CONTRACT_SOURCE = "packages/shared/src/local-ttft/contract.ts";

const WORKSPACE = "workspace-a";
const SESSION = "session-a";
const TURN = "turn-a";
const COMMAND = "command-a";
const INSTANCE = "cli-instance-a";

function sourceUrl(path) {
  return new URL(`../../${path}`, import.meta.url);
}

function sourcePath(path) {
  return fileURLToPath(sourceUrl(path));
}

async function loadObserver(sink) {
  const [contract, record, facts] = await Promise.all([
    import(sourceUrl(CONTRACT_SOURCE)),
    import(sourceUrl(RECORD_SOURCE)),
    import(sourceUrl(FACTS_SOURCE)),
  ]);
  const text = await readFile(sourcePath(OBSERVER_SOURCE), "utf8");
  const parsed = ts.createSourceFile(
    OBSERVER_SOURCE,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let declaration;
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === "LocalTtftObserver") {
      assert.equal(declaration, undefined, "Expected one production observer class");
      declaration = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(declaration, OBSERVER_SOURCE);
  const helperSources = await Promise.all(
    [
      "packages/ui/src/v4/diagnostics/local-ttft/localTtftLogRecord.ts",
      "packages/ui/src/v4/diagnostics/local-ttft/localTtftTextProjection.ts",
      "packages/ui/src/v4/diagnostics/local-ttft/localTtftPendingStart.ts",
    ].map(async (path) => {
      const text = await readFile(sourcePath(path), "utf8");
      const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      assert.equal(file.parseDiagnostics.length, 0, path);
      // 拆分后仍执行生产帮助函数，logger 只在本地 sink 边界注入。
      return file.statements
        .filter((node) => !ts.isImportDeclaration(node))
        .map((node) => node.getText(file).replace(/^export\s+/, ""))
        .join("\n");
    }),
  );
  const { outputText } = ts.transpileModule(
    `${helperSources.join("\n")}\n${declaration.getText(parsed).replace(/^export\s+/, "")}\nreturn LocalTtftObserver;`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } },
  );
  const factory = new Function(
    "mergeLocalTtftFacts",
    "buildLocalTtftRecord",
    "logger",
    "LOCAL_TTFT_MAX_PENDING",
    "LOCAL_TTFT_TTL_MS",
    "LOCAL_TTFT_CLOCK_TTL_MS",
    "localTtftNow",
    outputText,
  );
  return factory(
    facts.mergeLocalTtftFacts,
    record.buildLocalTtftRecord,
    { debug: () => {}, lifecycle: { info: (_message, fields) => sink.push(fields) } },
    contract.LOCAL_TTFT_MAX_PENDING,
    contract.LOCAL_TTFT_TTL_MS,
    contract.LOCAL_TTFT_CLOCK_TTL_MS,
    contract.localTtftNow,
  );
}

async function drive(clock, steps) {
  const sink = [];
  const Observer = await loadObserver(sink);
  const records = [];
  const observer = new Observer(
    (record) => records.push(record),
    () => clock.value,
    () => clock.value,
  );
  observer.enabled = true;
  observer.logLocally = true;
  steps(observer, clock);
  return { sink, records, observer };
}

const sensitiveKeys = ["provider", "model"];

function assertNoSensitiveIdentity(sink) {
  for (const fields of sink) {
    for (const key of sensitiveKeys)
      assert.equal(
        Object.hasOwn(fields, key),
        false,
        `${fields.event} leaked ${key} into the local diagnostics exit`,
      );
    // The removed per-attempt identifier must not come back through a preparation phase.
    if (fields.event === "ttft.phase") assert.equal(fields.requestId, undefined, fields.event);
  }
}

function phases(sink, phaseId) {
  return sink.filter((fields) => fields.event === "ttft.phase" && fields.phaseId === phaseId);
}

test("renderer-only observation keeps provider and model out of the diagnostics exit", async () => {
  const clock = { value: 1000 };
  const { sink } = await drive(clock, (observer) => {
    const context = observer.start(WORKSPACE, false, false, 1000);
    observer.confirmation(context, true);
    clock.value += 120;
    observer.confirmation(context, false);
    observer.dispatch(context, WORKSPACE, COMMAND, SESSION);
    observer.exclude(context, "interrupted");
  });

  assertNoSensitiveIdentity(sink);
  assert.equal(sink.length > 0, true);
  assert.equal(new Set(sink.map((fields) => fields.observationId)).size, 1);
  assert.equal(sink.filter((fields) => fields.event === "ttft.start").length, 1);
  assert.equal(sink.filter((fields) => fields.event === "ttft.dispatch").length, 1);

  // 用户二次确认等待仍按阶段保留，不因字段删除丢失计时。
  const confirmation = phases(sink, "confirmation:0");
  assert.equal(confirmation.length, 2);
  assert.deepEqual(
    confirmation.map((fields) => fields.status),
    ["started", "completed"],
  );
  assert.equal(confirmation[1].durationMs, 120);
  const terminal = sink.find((fields) => fields.event === "ttft.excluded");
  assert.equal(terminal.userWaitMs, 120);
  assert.equal(terminal.stages.renderer_prepare, 120);
  assert.equal(terminal.timingReliable, true);
});

test("cli preparation facts keep phase timing without a per-attempt request id", async () => {
  const clock = { value: 1000 };
  const { sink } = await drive(clock, (observer) => {
    const context = observer.start(WORKSPACE, false, false, 1000);
    clock.value = 1020;
    observer.dispatch(context, WORKSPACE, COMMAND, SESSION);
    observer.calibrate(WORKSPACE, {
      instanceId: INSTANCE,
      offsetMs: 0,
      errorMs: 1,
      measuredAt: 1000,
    });
    // Renderer 单调时钟必须晚于 CLI 首内容事实，否则跨进程 output_return 会成为负区间。
    clock.value = 1250;
    const facts = {
      version: 1,
      observationId: context.observationId,
      instanceId: INSTANCE,
      commandId: COMMAND,
      sessionId: SESSION,
      turnId: TURN,
      productTurnId: TURN,
      receivedAt: 1050,
      admittedAt: 1060,
      executionAt: 1080,
      requestAt: 1100,
      outputAt: 1150,
      details: [
        {
          id: "stage:0",
          stage: "request_assembly",
          start: 1085,
          end: 1095,
          source: "cli",
          role: "preparation",
          requestId: "request-id-must-not-be-logged",
        },
      ],
    };
    observer.receive(
      WORKSPACE,
      {
        topic: `conversation/${SESSION}`,
        toSeq: 1,
        ttft: facts,
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "row.appended",
              row: {
                rowId: 7,
                turnId: TURN,
                kind: "assistantText",
                text: "content",
                toolName: "",
                status: "complete",
                inputText: "",
              },
            },
          ],
        },
      },
      "online",
    );
  });

  assertNoSensitiveIdentity(sink);
  // 同一 observation 内同一阶段只保留开始/结束各一次，删除字段不改变去重口径。
  const preparation = phases(sink, "stage:0");
  assert.equal(preparation.length, 2);
  assert.equal(preparation[0].source, "cli");
  assert.equal(preparation[0].role, "preparation");
  assert.equal(preparation[1].status, "completed");
  assert.equal(preparation[1].durationMs, 10);

  const firstOutput = sink.find((fields) => fields.event === "ttft.first_output");
  assert.ok(firstOutput, "first output must still close the main record");
  assert.equal(firstOutput.firstOutputKind, "text");
  assert.equal(firstOutput.quality, "complete");
  assert.equal(firstOutput.stages.renderer_prepare, 20);
  assert.equal(firstOutput.stages.command_admission, 40);
  assert.equal(firstOutput.stages.execution_wait, 20);
  assert.equal(firstOutput.stages.request_prepare, 20);
  assert.equal(firstOutput.stages.model_request, 50);
  assert.equal(firstOutput.stages.output_return, 100);
  assert.equal(Object.keys(firstOutput.stages).length, 6);
  for (const value of Object.values(firstOutput.stages)) assert.equal(typeof value, "number");
});

test("no-text outcomes keep the calibrated stage timing", async () => {
  const clock = { value: 1000 };
  const { sink } = await drive(clock, (observer) => {
    const context = observer.start(WORKSPACE, false, false, 1000);
    clock.value = 1020;
    observer.dispatch(context, WORKSPACE, COMMAND, SESSION);
    observer.calibrate(WORKSPACE, {
      instanceId: INSTANCE,
      offsetMs: 0,
      errorMs: 1,
      measuredAt: 1000,
    });
    clock.value = 1250;
    const facts = {
      version: 1,
      observationId: context.observationId,
      instanceId: INSTANCE,
      commandId: COMMAND,
      sessionId: SESSION,
      turnId: TURN,
      productTurnId: TURN,
      receivedAt: 1050,
      admittedAt: 1060,
      executionAt: 1080,
      requestAt: 1100,
      outputAt: 1150,
    };
    observer.receive(
      WORKSPACE,
      {
        topic: `conversation/${SESSION}`,
        toSeq: 1,
        ttft: { ...facts, terminal: "completed" },
        payload: { kind: "deltas", deltas: [] },
      },
      "online",
    );
  });

  assertNoSensitiveIdentity(sink);
  const excluded = sink.find((fields) => fields.event === "ttft.excluded");
  assert.ok(excluded, "terminal without text keeps an explicit result");
  assert.equal(excluded.outcome, "unsupported");
  assert.equal(excluded.stages.renderer_prepare, 20);
  assert.equal(excluded.stages.command_admission, 40);
  assert.equal(excluded.stages.execution_wait, 20);
  assert.equal(excluded.stages.request_prepare, 20);
  assert.equal(excluded.stages.model_request, 50);
  // 未收到首内容时 output_return 不成立，六段缺一段按 missing 记录，不补零。
  assert.equal(excluded.quality, "missing");
  assert.equal(Object.keys(excluded.stages).length, 5);
  assert.equal(excluded.clockErrorMs, 1);
  assert.equal(excluded.timingReliable, true);
});
