import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { assertProjectPath } from "./project-test-sandbox.mjs";
import { createNativeTrendPointerFixture } from "./fixtures/native-context-trend-pointer.mjs";

const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT);
const results = [];
let evidence;

function points(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    observation: {
      id: `source-observation-${index}`,
      requestSeq: index + 1,
      origin: "own",
      operationIds: [],
      generation: 1,
      segmentId: "source-segment",
      policyVersion: 1,
      historyVersion: `source-history-${index}`,
      model: { providerId: "source-provider", modelId: "source-model" },
      contextWindow: 64000,
      inputBudget: 62000,
      estimatorVersion: "source-estimator",
    },
    values: { before: 100 + (index % 13), after: 80 + (index % 7), actual: 70 + (index % 11) },
  }));
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function expectSelection(snapshot, id) {
  assert.deepEqual(
    snapshot,
    { detail: id, charts: [id, id, id] },
    "The real action must update the same detail and all three charts",
  );
}

async function run(t, data, action, options = {}) {
  const fixture = await createNativeTrendPointerFixture({ points: freeze(data), ...options });
  evidence = fixture.source.evidence;
  const result = { name: t.name, passed: false, events: [], selection: null, trace: [] };
  results.push(result);
  t.after(async () => {
    result.events = fixture.eventTrace;
    result.selection = fixture.snapshot();
    result.trace = fixture.trace;
    await fixture.close();
  });
  await action(fixture, result);
  fixture.assertUnchanged();
  result.passed = true;
}

after(async () => {
  await writeFile(
    await assertProjectPath(join(sandbox, "trend-pointer-results.json")),
    JSON.stringify(
      {
        ...evidence,
        passed: results.every(({ passed }) => passed),
        passCount: results.filter(({ passed }) => passed).length,
        failCount: results.filter(({ passed }) => !passed).length,
        cases: results,
      },
      null,
      2,
    ) + "\n",
  );
});

test("no preceding hover: actual DOM touchend and compatible click keep the touched request", async (t) => {
  await run(t, points(), async (f) => {
    assert.equal(f.tooltip(), null);
    const id = f.points[0].observation.id;
    await f.dispatch("touchstart", 0, { useDot: true });
    const end = await f.dispatch("touchend", 0, { useDot: true });
    const click = await f.dispatch("click", 0, { useDot: true });
    assert.deepEqual(
      [end, click],
      [
        { detail: id, charts: [id, id, id] },
        { detail: id, charts: [id, id, id] },
      ],
    );
    assert.ok(f.trace.length > 0 && f.trace.every((selected) => selected === id));
    assert.equal(f.eventTrace[1].touches, 0);
    assert.equal(f.eventTrace[1].changedTouches, 1);
  });
});

test("an older hover tooltip cannot choose another request or undo touchend on compatible click", async (t) => {
  await run(t, points(), async (f) => {
    await f.dispatch("mousemove", 1, { useDot: true });
    assert.equal(
      f.tooltip(),
      "Request 2",
      "The actual Recharts hover path must be active before touch",
    );
    const id = f.points[0].observation.id;
    await f.dispatch("touchstart", 0, { useDot: true });
    const end = await f.dispatch("touchend", 0, { useDot: true });
    const click = await f.dispatch("click", 0, { useDot: true });
    assert.deepEqual(
      [end, click],
      [
        { detail: id, charts: [id, id, id] },
        { detail: id, charts: [id, id, id] },
      ],
    );
    assert.equal(
      f.tooltip(),
      "Request 2",
      "Request selection preserves the existing hover Tooltip",
    );
    assert.ok(f.trace.length > 0 && f.trace.every((selected) => selected === id));
  });
});

test("3000-point scaled DOM click preserves subpixel original X across sampling and segment rows", async (t) => {
  const data = points(3000);
  const target = 2333;
  data[target].values.actual = 9000;
  for (let index = target; index < data.length; index++)
    data[index].observation.segmentId = "source-next-segment";
  await run(
    t,
    data,
    async (f, result) => {
      const rows = f.source.buildNativeContextChartRows(f.points, f.points.at(-1).observation.id);
      const ordinal = rows.findIndex(
        ({ observation }) => observation?.id === f.points[target].observation.id,
      );
      assert.ok(rows.length < 3000 && ordinal >= 0 && ordinal !== target);
      assert.ok(rows.some((row) => row.observation === null && row.index === target - 0.5));
      const dot = f.dot(target);
      const numericX = Number(dot.getAttribute("cx"));
      assert.ok(
        Math.abs(numericX - Math.round(numericX)) > 0.1,
        "The real Recharts dot has a subpixel X",
      );
      result.sample = {
        total: 3000,
        rendered: rows.length,
        originalIndex: target,
        rowOrdinal: ordinal,
        dotX: numericX,
      };
      const selected = await f.dispatch("click", target, { useDot: true });
      expectSelection(selected, f.points[target].observation.id);
      assert.deepEqual(f.trace, [f.points[target].observation.id]);
      assert.ok(!Number.isInteger(f.eventTrace[0].clientX));
    },
    { scale: 1.25 },
  );
});

test("a sampled-out unknown request remains selectable without inventing a measurement or selecting a separator", async (t) => {
  const data = points(3000);
  for (const point of data) point.values.actual = null;
  const target = 1501;
  await run(t, data, async (f, result) => {
    const before = f.source.buildNativeContextChartRows(f.points, f.points.at(-1).observation.id);
    assert.ok(
      !before.some(({ observation }) => observation?.id === f.points[target].observation.id),
      "Target is an original request omitted from drawing",
    );
    result.sample = {
      total: 3000,
      renderedBefore: before.length,
      originalIndex: target,
      actualValue: null,
    };
    await f.dispatch("touchstart", target);
    const end = await f.dispatch("touchend", target);
    const click = await f.dispatch("click", target);
    const id = f.points[target].observation.id;
    assert.deepEqual(
      [end, click],
      [
        { detail: id, charts: [id, id, id] },
        { detail: id, charts: [id, id, id] },
      ],
    );
    const after = f.source.buildNativeContextChartRows(f.points, id);
    assert.equal(after.find(({ observation }) => observation?.id === id)?.values.actual, null);
    assert.ok(f.trace.length > 0 && f.trace.every((selected) => selected === id));
    assert.equal(
      f.section().querySelectorAll('circle.recharts-line-dot[stroke="#663399"]').length,
      0,
    );
  });
});

test("actual native keyboard selection remains shared and plot-external clicks cannot select stale hover", async (t) => {
  await run(t, points(), async (f) => {
    expectSelection(await f.key("Home", 1), f.points[0].observation.id);
    expectSelection(await f.key("End", 2), f.points.at(-1).observation.id);
    expectSelection(await f.key("ArrowLeft", 0), f.points[1].observation.id);
    const before = f.trace.length;
    expectSelection(await f.dispatch("click", 0, { outside: true }), f.points[1].observation.id);
    assert.equal(
      f.trace.length,
      before,
      "An out-of-plot pointer cannot manufacture a new selection",
    );
  });
});
