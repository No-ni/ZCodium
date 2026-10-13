import { tsImport } from "tsx/esm/api";

/**
 * conversation-share 集成测试的共享装载与夹具。
 *
 * **装载判据（必须保持）**：`ConversationShareService` 与本地 `artifactSource` 必须来自**同一次**
 * `tsImport`。tsx 每次调用都会新建独立模块图，跨图拿到的 `ConversationShareServiceError` 是两个
 * 不同的类对象，服务内所有 `error instanceof ConversationShareServiceError` 判定（发布侧的
 * artifact 降级、预检的 missing 判定）都会静默失效——测试会停在「整次发布失败」而不是
 * 「跳过该候选」，或反过来把一个永远不会触发的分支当成已覆盖。
 * `packages/services/src/node.ts`（即 `@zcode/services/node`）这一个 barrel 同时导出
 * `ConversationShareService` 与 `createLocalConversationShareArtifactSource`（生产装配在同一个
 * 文件里用的也是这个组合），单次 tsImport 即保证两边的类对象同一。
 */
export const {
  ConversationShareService,
  conversationShareConnectionScopeFactory,
  createLocalConversationShareArtifactSource,
  decodeConversationArchive,
} = await tsImport("../../../packages/services/src/node.ts", import.meta.url);

// UI 的错误→文案映射：它只读错误对象上的 name/kind/reasonCode/details（不依赖 instanceof），
// 因此可以直接吃上面同一个服务图抛出的错误，验证用户最终看到的是哪条文案。
export const { resolveConversationSharePublishErrorMessageId } = await tsImport(
  "../../../packages/ui/src/lib/conversationShareError.ts",
  import.meta.url,
);

/** 单轮会话的最小合法行集：turnHeader + userInput + assistantText（正文由调用方给）。 */
export function buildShareTurnRows({ text }) {
  const base = {
    turnId: "private-turn",
    productTurnId: "private-product",
    createdAt: 1,
    createdAtSeq: 1,
  };
  return [
    {
      ...base,
      rowId: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
    },
    { ...base, rowId: 2, kind: "userInput", origin: "realUser", text: "Share the reports" },
    { ...base, rowId: 3, kind: "assistantText", state: "complete", text },
  ];
}

/**
 * 建一个真实 `ConversationShareService`（会话级作用域），并给出与它配套的 `input`。
 * `rows` 通过 `readRows` 闭包注入，避免每个用例重复写 agent 服务桩。
 */
export function createShareService({ conversationWorkspaceRoot, rows, artifactSource }) {
  const readRows = async () => ({ rows, hasMore: false, atRevision: 1, atLogEpoch: "epoch" });
  const host = new ConversationShareService({
    zcodeAgentService: { conversationRowsRangeV4: readRows },
    artifactSource: artifactSource ?? createLocalConversationShareArtifactSource(),
    conversationWorkspaceRoot,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  return host[conversationShareConnectionScopeFactory]({ conversationRowsRangeV4: readRows });
}

/** 逐块取回导出文件并解码，返回归档里每个 artifact 的 UTF-8 文本（顺序即归档内的顺序）。 */
export async function readArchiveArtifactTexts(service, archive) {
  const parts = [];
  for (let offset = 0; offset < archive.byteLength; ) {
    const part = Buffer.from(await service.readExportChunk(archive.archiveId, offset), "base64");
    parts.push(part);
    offset += part.length;
  }
  const decoded = await decodeConversationArchive(Buffer.concat(parts));
  return [...decoded.artifacts.values()].map((bytes) => Buffer.from(bytes).toString());
}
