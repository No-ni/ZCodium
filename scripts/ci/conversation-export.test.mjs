import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { ConversationArchiveExports } = await tsImport(
  "../../packages/services/src/conversation-share/conversationArchiveExports.ts",
  import.meta.url,
);
const { saveConversationExport } = await tsImport(
  "../../packages/ui/src/lib/saveConversationExport.ts",
  import.meta.url,
);

test("exports are bounded, connection scoped, expire and clean up failed producers", async () => {
  let now = 0;
  const exports = new ConversationArchiveExports(() => now);
  const owner = Symbol(),
    other = Symbol();
  const bytes = Buffer.alloc(600_000, 42);
  const first = await exports.create(owner, "CON:/report. ", async () => bytes);
  assert.match(first.suggestedName, /^conversation-.+\.zcodium$/);
  assert.equal(first.byteLength, bytes.length);
  assert.throws(() => exports.read(other, first.archiveId, 0));
  assert.throws(() => exports.read(owner, first.archiveId, -1));
  assert.throws(() => exports.read(owner, first.archiveId, 0.1));
  const chunk = exports.read(owner, first.archiveId, 0);
  assert.equal(Buffer.from(chunk, "base64").length, 512 * 1024);
  exports.release(other, first.archiveId);
  assert.equal(exports.read(owner, first.archiveId, 0), chunk);
  const second = await exports.create(owner, "second", async () => Buffer.from("ok"));
  await assert.rejects(exports.create(owner, "third", async () => Buffer.from("no")));
  exports.release(owner, second.archiveId);
  await assert.rejects(
    exports.create(owner, "failed", async () => {
      throw new Error("test");
    }),
  );
  now = 600_001;
  assert.throws(() => exports.read(owner, first.archiveId, 0));
  const next = await exports.create(owner, "valid", async () => Buffer.from("retry"));
  exports.release(owner, next.archiveId);
  exports.release(owner, next.archiveId);
});

test("a producing export already occupies capacity", async () => {
  const exports = new ConversationArchiveExports();
  const owner = Symbol();
  let complete;
  const pending = exports.create(
    owner,
    "pending",
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const ready = await exports.create(owner, "ready", async () => Buffer.from("ready"));
  await assert.rejects(exports.create(owner, "overload", async () => Buffer.from("no")));
  complete(Buffer.from("done"));
  const finished = await pending;
  exports.release(owner, ready.archiveId);
  exports.release(owner, finished.archiveId);
});

test("saving collects chunks before platform save, cancellation and failure always release", async () => {
  for (const outcome of ["success", "cancel", "failure", "broken-chunk"]) {
    const exports = new ConversationArchiveExports();
    const owner = Symbol();
    const expected = Buffer.alloc(600_000, 77);
    const descriptor = await exports.create(owner, "title", async () => expected);
    let released = 0,
      saves = 0;
    const service = {
      readExportChunk: async (id, offset) =>
        outcome === "broken-chunk" ? "" : exports.read(owner, id, offset),
      releaseExport: async (id) => {
        released++;
        exports.release(owner, id);
      },
    };
    const platform = {
      saveFile: async ({ data, suggestedName }) => {
        saves++;
        assert.deepEqual(Buffer.from(data), expected);
        assert.equal(suggestedName, descriptor.suggestedName);
        if (outcome === "failure") throw new Error("private host path");
        return outcome === "cancel" ? { success: false, canceled: true } : { success: true };
      },
    };
    if (outcome === "failure" || outcome === "broken-chunk")
      await assert.rejects(saveConversationExport(service, platform, descriptor));
    else
      assert.equal(
        (await saveConversationExport(service, platform, descriptor)).canceled,
        outcome === "cancel" ? true : undefined,
      );
    assert.equal(released, 1);
    assert.equal(saves, outcome === "broken-chunk" ? 0 : 1);
    assert.throws(() => exports.read(owner, descriptor.archiveId, 0));
  }
});

test("real service exports selected turns and files offline with scoped handles", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  // 服务与 artifactSource 必须来自**同一次** tsImport：tsx 每次调用都新建独立模块图，跨图拿到的
  // `ConversationShareServiceError` 是两个类对象，服务里所有 `instanceof` 判定（发布侧候选降级、
  // 预检 missing）都会静默失效——happy path 照样绿，错误路径断言永远不会触发。
  // 共享夹具就是为钉住这条判据而存在，见 fixtures/conversation-share-service.mjs 头部注释。
  const {
    ConversationShareService,
    conversationShareConnectionScopeFactory,
    createLocalConversationShareArtifactSource,
    decodeConversationArchive,
  } = await import("./fixtures/conversation-share-service.mjs");
  const directory = await mkdtemp(join(tmpdir(), "zcodium-export-"));
  const originalFetch = globalThis.fetch;
  const forbidden = () => {
    throw new Error("Network or unscoped access forbidden");
  };
  globalThis.fetch = forbidden;
  let reads = 0;
  const base = {
    turnId: "private-turn",
    productTurnId: "private-product",
    createdAt: 1,
    createdAtSeq: 1,
  };
  const rows = [
    {
      ...base,
      rowId: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
    },
    {
      ...base,
      rowId: 2,
      kind: "userInput",
      origin: "realUser",
      text: "Keep selected text",
      clientId: "PRIVATE identity",
    },
    { ...base, rowId: 3, kind: "assistantText", state: "complete", text: "[Report](report.pdf)" },
    {
      ...base,
      rowId: 4,
      turnId: "excluded-turn",
      productTurnId: "excluded-product",
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
    },
    {
      ...base,
      rowId: 5,
      turnId: "excluded-turn",
      productTurnId: "excluded-product",
      kind: "userInput",
      origin: "realUser",
      text: "EXCLUDED conversation",
    },
  ];
  try {
    const file = Buffer.from("selected binary attachment\0\xff");
    await writeFile(join(directory, "report.pdf"), file);
    const host = new ConversationShareService({
      zcodeAgentService: { conversationRowsRangeV4: forbidden },
      artifactSource: createLocalConversationShareArtifactSource(),
      conversationWorkspaceRoot: directory,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const agent = {
      conversationRowsRangeV4: async (input) => {
        assert.equal(input.workspaceIdentity, "TEST identity");
        reads++;
        return { rows, hasMore: false, atRevision: 1, atLogEpoch: "epoch" };
      },
    };
    const service = host[conversationShareConnectionScopeFactory](agent);
    const other = host[conversationShareConnectionScopeFactory](agent);
    const input = {
      workspacePath: directory,
      workspaceIdentity: "TEST identity",
      sessionId: "session",
      title: "Report",
      clientRequestId: "request",
      selection: { kind: "productTurns", productTurnIds: ["private-product"] },
    };
    const preflight = await service.preflight(input);
    assert.deepEqual(preflight.blockingIssues, []);
    const archive = await service.publish(input, "operation");
    await assert.rejects(other.readExportChunk(archive.archiveId, 0));
    await assert.rejects(host.readExportChunk(archive.archiveId, 0));
    const parts = [];
    for (let offset = 0; offset < archive.byteLength; ) {
      const part = Buffer.from(await service.readExportChunk(archive.archiveId, offset), "base64");
      parts.push(part);
      offset += part.length;
    }
    const decoded = await decodeConversationArchive(Buffer.concat(parts));
    assert.doesNotMatch(
      JSON.stringify(decoded.content),
      /PRIVATE|EXCLUDED|private-turn|TEST identity/,
    );
    assert.equal(decoded.artifacts.size, 1);
    assert.deepEqual([...decoded.artifacts.values()][0], file);
    assert.ok(reads >= 2);
    await service.releaseExport(archive.archiveId);
    await assert.rejects(service.readExportChunk(archive.archiveId, 0));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("publishing resolves relative body references from the session execution directory", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  // 服务与 artifactSource 必须来自**同一次** tsImport：tsx 每次调用都新建独立模块图，跨图拿到的
  // `ConversationShareServiceError` 是两个类对象，服务里所有 `instanceof` 判定（发布侧候选降级、
  // 预检 missing）都会静默失效——happy path 照样绿，错误路径断言永远不会触发。
  // 共享夹具就是为钉住这条判据而存在，见 fixtures/conversation-share-service.mjs 头部注释。
  const {
    ConversationShareService,
    conversationShareConnectionScopeFactory,
    createLocalConversationShareArtifactSource,
    decodeConversationArchive,
  } = await import("./fixtures/conversation-share-service.mjs");
  const directory = await mkdtemp(join(tmpdir(), "zcodium-export-root-"));
  const sessionDirectory = join(directory, "2026-10-11", "a1b2c3d4");
  const base = {
    turnId: "private-turn",
    productTurnId: "private-product",
    createdAt: 1,
    createdAtSeq: 1,
  };
  const rows = [
    {
      ...base,
      rowId: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
    },
    { ...base, rowId: 2, kind: "userInput", origin: "realUser", text: "Share the report" },
    // 模型写相对路径时的基准是会话执行 cwd，不是工作区身份根。
    {
      ...base,
      rowId: 3,
      kind: "assistantText",
      state: "complete",
      text: "见 [报告](docs/report.pdf)",
    },
  ];
  const readRows = async () => ({ rows, hasMore: false, atRevision: 1, atLogEpoch: "epoch" });
  const collectArchive = async (service, archive) => {
    const parts = [];
    for (let offset = 0; offset < archive.byteLength; ) {
      const part = Buffer.from(await service.readExportChunk(archive.archiveId, offset), "base64");
      parts.push(part);
      offset += part.length;
    }
    return decodeConversationArchive(Buffer.concat(parts));
  };
  try {
    await mkdir(join(sessionDirectory, "docs"), { recursive: true });
    // 同一段正文里的同一个相对引用，在两处各放一份不同内容的同名文件：
    // 物化出来的是哪一份，就唯一地证明了引用按哪个根解析。
    const workspaceFile = Buffer.from("workspace root copy\0\xff");
    const sessionFile = Buffer.from("session directory copy\0\xff");
    await mkdir(join(directory, "docs"), { recursive: true });
    await writeFile(join(directory, "docs", "report.pdf"), workspaceFile);
    await writeFile(join(sessionDirectory, "docs", "report.pdf"), sessionFile);
    const host = new ConversationShareService({
      zcodeAgentService: { conversationRowsRangeV4: readRows },
      artifactSource: createLocalConversationShareArtifactSource(),
      conversationWorkspaceRoot: directory,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const service = host[conversationShareConnectionScopeFactory]({
      conversationRowsRangeV4: readRows,
    });
    const input = {
      workspacePath: directory,
      sessionId: "session",
      title: "Report",
      selection: { kind: "productTurns", productTurnIds: ["private-product"] },
    };
    // 缺省 = 旧行为：相对引用按工作区身份根解析。
    const legacy = await service.publish(
      { ...input, clientRequestId: "legacy", selection: input.selection },
      "legacy",
    );
    const legacyDecoded = await collectArchive(service, legacy);
    assert.equal(legacyDecoded.artifacts.size, 1);
    assert.deepEqual([...legacyDecoded.artifacts.values()][0], workspaceFile);
    await service.releaseExport(legacy.archiveId);
    // 显式传会话执行目录：同一个相对引用被解析到会话目录下的文件并物化进归档。
    const archive = await service.publish(
      {
        ...input,
        clientRequestId: "session-root",
        selection: input.selection,
        fileReferenceRootPath: sessionDirectory,
      },
      "session-root",
    );
    const decoded = await collectArchive(service, archive);
    assert.equal(decoded.artifacts.size, 1);
    assert.deepEqual([...decoded.artifacts.values()][0], sessionFile);
    const artifactRows = decoded.content.rows.filter((row) => row.kind === "artifact");
    assert.equal(artifactRows.length, 1);
    // 归档里的 artifact row 只带公开投影后的描述符（run 的 ref 会被重写成 zcode-artifact://），
    // 因此「按哪个根解析」由上面的字节断言唯一地证明。
    assert.equal(artifactRows[0].displayName, "report.pdf");
    await service.releaseExport(archive.archiveId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native data save atomically replaces files and leaves no staging directory", async () => {
  const { mkdtemp, writeFile, readFile, mkdir, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeSavedFile } = await tsImport(
    "../../packages/desktop/src/main/writeSavedFile.ts",
    import.meta.url,
  );
  const directory = await mkdtemp(join(tmpdir(), "zcodium-save-"));
  try {
    const target = join(directory, "report.zcodium");
    await writeFile(target, "previous");
    const bytes = Buffer.alloc(51 * 1024 * 1024, 37);
    await writeSavedFile(target, bytes);
    assert.deepEqual(await readFile(target), bytes);
    assert.deepEqual(await readdir(directory), ["report.zcodium"]);
    const blocked = join(directory, "blocked");
    await mkdir(blocked);
    await writeFile(join(blocked, "keep"), "old data");
    await assert.rejects(writeSavedFile(blocked, Buffer.from("new")));
    assert.equal(await readFile(join(blocked, "keep"), "utf8"), "old data");
    assert.deepEqual((await readdir(directory)).sort(), ["blocked", "report.zcodium"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
