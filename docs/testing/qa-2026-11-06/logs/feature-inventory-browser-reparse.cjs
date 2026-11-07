"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const repository = path.resolve(__dirname, "../../../..");
const runRoot = path.join(repository, "docs/testing/qa-2026-11-06/runtime/qa-menu-20261106-browser");
const evidencePath = path.join(__dirname, "feature-inventory-browser-reparse-node.json");

(async () => {
  for (let cursor = runRoot; ; cursor = path.dirname(cursor)) {
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink() || (await fs.realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error("Read-only reparse scan root/ancestor is redirected");
    if (cursor.toLowerCase() === repository.toLowerCase()) break;
  }
  const queue = [runRoot];
  const found = [];
  const errors = [];
  let inspected = 0;
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = await fs.readdir(current); } catch (error) {
      errors.push({path: current, code: error.code, message: error.message});
      continue;
    }
    for (const name of entries) {
      const candidate = path.join(current, name);
      inspected++;
      let stat;
      try {stat = await fs.lstat(candidate);} catch (error) {
        errors.push({path: candidate, code: error.code, message: error.message});
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(candidate);
        const normalized = target.replace(/^\\\\\?\\/u, "");
        const resolvedTarget = path.resolve(path.dirname(candidate), normalized);
        const rel = path.relative(repository, resolvedTarget);
        found.push({path: candidate, nodeLstat: {isSymbolicLink: true, isDirectory: stat.isDirectory(), mode: stat.mode, size: stat.size, createdAt: stat.birthtime.toISOString(), modifiedAt: stat.mtime.toISOString()}, target, resolvedTarget, targetLexicallyInsideWorktree: !rel.startsWith("..") && !path.isAbsolute(rel), targetFollowed: false});
      } else if (stat.isDirectory()) queue.push(candidate);
    }
  }
  const evidence = {capturedAt: new Date().toISOString(), evidenceKind: "Read-only lstat/readdir/readlink scan of completed browser QA run; links not followed, changed or deleted", runRoot, inspected, found, errors};
  await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify({evidencePath, inspected, found, errors}) + "\n");
})().catch((error) => {process.stderr.write(error.stack + "\n"); process.exitCode = 1;});
