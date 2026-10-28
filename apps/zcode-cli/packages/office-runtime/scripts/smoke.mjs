import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readPluginName } from "./plugin-name.mjs";

// Run from a built plugin package, or pass its directory. Checks follow the plugin's formats,
// from its package.json.
// 内置插件的包目录即安装目录，格式声明直接从插件根目录读取。
const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv[2] ?? process.cwd());
const dist = resolve(process.argv[3] ?? join(root, "dist"));
const name = await readPluginName(root);
const { kinds } = JSON.parse(await readFile(join(root, "package.json"), "utf8")).office;
const has = (...wanted) => wanted.every((kind) => kinds.includes(kind));
const ui = (path) => `ui://${name}/${path}`;
const workspace = await mkdtemp(join(tmpdir(), `${name}-smoke-`));
await cp(join(here, "fixtures"), join(workspace, "docs"), {
  recursive: true,
  filter: (path) => !path.endsWith(".py"),
});
const outside = await mkdtemp(join(tmpdir(), `${name}-smoke-outside-`));
await writeFile(join(outside, "escape.pdf"), "synthetic-only PDF");
await symlink(
  outside,
  join(workspace, "linked"),
  process.platform === "win32" ? "junction" : "dir",
);

const client = new Client({ name: `${name}-smoke`, version: "1" });
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const ok = async (name, args) => {
  const result = await call(name, args);
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result;
};
const failCode = async (name, args) => {
  const result = await call(name, args);
  assert.ok(result.isError, `${name} should fail: ${JSON.stringify(result.content)}`);
  return result.structuredContent.error.code;
};
const text = (result) => result.content[0].text;

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(dist, "server.mjs")],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "", ZCODE_WORKSPACE_ROOT: workspace },
      stderr: "pipe",
    }),
  );

  const { tools } = await client.listTools();
  const meta = Object.fromEntries(tools.map((tool) => [tool.name, tool._meta?.ui]));
  assert.deepEqual(meta.open_document, {
    resourceUri: ui("panel.html"),
    surface: name,
    visibility: ["model", "app"],
  });
  assert.equal(meta.show_in_viewer.surface, name);
  assert.deepEqual(meta.show_in_viewer.visibility, ["model"]);
  for (const name of ["read_document", "search_document", "get_view"]) {
    assert.deepEqual(meta[name], { visibility: ["model"] }, `${name} renders no page`);
  }
  for (const name of [
    "list_documents",
    "load_document",
    "check_document",
    "get_viewer",
    "report_view",
    "release_view",
  ])
    assert.deepEqual(meta[name].visibility, ["app"]);
  const open = tools.find((tool) => tool.name === "open_document");
  assert.equal(open._meta["openai/ui"].preferredModelDisplayMode, "fullscreen");
  // Descriptions name only the formats this plugin opens.
  for (const kind of ["docx", "xlsx", "pptx", "pdf"])
    assert.equal(
      open.description.includes(`.${kind}`),
      has(kind),
      `open_document mentions .${kind}`,
    );

  // Panel resource and assets.
  const panel = await client.readResource({ uri: ui("panel.html") });
  assert.equal(panel.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.deepEqual(panel.contents[0]._meta, {
    ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } },
    ...(has("pdf") || has("xlsx") ? { "zcode/csp": { wasmUnsafeEval: true } } : {}),
  });
  const html = panel.contents[0].text;
  assert.ok(html.includes('<div id="root">') && !html.includes("__BOOTSTRAP__"));
  assert.ok(!html.includes("__TITLE__"));
  assert.equal(html.match(/<\/script/gi).length, 1, "loader must not close its script tag early");
  assert.ok(
    Buffer.byteLength(html) < 4 * 1024 * 1024,
    "panel HTML stays small; the UI loads as resources",
  );
  const manifest = JSON.parse(
    (await client.readResource({ uri: ui("assets/assets.json") })).contents[0].text,
  );
  for (const script of manifest.scripts) {
    const part = await client.readResource({ uri: ui(`assets/${script}`) });
    assert.ok(Buffer.byteLength(part.contents[0].text) <= 4 * 1024 * 1024);
  }
  const cmapUri = ui("assets/pdfjs/cmaps/UniGB-UCS2-H.bcmap");
  if (has("pdf")) {
    const cmap = await client.readResource({ uri: cmapUri });
    assert.equal(cmap.contents[0].mimeType, "application/octet-stream");
    assert.ok(cmap.contents[0].blob.length > 100);
  } else await assert.rejects(client.readResource({ uri: cmapUri }));
  // pdf.js wasm（JPEG 2000 / ICC）与无 CJK 系统字体时的兜底字体。
  const fallbackUri = ui("assets/cjk-fallback.json");
  if (has("pdf")) {
    const openjpeg = await client.readResource({ uri: ui("assets/pdfjs/wasm/openjpeg.wasm") });
    assert.ok(
      Buffer.from(openjpeg.contents[0].blob, "base64")
        .subarray(0, 4)
        .equals(Buffer.from([0, 0x61, 0x73, 0x6d])),
    );
    const { faces } = JSON.parse(
      (await client.readResource({ uri: fallbackUri })).contents[0].text,
    );
    assert.ok(faces.length >= 50 && faces.every((face) => face.unicodeRange.startsWith("U+")));
    const slice = await client.readResource({ uri: ui(`assets/${faces[0].file}`) });
    assert.equal(Buffer.from(slice.contents[0].blob, "base64").subarray(0, 4).toString(), "wOF2");
  } else await assert.rejects(client.readResource({ uri: fallbackUri }));
  const wasmUri = ui("assets/sheets.wasm");
  if (has("xlsx")) {
    const wasm = await client.readResource({ uri: wasmUri });
    assert.ok(
      Buffer.from(wasm.contents[0].blob, "base64")
        .subarray(0, 4)
        .equals(Buffer.from([0, 0x61, 0x73, 0x6d])),
    );
  } else await assert.rejects(client.readResource({ uri: wasmUri }));
  await assert.rejects(client.readResource({ uri: ui("assets/..%2Fserver.mjs") }));

  for (const removed of [
    "begin_file_import",
    "write_file_import",
    "finish_file_import",
    "cancel_file_import",
  ]) {
    assert.ok(!tools.some((tool) => tool.name === removed));
    assert.ok((await call(removed)).isError, `${removed} must be rejected by the actual server`);
  }
  for (const report of ["report_view", "release_view"]) {
    assert.equal(
      tools.find((tool) => tool.name === report).annotations.readOnlyHint,
      false,
      "in-memory reports remain mutable",
    );
  }
  const { resources } = await client.listResources();
  assert.equal(resources[0].uri, ui("panel.html"));
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.equal(resourceTemplates.length, 2);
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
    const license = await readFile(join(dist, file), "utf8");
    assert.ok(
      license.length > 100 && /Permission|License/.test(license),
      `${file} carries full attribution`,
    );
  }
  const notices = await readFile(join(dist, "THIRD_PARTY_NOTICES.txt"), "utf8");
  assert.ok(
    !/^Licensed under .+\. Source:/m.test(notices),
    "copyright/license text must not be replaced with SPDX-only fallbacks",
  );
  if (!has("pdf")) {
    assert.ok(notices.includes("Copyright (c) 2026 Nodable"));
    assert.ok(notices.includes("Copyright (c) 2013 Julian Gruber"));
  }
  if (has("xlsx"))
    assert.ok(
      notices.includes("@dukelib/sheets-wasm@0.1.21") &&
        notices.includes("Copyright (c) 2026 Gus Eggert"),
    );
  if (has("pdf"))
    assert.ok(
      notices.includes("SIL OPEN FONT LICENSE") &&
        notices.includes("pdfjs-dist standard_fonts/LICENSE") &&
        notices.includes("pdfjs-dist wasm/LICENSE"),
    );
  await assert.rejects(client.readResource({ uri: ui("assets/..%252Fserver.mjs") }));
  await assert.rejects(client.readResource({ uri: ui("assets/missing.js") }), /invalid_resource/);

  // Empty viewer, listing.
  assert.equal((await ok("get_viewer")).structuredContent.document, null);
  assert.match(text(await ok("get_view")), /no document open/);
  const listed = (await ok("list_documents")).structuredContent.documents
    .map((doc) => doc.path)
    .sort();
  const fixtures = {
    xlsx: "docs/budget.xlsx",
    pptx: "docs/launch.pptx",
    pdf: "docs/paper.pdf",
    docx: "docs/report.docx",
  };
  assert.deepEqual(
    listed.filter((path) => !path.includes("escape")),
    [
      ...Object.entries(fixtures)
        .filter(([kind]) => has(kind))
        .map(([, path]) => path),
      ...(has("pdf") ? ["docs/cjk.pdf"] : []),
    ].sort(),
  );

  // Path safety.
  const sampleKind = has("docx") ? "docx" : kinds[0];
  const sample = fixtures[sampleKind];
  assert.equal(
    await failCode("open_document", { path: `../outside.${sampleKind}` }),
    "path_outside_workspace",
  );
  if (has("pdf"))
    assert.equal(
      await failCode("open_document", { path: "linked/escape.pdf" }),
      "path_outside_workspace",
    );
  assert.equal(
    await failCode("open_document", { path: sample.replace(/[^/.]+\./, "missing.") }),
    "not_found",
  );
  assert.equal(await failCode("open_document", { path: "docs/generate.txt" }), "unsupported_type");
  for (const [kind, path] of Object.entries(fixtures))
    if (!has(kind))
      assert.equal(await failCode("open_document", { path }), "unsupported_type", path);

  // Open + reveal.
  let opened;
  if (has("docx")) {
    opened = await ok("open_document", { path: "docs/report.docx", at: "p:4" });
    assert.equal(opened.structuredContent.document.kind, "docx");
    assert.deepEqual(opened.structuredContent.reveal.targets, [{ at: "p:4" }]);
    assert.match(text(opened), /docs\/report\.docx#p:3 {2}Revenue/);
    assert.equal(
      await failCode("open_document", { path: "docs/report.docx", at: "slide:2" }),
      "invalid_anchor",
    );
  } else {
    opened = await ok("open_document", { path: sample });
    assert.equal(opened.structuredContent.document.kind, kinds[0]);
  }

  // Read and search each format.
  if (has("docx"))
    assert.match(
      text(await ok("read_document", { anchor: "docs/report.docx#t:1" })),
      /\| North \| 120 \|/,
    );
  if (has("xlsx"))
    assert.match(
      text(await ok("read_document", { anchor: "docs/budget.xlsx#Revenue!A1:E5" })),
      /E2: =SUM\(B2:D2\)/,
    );
  if (has("pptx")) {
    assert.match(
      text(await ok("read_document", { anchor: "docs/launch.pptx#slide:2" })),
      /Speaker notes/,
    );
    const hits = (await ok("search_document", { path: "docs/launch.pptx", query: "dana" }))
      .structuredContent.hits;
    assert.equal(hits.length, 1);
    assert.match(hits[0].anchor, /^docs\/launch\.pptx#slide:2\/shape:\d+$/);
  }
  if (has("pdf")) {
    assert.match(
      text(await ok("read_document", { anchor: "docs/paper.pdf#page:1" })),
      /缓存显著降低延迟/,
    );
    const hits = (await ok("search_document", { path: "docs/paper.pdf", query: "缓存" }))
      .structuredContent.hits;
    assert.ok(hits.length > 0);
    assert.match(hits[0].anchor, /^docs\/paper\.pdf#page:\d+$/);
    assert.equal(
      await failCode("read_document", { anchor: "docs/paper.pdf#page:9" }),
      "invalid_anchor",
    );
  }

  // show_in_viewer switches documents and normalises anchors.
  if (has("xlsx")) {
    const shown = await ok("show_in_viewer", {
      targets: [
        { anchor: "docs/budget.xlsx#revenue!e2:B2" },
        { anchor: "docs/budget.xlsx#Notes!B2", quote: "0.12" },
      ],
      note: "Totals",
    });
    assert.equal(shown.structuredContent.document.path, "docs/budget.xlsx");
    assert.deepEqual(shown.structuredContent.reveal.targets, [
      { at: "Revenue!B2:E2" },
      { at: "Notes!B2", quote: "0.12" },
    ]);
    assert.equal(shown.structuredContent.reveal.note, "Totals");
    assert.ok(shown.structuredContent.reveal.seq > (opened.structuredContent.reveal?.seq ?? 0));
  }
  if (has("pdf")) {
    const shown = await ok("show_in_viewer", {
      targets: [{ anchor: "docs/paper.pdf#page:1", quote: "缓存" }],
      note: "Here",
    });
    assert.equal(shown.structuredContent.document.path, "docs/paper.pdf");
    assert.deepEqual(shown.structuredContent.reveal.targets, [{ at: "page:1", quote: "缓存" }]);
    assert.ok(shown.structuredContent.reveal.seq > (opened.structuredContent.reveal?.seq ?? 0));
  }
  if (kinds.length > 1)
    assert.equal(
      await failCode("show_in_viewer", {
        targets: kinds.slice(0, 2).map((kind) => ({ anchor: fixtures[kind] })),
      }),
      "invalid_anchor",
    );

  // Panel loads bytes in chunks and reports the view.
  const loaded = (await ok("load_document", { path: sample })).structuredContent;
  assert.equal(loaded.file.chunks, 1);
  if (has("docx")) assert.equal(loaded.blocks[0].at, "p:1");
  const chunk = await client.readResource({ uri: ui(`file/${loaded.file.token}/0`) });
  assert.equal(Buffer.from(chunk.contents[0].blob, "base64").length, loaded.file.bytes);
  await assert.rejects(client.readResource({ uri: ui("file/nope/0") }));
  const selection = {
    docx: { at: "p:4", text: "Revenue grew by 12 percent" },
    xlsx: { at: "Revenue!B2", text: "100" },
    pptx: { at: "slide:2", text: "Owner: Dana" },
    pdf: { at: "page:1", text: "缓存显著降低延迟" },
  }[sampleKind];
  await ok("report_view", { viewId: "fixture", path: sample, at: selection.at, selection });
  const view = await ok("get_view");
  assert.ok(text(view).includes(`User selection: ${sample}#${selection.at}`), text(view));
  assert.ok(text(view).includes(selection.text));
  assert.equal(
    (await ok("get_viewer")).structuredContent.document.path,
    opened.structuredContent.document.path,
    "reports do not retarget the Agent surface",
  );
  assert.equal(
    (await ok("check_document", { path: sample })).structuredContent.revision,
    loaded.info.revision,
  );
  await ok("report_view", { viewId: "second", path: sample, at: selection.at });
  assert.equal((await ok("get_view")).structuredContent.ambiguous, true);
  assert.equal((await ok("get_view", { viewId: "fixture" })).structuredContent.view.path, sample);
  assert.equal(await failCode("get_view", { viewId: "missing" }), "invalid_token");
  await ok("release_view", { viewId: "second" });
  await ok("release_view", { viewId: "fixture" });
  await mkdir(join(workspace, `directory.${sampleKind}`));
  assert.equal(await failCode("open_document", { path: `directory.${sampleKind}` }), "not_found");
  await writeFile(join(workspace, `broken.${sampleKind}`), "synthetic damaged document");
  const broken = await call("open_document", { path: `broken.${sampleKind}` });
  assert.ok(broken.isError);
  assert.equal(broken.structuredContent.error.code, "corrupt_file");
  assert.ok(!text(broken).includes(workspace) && !text(broken).includes("synthetic damaged"));
  process.stdout.write(`${name} smoke (${kinds.join(", ")}): ok\n`);
} finally {
  await client.close();
  await Promise.all([workspace, outside].map((path) => rm(path, { recursive: true, force: true })));
}
