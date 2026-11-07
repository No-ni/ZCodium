"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

(async () => {
  const qaRoot = path.resolve(__dirname, "..");
  const files = ["feature-inventory.md", "coverage-matrix.md", "test-report.md"];
  const inputs = await Promise.all(files.map(async (file) => {
    const content = await fs.readFile(path.join(qaRoot, file), "utf8");
    return { file, content, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  }));
  const inventory = [...inputs[0].content.matchAll(/^\|\s*([A-Z]+-\d+)\s*\|/gmu)].map((match) => match[1]);
  const groups = inputs[1].content.split(/\r?\n/u).flatMap((line, index) => {
    const match = line.match(/^\|\s*<a id="([^"]+)"><\/a>([A-Z]+-\d+)\s*\|/u);
    if (!match) return [];
    const columns = line.split("|");
    return [{ id: match[2], anchor: match[1], line: index + 1, status: columns[4].trim() }];
  });
  const inventorySet = new Set(inventory);
  const matrixSet = new Set(groups.map((group) => group.id));
  const matrixAnchors = new Set(groups.map((group) => group.anchor));
  const missingGroups = inventory.filter((id) => !matrixSet.has(id));
  const extraGroups = groups.filter((group) => !inventorySet.has(group.id)).map((group) => group.id);
  const badAnchors = groups.filter((group) => group.anchor !== group.id.toLowerCase()).map((group) => group.id);
  const missingLocalLinks = [];
  let localLinks = 0;
  for (const target of [...inputs[1].content.matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1])) {
    if (/^https?:/u.test(target)) continue;
    localLinks += 1;
    if (target.startsWith("#")) {
      if (!matrixAnchors.has(target.slice(1))) missingLocalLinks.push(target);
      continue;
    }
    const [file, fragment] = target.split("#");
    try {
      const resolved = path.resolve(qaRoot, file);
      await fs.access(resolved);
      if (resolved === path.join(qaRoot, "coverage-matrix.md") && fragment && !matrixAnchors.has(fragment)) missingLocalLinks.push(target);
    } catch {
      missingLocalLinks.push(target);
    }
  }
  const partial = groups.filter((group) => group.status.includes("partial"));
  const noPartial = groups.filter((group) => !group.status.includes("partial"));
  const notRun = groups.filter((group) => group.status.includes("NOT-RUN"));
  const blocked = groups.filter((group) => group.status.includes("BLOCKED"));
  const union = groups.filter((group) => group.status.includes("BLOCKED") || group.status.includes("NOT-RUN"));
  const result = {
    capturedAt: new Date().toISOString(),
    evidenceKind: "Read-only inventory/matrix identity, anchors and local evidence-link audit; no UI, build, Host or product validation",
    inputs: inputs.map(({ file, sha256 }) => ({ file, sha256 })),
    inventoryGroups: inventory.length,
    inventoryUniqueGroups: inventorySet.size,
    matrixGroups: groups.length,
    matrixUniqueGroups: matrixSet.size,
    uniqueAnchors: matrixAnchors.size,
    missingGroups,
    extraGroups,
    badAnchors,
    localLinks,
    missingLocalLinks,
    partialGroupCount: partial.length,
    noPartialGroups: noPartial.map((group) => group.id),
    groupsWithAnyTargetedExecutionOrFailureEvidence: groups.length - notRun.length,
    notRunGroups: notRun.map((group) => group.id),
    blockedGroups: blocked.map((group) => group.id),
    blockedOrNotRunUniqueGroups: union.length,
    failureLabelCount: groups.filter((group) => group.status.includes("FAIL")).length,
    atomicMenuActionCount: null,
    atomicMenuActionCountReason: "87 inventories functional groups; individual state/action combinations were not exhaustively counted. Partial and failure labels overlap.",
  };
  result.accepted = inventory.length === 87 && inventorySet.size === 87 && groups.length === 87 && matrixSet.size === 87 && matrixAnchors.size === 87 && missingGroups.length === 0 && extraGroups.length === 0 && badAnchors.length === 0 && missingLocalLinks.length === 0 && partial.length === 84 && notRun.length === 2 && blocked.length === 10;
  await fs.writeFile(path.join(__dirname, "feature-inventory-final-matrix-audit.json"), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.accepted) process.exitCode = 1;
})().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
