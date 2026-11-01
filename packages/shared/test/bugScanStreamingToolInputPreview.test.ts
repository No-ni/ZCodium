import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { buildZCodeStreamingToolInputPreview } from "../src/streaming-tool-input-preview.js";

function preview(rawInput: string): unknown {
  const result = buildZCodeStreamingToolInputPreview(rawInput);
  assert.equal(result.complete, false);
  assert.equal(result.rawInput, rawInput);
  return result.input;
}

test("incomplete preview does not adopt a nested file path or command", () => {
  assert.deepEqual(
    preview('{"metadata":{"file_path":"/nested","command":"nested"},"content":"draft'),
    {
      content: "draft",
    },
  );
});

test("incomplete top-level arrays do not become tool parameter objects", () => {
  assert.deepEqual(preview('[{"path":"/nested"},'), {});
});

test("escaped JSON field names have the same meaning as complete input", () => {
  assert.deepEqual(preview('{"file\\u005fpath":"/fixture/file","content":"draft'), {
    file_path: "/fixture/file",
    content: "draft",
  });
});

test("a later duplicate field supersedes the first field while streaming", () => {
  assert.deepEqual(preview('{"path":"/old","path":"/new'), { path: "/new" });
});

test("a later non-string field removes an obsolete string preview", () => {
  assert.deepEqual(preview('{"path":"/old","path":{"nested":"value"},"content":"draft'), {
    content: "draft",
  });
});

test("an escaped literal unicode prefix is preserved before the closing quote", () => {
  const content = "prefix\\u12";
  const raw = '{"content":' + JSON.stringify(content).slice(0, -1);
  assert.deepEqual(preview(raw), { content });
});

test("escaped field-like string contents do not become other parameters", () => {
  const content = 'draft "path":"/fake" and "command":"fake"';
  assert.deepEqual(preview('{"content":' + JSON.stringify(content) + ","), { content });
});

test("nested unknown objects and arrays are skipped before later top-level fields", () => {
  const raw =
    '{"unknown":[{"content":"nested","data":[{},[]]},"quotes \\\""],"file_path":"/fixture/a","script":"echo draft';
  assert.deepEqual(preview(raw), { file_path: "/fixture/a", script: "echo draft" });
});

for (const field of [
  "file_path",
  "filePath",
  "path",
  "target_path",
  "targetPath",
  "filename",
  "file",
  "content",
  "new_string",
  "newString",
  "new_text",
  "newText",
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "command",
  "description",
  "title",
  "pattern",
  "replacement",
  "plan",
  "name",
  "script",
]) {
  test(`existing streaming string field is retained: ${field}`, () => {
    assert.deepEqual(preview(JSON.stringify({ [field]: "draft" }).slice(0, -2)), {
      [field]: "draft",
    });
  });
}

for (const content of [
  "line\nnext\tend\r",
  'escaped "quote"',
  "one\\",
  "two\\\\",
  "😀中文",
  "literal\\u1234",
  "literal\\\\u12",
  "a\\\\\\u12",
]) {
  test(`valid escaped content survives an incomplete string: ${JSON.stringify(content)}`, () => {
    assert.deepEqual(preview('{"content":' + JSON.stringify(content).slice(0, -1)), { content });
  });
}

for (const tail of ["\\", "\\u", "\\u1", "\\u12", "\\u123"]) {
  test(`only a genuinely incomplete escape is omitted: ${JSON.stringify(tail)}`, () => {
    assert.deepEqual(preview('{"content":"draft' + tail), { content: "draft" });
  });
}

test("complete JSON retains arbitrary values and unknown fields", () => {
  const value = { content: "complete", metadata: { path: "/nested" }, numbers: [1, 2], path: null };
  const rawInput = JSON.stringify(value);
  assert.deepEqual(buildZCodeStreamingToolInputPreview(rawInput), {
    complete: true,
    input: value,
    rawInput,
  });
});

test("explicit complete input bypasses partial parsing without cloning it", () => {
  const input = { content: "complete" };
  const result = buildZCodeStreamingToolInputPreview("invalid draft", input);
  assert.equal(result.complete, true);
  assert.equal(result.input, input);
  assert.equal(result.rawInput, "invalid draft");
});

test("large incomplete input does not run one full-input regex per candidate field", (t) => {
  const content = "fixture draft ".repeat(40_000);
  const rawInput = JSON.stringify({ file_path: "/fixture/large.txt", content }).slice(0, -1);
  const originalExec = RegExp.prototype.exec;
  let fullInputScans = 0;
  RegExp.prototype.exec = function (text: string) {
    if (text === rawInput) fullInputScans += 1;
    return originalExec.call(this, text);
  };
  const start = performance.now();
  let input: unknown;
  try {
    input = preview(rawInput);
  } finally {
    RegExp.prototype.exec = originalExec;
  }
  assert.deepEqual(input, { file_path: "/fixture/large.txt", content });
  t.diagnostic(
    `raw characters=${rawInput.length}; full-input regex scans=${fullInputScans}; observed ms=${(performance.now() - start).toFixed(2)}`,
  );
  assert.ok(fullInputScans <= 1, `Repeated full-input regex scans: ${fullInputScans}`);
});
