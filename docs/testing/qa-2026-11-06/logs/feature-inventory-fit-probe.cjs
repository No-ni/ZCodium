"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

(async () => {
  const repository = path.resolve(__dirname, "../../../..");
  const sourcePath = path.join(
    repository,
    "packages/ui/src/prompt-editor/useComposerToolbarFit.ts",
  );
  const observationPath = path.join(
    __dirname,
    "../runtime/qa-menu-20261106-local-canonical/evidence/qa-composer-fit-0-6-001-30916-1793988522119.json",
  );
  const outputPath = path.join(__dirname, "feature-inventory-fit-probe.json");
  for (const candidate of [sourcePath, observationPath, outputPath]) {
    const rel = path.relative(repository, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel))
      throw new Error("Probe path outside worktree");
    for (let cursor = candidate; ; cursor = path.dirname(cursor)) {
      try {
        const item = await fs.lstat(cursor);
        if (
          item.isSymbolicLink() ||
          (await fs.realpath(cursor)).toLowerCase() !== cursor.toLowerCase()
        )
          throw new Error("Probe redirected path");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (cursor.toLowerCase() === repository.toLowerCase()) break;
    }
  }
  const source = await fs.readFile(sourcePath, "utf8");
  const observationBytes = await fs.readFile(observationPath);
  const observation = JSON.parse(observationBytes.toString("utf8"));
  const snapshots = observation.history.snapshots.filter(
    (item) => item.protected240,
  );
  if (snapshots.length !== 2)
    throw new Error("Missing exact two protected240 snapshots");
  const dom = new JSDOM(
    '<div id="host"><div id="root"><div data-composer-leading-actions><div data-composer-leading-content><span data-composer-action-menu></span><span data-composer-collapse-priority="1"></span></div></div><div data-composer-trailing-actions><button data-composer-collapse-priority="3" data-composer-combined-model></button></div></div></div>',
  );
  try {
    const module = { exports: {} };
    const code = ts.transpileModule(
      source + "\nexport { createComposerToolbarProbe };\n",
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    vm.runInNewContext(
      code,
      {
        module,
        exports: module.exports,
        require: (name) => {
          if (name === "react") return {};
          throw new Error("Unexpected production import");
        },
        getComputedStyle: () => ({ columnGap: "12px" }),
      },
      { filename: sourcePath, timeout: 1000 },
    );
    const root = dom.window.document.querySelector("#root");
    const dimensions = [
      [root, 240],
      [root.querySelector("[data-composer-leading-actions]"), 0],
      [
        root.querySelector("[data-composer-leading-content]"),
        snapshots[0].leadingContent.rect.width,
      ],
      [
        root.querySelector("[data-composer-trailing-actions]"),
        snapshots[0].trailing.rect.width,
      ],
    ];
    for (const [element, width] of dimensions)
      element.getBoundingClientRect = () => ({ width });
    const probe = module.exports.createComposerToolbarProbe(root);
    module.exports.fitComposerToolbar(probe);
    const probeMissing = [
      "[data-composer-leading-actions]",
      "[data-composer-leading-content]",
      "[data-composer-trailing-actions]",
      "[data-composer-combined-model]",
    ].filter((selector) => !probe.querySelector(selector));
    module.exports.fitComposerToolbar(root);
    const evidence = {
      capturedAt: new Date().toISOString(),
      evidenceKind:
        "No browser, Electron, React mounting or UI. Production source transpiled in memory; non-rendered synthetic DOM structure and geometry from real protected240 snapshots. Not new E2E case evidence.",
      sourcePath,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      observationPath,
      observationSha256: createHash("sha256")
        .update(observationBytes)
        .digest("hex"),
      protected240: snapshots.map((item) => ({
        elapsedMs: item.elapsedMs,
        toolbarWidth: item.toolbar.rect.width,
        toolbarScrollWidth: item.toolbar.scrollWidth,
        toolbarDataset: item.toolbar.dataset,
        shellDataset: item.shell.dataset,
        modelWidth: item.model.rect.width,
        labelDisplay: item.label.computed.display,
        iconDisplay: item.icon.computed.display,
        thoughtDisplay: item.thought.computed.display,
        leadingWidth: item.leading.rect.width,
        leadingContentWidth: item.leadingContent.rect.width,
        trailingWidth: item.trailing.rect.width,
      })),
      probeChildren: probe.children.length,
      probeMissing,
      probeDataset: { ...probe.dataset },
      directLiveDataset: { ...root.dataset },
      confirmedStructureMismatch:
        probeMissing.length === 4 &&
        !probe.dataset.composerModelIcon &&
        root.dataset.composerModelIcon === "true",
      limits:
        "Synthetic geometry cannot prove React ref.current owner, ResizeObserver execution, real-width window reproduction, open-picker aria-expanded or focus/node persistence. Actual JSON did not record aria-expanded; Tooltip data-state closed is not proof menu closed.",
    };
    await fs.writeFile(outputPath, JSON.stringify(evidence, null, 2) + "\n", {
      flag: "wx",
    });
    process.stdout.write(
      JSON.stringify({
        outputPath,
        confirmedStructureMismatch: evidence.confirmedStructureMismatch,
        probeMissing,
        directLiveDataset: evidence.directLiveDataset,
      }) + "\n",
    );
    if (!evidence.confirmedStructureMismatch) process.exitCode = 1;
  } finally {
    dom.window.close();
  }
})().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
