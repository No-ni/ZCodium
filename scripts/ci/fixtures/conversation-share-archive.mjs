import { createHash } from "node:crypto";
import { tsImport } from "tsx/esm/api";

const { buildConversationSharePublicProjection } = await tsImport(
  "../../../packages/services/src/conversation-share/conversationSharePublicProjection.ts",
  import.meta.url,
);

/** 测试夹具里的 sha256（内容全是虚构数据）。 */
export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/**
 * 一份最小的公开分享归档内容：1 个 userInput + 1 个 artifact row。
 * 走真实 `buildConversationSharePublicProjection`，与 Host 发布侧同源，
 * 因此导入测试不必手写 row↔descriptor 的一致性字段。
 */
export function conversationShareArchiveFixture() {
  const bytes = Buffer.from("offline attachment\0");
  const base = {
    turnId: "share-turn-1",
    productTurnId: "share-product-turn-1",
    createdAt: 1,
    createdAtSeq: 1,
  };
  const projection = buildConversationSharePublicProjection({
    rows: [
      {
        ...base,
        rowId: 1,
        kind: "turnHeader",
        state: "completedSuccess",
        origin: "userInput",
        startedAt: 1,
      },
      { ...base, rowId: 2, kind: "userInput", origin: "realUser", text: "Imported question" },
      {
        ...base,
        rowId: 3,
        kind: "artifact",
        artifactVersionId: "original",
        logicalArtifactKey: "key",
        displayName: "CON.txt",
        artifactType: "text",
        mimeType: "text/plain",
        sizeBytes: bytes.length,
        sha256: sha256Hex(bytes),
        ref: "zcode-artifact://session/result",
        state: "current",
      },
    ],
    selectedProductTurnIds: [base.productTurnId],
  });
  const descriptors = projection.artifacts.map((item) => item.descriptor);
  return {
    content: {
      format: "zcodium-conversation",
      version: 1,
      title: "Offline note",
      selectedProductTurnIds: projection.selectedProductTurnIds,
      rows: projection.rows,
      artifacts: descriptors,
    },
    artifacts: new Map(descriptors.map((item) => [item.artifact_id, bytes])),
  };
}
