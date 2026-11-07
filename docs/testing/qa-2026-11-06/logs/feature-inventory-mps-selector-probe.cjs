"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
(async () => {
  const root = path.resolve(__dirname, "../../../..");
  const spec = path.join(root, "packages/desktop/test/e2e/conversation-session/conversation-session-markdown-preview-selection.test.ts");
  const target = path.join(__dirname, "feature-inventory-mps-selector-probe.json");
  for (const candidate of [root, __dirname, target]) {
    try {
      const item = await fs.lstat(candidate);
      if (item.isSymbolicLink() || (await fs.realpath(candidate)).toLowerCase() !== candidate.toLowerCase()) throw new Error("Redirected probe path");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const { JSDOM } = require("jsdom");
  const { parse } = require("css-what");
  const directory = path.join(root, "docs/testing/qa-2026-11-06/runtime/qa-menu-20261106-local-canonical/.e2e-home-qa-menu-20261106-local-canonical/ZCodeProject/.zcode-e2e/markdown-preview-selection");
  const id = "workspace-file-tree-row-" + directory;
  const rawSelector = `[data-testid="${id}"]`;
  const escapedSelector = `[data-testid="${id.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
  const dom = new JSDOM("<div></div>");
  try {
    dom.window.document.querySelector("div").setAttribute("data-testid", id);
    const evidence = {
      capturedAt: new Date().toISOString(),
      evidenceKind: "Local non-rendered DOM/CSS parser proof for a synthetic attribute only; not Electron UI or file-tree rendering evidence.",
      node: process.version,
      sourceSha256: createHash("sha256").update(await fs.readFile(spec)).digest("hex"),
      rawSelector, escapedSelector,
      cssParserDecodedValue: parse(rawSelector)[0][0].value,
      attributeValue: id,
      rawSelectorMatched: dom.window.document.querySelector(rawSelector) !== null,
      escapedSelectorMatched: dom.window.document.querySelector(escapedSelector) !== null,
    };
    evidence.confirmedQaSelectorMismatch = !evidence.rawSelectorMatched && evidence.escapedSelectorMatched && evidence.cssParserDecodedValue !== evidence.attributeValue;
    await fs.writeFile(target, JSON.stringify(evidence, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ target, confirmedQaSelectorMismatch: evidence.confirmedQaSelectorMismatch, rawSelectorMatched: evidence.rawSelectorMatched, escapedSelectorMatched: evidence.escapedSelectorMatched }) + "\n");
    if (!evidence.confirmedQaSelectorMismatch) process.exitCode = 1;
  } finally { dom.window.close(); }
})().catch((error) => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
