import assert from "node:assert/strict";
import { it } from "node:test";
import {
  analyzeWorkflowScript,
  causalityGraphToMermaid,
  decodeAnalysisCore,
  encodeAnalysisCore,
  holeSiteId,
  serializeCausalityGraph,
  serializeControlFlow,
  serializeCore,
  siteGraphToMermaid,
} from "../src/index.js";
import {
  projectCausalityGraph,
  projectHandoffGraph,
  projectSiteGraph,
  serializeGraph,
} from "../src/projections.js";

function analyzed(script: string) {
  const result = analyzeWorkflowScript(script);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(result.core && result.graph && result.causality && result.flow && result.handoff);
  return {
    ...result,
    core: result.core,
    graph: result.graph,
    causality: result.causality,
    flow: result.flow,
    handoff: result.handoff,
  };
}

it("open hole prompts receive data and their typed results feed consumers and return", () => {
  const hole = holeSiteId("decide");
  const { core, graph, causality, handoff, flow } = analyzed(
    [
      'phase("work");',
      'const scanner = agent("scanner");',
      'const reviewer = agent("reviewer");',
      'const input = await scanner.ask<string>("scan");',
      'const plan = await hole<string>("decide", `use ${input}`);',
      "const review = await reviewer.ask<string>(plan);",
      "return { plan, review };",
    ].join("\n"),
  );
  assert.deepEqual(core.facts.holeData.get(hole), [{ site: "ask#1", exact: true }]);
  assert.equal(graph.nodes.find((node) => node.id === hole)?.artifactType, "string");
  for (const [from, to] of [
    ["ask#1", hole],
    [hole, "ask#2"],
    [hole, "sink"],
  ]) {
    assert.ok(
      graph.edges.some(
        (edge) => edge.kind === "data" && edge.from === from && edge.to === to && edge.exact,
      ),
    );
  }
  const step = causality.steps.find((entry) => entry.id === hole);
  assert.equal(step?.kind, "hole");
  assert.equal(step?.lane, "main");
  assert.ok(causality.lanes.some((lane) => lane.id === "main"));
  assert.ok(
    causality.edges.some(
      (edge) => edge.kind === "data" && edge.from === "ask#1" && edge.to === hole,
    ),
  );
  assert.ok(
    causality.edges.some(
      (edge) => edge.kind === "data" && edge.from === hole && edge.to === "ask#2",
    ),
  );
  assert.ok(
    handoff.handoffs.some(
      (edge) =>
        edge.from.endsWith(":actor#1") &&
        edge.to.endsWith(":main") &&
        edge.types?.includes("string"),
    ),
  );
  assert.ok(
    handoff.handoffs.some(
      (edge) =>
        edge.from.endsWith(":main") &&
        edge.to.endsWith(":actor#2") &&
        edge.types?.includes("string"),
    ),
  );
  assert.match(serializeCore(core), new RegExp(`fact hole-data ${hole} <- ask#1 exact`));
  assert.match(serializeGraph(graph), new RegExp(`edge ${hole} -> ask#2 data exact type="string"`));
  assert.match(
    serializeCausalityGraph(causality),
    new RegExp(`step ${hole} hole "decide".*lane=main`),
  );
  assert.match(serializeControlFlow(flow), new RegExp(`hole ${hole} "decide" type="string"`));
  assert.ok(siteGraphToMermaid(graph).includes('[["decide<br/>'));
  assert.ok(causalityGraphToMermaid(causality).includes('[["decide<br/>'));
});

it("a prompt with no producer gets source completion and independent holes get no FIFO", () => {
  const first = holeSiteId("first");
  const second = holeSiteId("second");
  const { graph, causality } = analyzed(
    [
      'async function branch() { return await hole<string>("first", "plain"); }',
      "const pending = branch();",
      'const result = await hole<string>("second");',
      "return { pending: await pending, result };",
    ].join("\n"),
  );
  for (const hole of [first, second]) {
    assert.ok(
      graph.edges.some(
        (edge) => edge.from === "source" && edge.to === hole && edge.kind === "data",
      ),
    );
  }
  assert.equal(
    causality.edges.some((edge) => edge.from === first && edge.to === second),
    false,
  );
  assert.equal(
    causality.edges.some((edge) => edge.from === second && edge.to === first),
    false,
  );
});

it("filled hole returns actual body producers and nested holes retain nearest fill ownership", () => {
  const outer = holeSiteId("outer");
  const inner = holeSiteId("inner");
  const { core, graph, causality, flow } = analyzed(
    [
      'const scanner = agent("scanner");',
      'const reviewer = agent("reviewer");',
      'const input = await scanner.ask<string>("scan");',
      'const output = await hole<string>("outer", input, async () => {',
      '  const text = await files.read("README.md");',
      '  const chosen = await hole<string>("inner", text);',
      "  return chosen;",
      "});",
      "const result = await reviewer.ask<string>(output);",
      "return result;",
    ].join("\n"),
  );
  const read = `${outer}/world-read#1`;
  assert.equal(core.facts.holeData.has(outer), false);
  assert.equal(
    graph.nodes.some((node) => node.id === outer),
    false,
  );
  assert.equal(
    causality.steps.some((step) => step.id === outer),
    false,
  );
  assert.deepEqual(core.facts.holeData.get(inner), [{ site: read, exact: true }]);
  assert.deepEqual(core.facts.askData.get("ask#2"), [{ site: inner, exact: true }]);
  assert.equal(
    graph.edges.some(
      (edge) => edge.from === "ask#1" && edge.to === "ask#2" && edge.kind === "data",
    ),
    false,
  );
  assert.equal(causality.steps.find((step) => step.id === read)?.fill, outer);
  assert.equal(causality.steps.find((step) => step.id === inner)?.fill, outer);
  assert.match(
    serializeCausalityGraph(causality),
    new RegExp(`step ${inner} hole .* fill=${outer}`),
  );
  assert.equal(flow.phases?.find((phase) => phase.name === "inner")?.fill, outer);
  assert.match(serializeControlFlow(flow), new RegExp(`phase ${inner} "inner" fill=${outer}`));
});

it("a direct filled body preserves exact return dependencies without a phantom hole producer", () => {
  const outer = holeSiteId("outer");
  const { graph, core, causality } = analyzed(
    [
      'const worker = agent("worker");',
      'const x = await hole<string>("outer", async () => {',
      '  phase("inside");',
      '  return await files.read("README.md");',
      "});",
      "return await worker.ask<string>(x);",
    ].join("\n"),
  );
  assert.deepEqual(core.facts.askData.get("ask#1"), [
    { site: `${outer}/world-read#1`, exact: true },
  ]);
  assert.ok(
    graph.edges.some(
      (edge) => edge.from === `${outer}/world-read#1` && edge.to === "ask#1" && edge.exact,
    ),
  );
  assert.equal(causality.phases?.find((phase) => phase.name === "inside")?.fill, outer);
  assert.match(
    serializeCausalityGraph(causality),
    new RegExp(`phase phase#1 "inside".*fill=${outer}`),
  );
});

it("core JSON round trips holes and accepts both missing legacy keys", () => {
  const { core, graph, causality, handoff } = analyzed('return await hole<string>("tail");');
  const decoded = decodeAnalysisCore(JSON.parse(JSON.stringify(encodeAnalysisCore(core))));
  assert.deepEqual(decoded, core);
  const sites = projectSiteGraph(decoded);
  const order = projectCausalityGraph(decoded, sites);
  assert.deepEqual(sites, graph);
  assert.deepEqual(order, causality);
  assert.deepEqual(projectHandoffGraph(decoded, order, sites), handoff);
  const old = encodeAnalysisCore(analyzed('return await files.read("README.md");').core);
  delete old.sites.holes;
  delete old.facts.holeData;
  const legacy = decodeAnalysisCore(old);
  assert.deepEqual(legacy.sites.holes, []);
  assert.deepEqual(legacy.facts.holeData, new Map());
});
