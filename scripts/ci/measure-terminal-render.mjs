import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  buildFixture,
  closeServer,
  roundMs,
  runPageTrial,
  startStaticServer,
} from "./terminal-render-browser.mjs";
import { runInputPageTrial } from "./terminal-render-input.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixturePath = "packages/ui/test/performance-chat-code.html";
const sourceDir = resolve(root, "packages/ui/src/components/ai-elements");
const baselineDir = process.argv[2];
const outputPath = process.argv[3] ? resolve(process.argv[3]) : null;

if (!baselineDir || !outputPath) {
  throw new Error(
    "Usage: node scripts/ci/measure-terminal-render.mjs <baseline-source-dir> <output.json>",
  );
}

const normalizedBaselineDir = resolve(baselineDir);
const baselineSources = new Map(
  await Promise.all(
    ["message.tsx", "code-block.tsx"].map(async (name) => [
      resolve(sourceDir, name).replaceAll("\\", "/"),
      await readFile(join(normalizedBaselineDir, name), "utf8"),
    ]),
  ),
);

const variants = ["before", "after"];
const viewport = { width: 1280, height: 900 };
const measuredTrialsPerVariant = 7;
const inputTrialsPerVariant = 3;
const metricNames = ["ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration"];

function sampleStats(values, expectedSamples = values.length) {
  assert.ok(values.length <= expectedSamples);
  const validValues = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  const stats = {
    samples: expectedSamples,
    validSamples: validValues.length,
    missingSamples: expectedSamples - validValues.length,
  };
  if (validValues.length === 0) {
    return { ...stats, medianMs: null, p95Ms: null };
  }

  const sorted = [...validValues].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    ...stats,
    medianMs: roundMs(median),
    p95Ms: roundMs(sorted[Math.ceil(0.95 * sorted.length) - 1]),
  };
}

function summarizeSamples(rows) {
  assert.equal(rows.length, measuredTrialsPerVariant);
  return {
    samples: rows.length,
    terminal: {
      commitMs: sampleStats(rows.map((row) => row.terminal.commitMs)),
      twoRafMs: sampleStats(rows.map((row) => row.terminal.twoRafMs)),
      firstVisibleHighlightMs: sampleStats(rows.map((row) => row.terminal.firstVisibleHighlightMs)),
      longTaskTotalMs: sampleStats(
        rows.map((row) =>
          row.terminal.longTasksMs.reduce((total, duration) => total + duration, 0),
        ),
      ),
      performanceDeltaMs: Object.fromEntries(
        metricNames.map((name) => [
          name,
          sampleStats(rows.map((row) => row.terminal.performanceDeltaMs[name])),
        ]),
      ),
    },
    history: {
      commitMs: sampleStats(rows.map((row) => row.history.commitMs)),
      twoRafMs: sampleStats(rows.map((row) => row.history.twoRafMs)),
      firstVisibleHighlightMs: sampleStats(rows.map((row) => row.history.firstVisibleHighlightMs)),
      longTaskTotalMs: sampleStats(
        rows.map((row) => row.history.longTasksMs.reduce((total, duration) => total + duration, 0)),
      ),
      performanceDeltaMs: Object.fromEntries(
        metricNames.map((name) => [
          name,
          sampleStats(rows.map((row) => row.history.performanceDeltaMs[name])),
        ]),
      ),
    },
  };
}

function summarizeInputSamples(rows) {
  assert.equal(rows.length, inputTrialsPerVariant);
  const summarizeScenario = (scenario) => {
    const samples = rows.map((row) => row[scenario]);
    const timestampValidSamples = samples.filter((sample) => sample.timestampValidation.respected);
    const summarizeDelay = (selector) =>
      sampleStats(timestampValidSamples.map(selector), inputTrialsPerVariant);

    return {
      samples: samples.length,
      inputDelayUsableSamples: timestampValidSamples.length,
      inputDelayExcludedTimestampSamples: samples.length - timestampValidSamples.length,
      inputDelayConclusion:
        timestampValidSamples.length > 0 ? "validated-samples-only" : "unavailable",
      enterKeydownDelayMs: summarizeDelay((sample) => sample.inputHandlingDelayMs.enterKeydownMs),
      xKeydownDelayMs: summarizeDelay((sample) => sample.inputHandlingDelayMs.xKeydownMs),
      xEchoCommitDelayMs: summarizeDelay((sample) => sample.inputHandlingDelayMs.xEchoCommitMs),
      transitionCommitMs: sampleStats(
        samples.map((sample) => sample.transitionMeasure.commitMs),
        inputTrialsPerVariant,
      ),
      longTaskTotalMs: sampleStats(
        samples.map((sample) =>
          sample.longTasksMs.reduce((total, duration) => total + duration, 0),
        ),
        inputTrialsPerVariant,
      ),
    };
  };

  return {
    samples: rows.length,
    terminal: summarizeScenario("terminal"),
    history: summarizeScenario("history"),
  };
}

const tempRoot = await mkdtemp(join(tmpdir(), "zcodium-terminal-render-"));
const servers = [];
let context;
try {
  const buildDirs = new Map();
  let baselineReplacementLoadHits;
  for (const variant of variants) {
    const buildResult = await buildFixture({
      variant,
      root,
      fixturePath,
      tempRoot,
      baselineSources,
    });
    buildDirs.set(variant, buildResult.buildDir);
    if (variant === "before") {
      baselineReplacementLoadHits = buildResult.baselineReplacementLoadHits;
    }
  }

  const endpoints = new Map();
  for (const variant of variants) {
    const endpoint = await startStaticServer(buildDirs.get(variant));
    servers.push(endpoint.server);
    endpoints.set(variant, endpoint.baseUrl);
  }

  context = await chromium.launchPersistentContext(join(tempRoot, "browser-profile"), {
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    viewport,
  });
  const blockedRequests = [];
  const pageErrors = [];

  for (const variant of variants) {
    await runPageTrial({
      context,
      baseUrl: endpoints.get(variant),
      fixturePath,
      blockedRequests,
      pageErrors,
      variant,
      trial: "warmup",
      metricNames,
    });
  }

  const results = [];
  for (let trial = 1; trial <= measuredTrialsPerVariant; trial++) {
    const order = trial % 2 === 1 ? ["before", "after"] : ["after", "before"];
    for (const variant of order) {
      results.push(
        await runPageTrial({
          context,
          baseUrl: endpoints.get(variant),
          fixturePath,
          blockedRequests,
          pageErrors,
          variant,
          trial,
          metricNames,
        }),
      );
    }
  }

  const inputResults = [];
  for (let trial = 1; trial <= inputTrialsPerVariant; trial++) {
    const order = trial % 2 === 1 ? ["before", "after"] : ["after", "before"];
    for (const variant of order) {
      inputResults.push(
        await runInputPageTrial({
          context,
          baseUrl: endpoints.get(variant),
          fixturePath,
          blockedRequests,
          pageErrors,
          variant,
          trial,
        }),
      );
    }
  }

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, []);
  const output = {
    recordedAt: new Date().toISOString(),
    baselineDir: normalizedBaselineDir,
    baselineFiles: [...baselineSources.keys()].map((path) => basename(path)),
    baselineReplacementLoadHits,
    browserVersion: context.browser()?.version() ?? "unknown",
    viewport,
    payloadChars: 34_122,
    fences: 240,
    warmupsPerVariant: 1,
    measuredTrialsPerVariant,
    inputTrialsPerVariant,
    results,
    inputResults,
    summaries: variants.map((variant) => ({
      variant,
      ...summarizeSamples(results.filter((row) => row.variant === variant)),
    })),
    inputSummaries: variants.map((variant) => ({
      variant,
      ...summarizeInputSamples(inputResults.filter((row) => row.variant === variant)),
    })),
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");

  console.log(
    "terminal-render " +
      JSON.stringify({
        outputPath,
        measuredPages: results.length,
        inputPages: inputResults.length,
        samplesPerVariant: measuredTrialsPerVariant,
        inputSamplesPerVariant: inputTrialsPerVariant,
        summaries: output.summaries,
        inputSummaries: output.inputSummaries,
      }),
  );
} finally {
  try {
    await context?.close();
  } finally {
    try {
      await Promise.all(servers.map(closeServer));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}
