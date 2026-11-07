"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
(async () => {
  const root = path.resolve(__dirname, "..");
  const content = await fs.readFile(path.join(root, "coverage-matrix.md"), "utf8");
  const anchors = [...content.matchAll(/<a id="([^"]+)"><\/a>/gu)].map((match) => match[1]);
  const targets = [...content.matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1]);
  const missing = [];
  for (const target of targets) {
    if (target.startsWith("#") || /^https?:/u.test(target)) continue;
    try { await fs.access(path.resolve(root, target.split("#")[0])); }
    catch { missing.push(target); }
  }
  const rows = content.split(/\r?\n/u).filter((line) => /^\| <a id=/u.test(line));
  const status = (line) => line.split("|")[4];
  const summary = {
    anchors: anchors.length, uniqueAnchors: new Set(anchors).size,
    links: targets.length, missing,
    groups: rows.length,
    notRun: rows.filter((line) => status(line).includes("NOT-RUN")).length,
    blocked: rows.filter((line) => status(line).includes("BLOCKED")).length,
    failureLabels: rows.filter((line) => status(line).includes("FAIL")).length,
  };
  process.stdout.write(JSON.stringify(summary) + "\n");
  if (anchors.length !== 87 || new Set(anchors).size !== 87 || rows.length !== 87 || missing.length) process.exitCode = 1;
})().catch((error) => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
