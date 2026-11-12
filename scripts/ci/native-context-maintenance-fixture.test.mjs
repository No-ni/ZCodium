import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertProjectPath, projectRoot } from "./project-test-sandbox.mjs";

assert.equal(process.version, "v24.14.0");
const helperRoot = join(
  projectRoot,
  "packages/desktop/test/e2e/helpers/native-context-compression",
);
const directory = await assertProjectPath(
  join(process.env.TEMP, "native-maintenance-fixture-source"),
);
await mkdir(directory, { recursive: true });
const result = await build({
  stdin: {
    contents: `export * from ${JSON.stringify(join(helperRoot, "replay-summary.ts"))};
export * from ${JSON.stringify(join(helperRoot, "maintenance-source.ts"))};
export {nativeContextCompressToolSchema} from '@zcode/shared/native-context-compression';`,
    resolveDir: projectRoot,
    sourcefile: "native-maintenance-fixture-source.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  metafile: true,
  format: "esm",
  platform: "node",
  alias: {
    "@zcode/shared/native-context-compression": join(
      projectRoot,
      "packages/shared/src/native-context-compression/index.ts",
    ),
  },
  logLevel: "silent",
});
assert.ok(
  Object.keys(result.metafile.inputs).some((input) =>
    input.endsWith("native-context-compression/replay-summary.ts"),
  ),
);
assert.equal(
  Object.keys(result.metafile.inputs).some((input) => /packages\/shared\/dist\//u.test(input)),
  false,
);
const target = await assertProjectPath(join(directory, "source.mjs"));
await writeFile(target, result.outputFiles[0].text);
const {
  nativeContextSummaryReplayVariable,
  nativeContextOfferedSourceRef,
  nativeContextCompressToolSchema,
  NATIVE_CONTEXT_MAINTENANCE_MARKER,
  NATIVE_CONTEXT_AUTO_MAINTENANCE_MARKER,
  NATIVE_CONTEXT_SUMMARY_SOURCE_MARKER,
  NATIVE_CONTEXT_AUTO_SUMMARY_SOURCE_MARKER,
  NATIVE_CONTEXT_REPLAY_SUMMARY,
} = await import(pathToFileURL(target).href);

const request = (mode, change = {}) => ({
  system:
    (mode === "manual"
      ? NATIVE_CONTEXT_MAINTENANCE_MARKER
      : NATIVE_CONTEXT_AUTO_MAINTENANCE_MARKER) + ": synthetic maintenance",
  messages: [
    {
      role: "user",
      content: JSON.stringify({
        currentTokens: 6000,
        targetTokens: 2000,
        ranges: [
          {
            startRef: "m00012",
            endRef: "m00013",
            tier: 1,
            source:
              (mode === "manual"
                ? NATIVE_CONTEXT_SUMMARY_SOURCE_MARKER
                : NATIVE_CONTEXT_AUTO_SUMMARY_SOURCE_MARKER) + ": source facts",
          },
        ],
        outputs: [{ ref: "to00001", source: "a real internal output template" }],
        ...change,
      }),
    },
  ],
});

for (const mode of ["manual", "automatic"])
  test(`${mode}: internal outputs remain legal but Provider tool JSON is strictly ranges only`, () => {
    const response = JSON.parse(nativeContextSummaryReplayVariable(request(mode), mode));
    const parsed = nativeContextCompressToolSchema.parse(response);
    assert.deepEqual(Object.keys(response), ["ranges"]);
    assert.equal(parsed.ranges[0].startRef, "m00012");
    assert.equal(parsed.ranges[0].endRef, "m00013");
    assert.equal(parsed.ranges[0].summary, NATIVE_CONTEXT_REPLAY_SUMMARY);
  });

test("internal replay output template still rejects unknown and duplicate fields", () => {
  assert.throws(() => nativeContextSummaryReplayVariable(request("manual", { extra: true })));
  assert.throws(() =>
    nativeContextSummaryReplayVariable(
      request("manual", { outputs: [{ ref: "to00001", source: "facts", extra: true }] }),
    ),
  );
  assert.throws(() =>
    nativeContextSummaryReplayVariable(
      request("manual", {
        outputs: [
          { ref: "to00001", source: "facts" },
          { ref: "to00001", source: "again" },
        ],
      }),
    ),
  );
});

const interruption = (sources) => ({
  messages: [
    {
      role: "user",
      content: JSON.stringify({
        currentTokens: 6000,
        targetTokens: 2000,
        ranges: sources.map((source) => ({
          startRef: "m00012",
          endRef: "m00013",
          tier: 1,
          source,
        })),
        outputs: [],
      }),
    },
  ],
});
const marker = "E2E_NCTX_INTERRUPT_MODE_SOURCE";
const source = `[m00012 user firstSeen=1]\nold-case-source\n\n[m00013 user firstSeen=2]\n${marker}: immutable facts`;

test("cross-message range resolves this case's real header rather than the old startRef", () => {
  assert.equal(nativeContextOfferedSourceRef(interruption([source]), marker), "m00013");
});
test("source header remains valid without optional timestamps and with CRLF", () => {
  const plain = source.replaceAll(/ firstSeen=\d+/gu, "").replaceAll("\n", "\r\n");
  assert.equal(nativeContextOfferedSourceRef(interruption([plain]), marker), "m00013");
});
test("offered source identity is bounded and unique across actual ranges", () => {
  assert.throws(() =>
    nativeContextOfferedSourceRef(
      interruption([source.replace("m00013 user", "m00014 user")]),
      marker,
    ),
  );
  assert.throws(() =>
    nativeContextOfferedSourceRef(
      interruption([source.replace("old-case-source", marker + ": another message")]),
      marker,
    ),
  );
  assert.throws(() => nativeContextOfferedSourceRef(interruption([source]), "absent-marker"));
});
