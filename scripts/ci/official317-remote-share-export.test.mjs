import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { buildServerRemoteWorkspaceIdentity } from "../../packages/shared/src/index.ts";

// 同一模块图保证 facade 与 artifactSource 的错误类型一致。
const {
  ConversationShareService,
  scopeConversationShareServiceForAttachment,
  createRemoteConversationShareArtifactSource,
  decodeConversationArchive,
} = await tsImport("../../packages/services/src/node.ts", import.meta.url);
const workspacePath = "/synthetic/remote-project";
const workspaceIdentity = buildServerRemoteWorkspaceIdentity({
  serverId: "fixture-source",
  workspacePath,
});
const file = Buffer.from("<html>E2E_SSH_SHARE_ARTIFACT_CONTENT</html>\0");
const connection = { connectionId: "fixture-attachment", clientMode: "desktop-continuous" };

test("trusted remote Rows/File attachment exports exact bytes to a local ZIP without network upload", async () => {
  const calls = [];
  const forbidden = () => {
    throw new Error("UNEXPECTED_NETWORK_OR_LOCAL_FALLBACK");
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = forbidden;
  const assertScope = (input) => {
    assert.equal(input.workspacePath, workspacePath);
    assert.equal(input.workspaceIdentity, workspaceIdentity);
    assert.equal(input.remoteSessionId, "fixture-remote-session");
    assert.deepEqual(input.__zcodeTrustedV4Connection, connection);
  };
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
      entityId: "fixture-turn",
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
      text: "Export the prepared report",
    },
    { ...base, rowId: 3, kind: "assistantText", state: "complete", text: "[Report](report.html)" },
  ];
  const source = createRemoteConversationShareArtifactSource({
    async resolvePath({ path }) {
      calls.push("resolve");
      return path;
    },
    async stat({ path }) {
      assert.equal(path, `${workspacePath}/report.html`);
      calls.push("stat");
      return { type: "file", size: file.length, mtimeMs: 1 };
    },
    async readFileRange({ path, offset, length }) {
      assert.equal(path, `${workspacePath}/report.html`);
      calls.push("read");
      return file.subarray(offset, offset + length);
    },
  });
  const host = new ConversationShareService({
    zcodeAgentService: { conversationRowsRangeV4: forbidden },
    artifactSource: source,
    logger: { info() {}, debug() {}, warn() {}, error() {} },
  });
  const agent = {
    async conversationRowsRangeV4(input) {
      assertScope(input);
      calls.push("rows");
      return { rows, hasMore: false, atRevision: 1, atLogEpoch: "fixture-epoch" };
    },
    async conversationFileChangesV4(input) {
      assertScope(input);
      calls.push("changes");
      return { state: "active", items: [{ path: "report.html" }] };
    },
  };
  const service = scopeConversationShareServiceForAttachment(
    host,
    "desktop-continuous",
    agent,
    connection,
  );
  const other = scopeConversationShareServiceForAttachment(
    host,
    "desktop-continuous",
    agent,
    connection,
  );
  const input = {
    workspacePath,
    workspaceIdentity,
    remoteSessionId: "fixture-remote-session",
    sessionId: "fixture-session",
    title: "Remote report",
    selection: { kind: "productTurns", productTurnIds: [base.productTurnId] },
    clientRequestId: "fixture-export",
    clientMode: "web-remote-replayable",
    __zcodeTrustedV4Connection: { connectionId: "forged", clientMode: "web-remote-replayable" },
  };
  let archive;
  try {
    assert.deepEqual((await service.preflight(input)).blockingIssues, []);
    archive = await service.publish(input, "fixture-operation");
    await assert.rejects(other.readExportChunk(archive.archiveId, 0));
    const chunks = [];
    for (let offset = 0; offset < archive.byteLength; ) {
      const chunk = Buffer.from(await service.readExportChunk(archive.archiveId, offset), "base64");
      assert.ok(chunk.length > 0);
      chunks.push(chunk);
      offset += chunk.length;
    }
    const zip = Buffer.concat(chunks);
    assert.equal(zip.subarray(0, 2).toString(), "PK");
    const decoded = await decodeConversationArchive(zip);
    assert.equal(decoded.artifacts.size, 1);
    assert.deepEqual([...decoded.artifacts.values()][0], file);
    assert.ok(calls.includes("rows") && calls.includes("changes") && calls.includes("read"));
    assert.doesNotMatch(
      JSON.stringify(decoded.content),
      /fixture-attachment|fixture-remote-session|private-turn/,
    );
  } finally {
    if (archive) await service.releaseExport(archive.archiveId);
    globalThis.fetch = originalFetch;
  }
});

test("remote file resolution rejects a path escaping the workspace before byte reads", async () => {
  let reads = 0;
  const source = createRemoteConversationShareArtifactSource({
    async resolvePath({ path }) {
      return path === workspacePath ? path : "/synthetic/outside/report.html";
    },
    async stat() {
      throw new Error("UNEXPECTED_STAT");
    },
    async readFileRange() {
      reads++;
      return file;
    },
  });
  await assert.rejects(
    source.read({ workspacePath, ref: "report.html", maxBytes: 1000 }),
    /outside the workspace/,
  );
  assert.equal(reads, 0);
});
