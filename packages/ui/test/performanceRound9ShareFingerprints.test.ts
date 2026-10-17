import { describe, expect, it } from "vitest";
import {
  artifactRowSchema,
  assistantTextRowSchema,
  toolCallRowSchema,
  turnHeaderRowSchema,
  userInputRowSchema,
  type ConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import { conversationShareTurnFingerprints } from "@/v4/conversationSharePreflightCache.js";

const base = (rowId: number, productTurnId?: string) => ({
  rowId,
  turnId: `turn-${productTurnId ?? "legacy"}`,
  productTurnId,
  createdAt: rowId,
  createdAtSeq: rowId,
});
const text = (rowId: number, productTurnId?: string, value = `Answer ${rowId}`) =>
  assistantTextRowSchema.parse({
    ...base(rowId, productTurnId),
    kind: "assistantText",
    state: "complete",
    text: value,
  });

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

describe("share preflight batch fingerprints", () => {
  it("reads each row turn ID only once for a multiple-turn selection", () => {
    const turns = Array.from({ length: 64 }, (_, i) => `product-${i}`);
    let reads = 0;
    const rows = turns.flatMap((productTurnId, turnIndex) =>
      Array.from({ length: 16 }, (_, index) => {
        const row = text(turnIndex * 16 + index, productTurnId);
        Object.defineProperty(row, "productTurnId", {
          get() {
            reads += 1;
            return productTurnId;
          },
        });
        return Object.freeze(row);
      }),
    );
    const fingerprints = conversationShareTurnFingerprints(Object.freeze(rows), turns, "/work");
    expect(fingerprints.size).toBe(64);
    expect(reads).toBeLessThanOrEqual(rows.length);
  });

  it("keeps original fingerprint bytes, scope, row order and empty-turn behavior", () => {
    const rows = freeze([
      turnHeaderRowSchema.parse({
        ...base(1, "a"),
        kind: "turnHeader",
        origin: "userInput",
        state: "completedSuccess",
        startedAt: 1,
        fileChanges: { additions: 1, deletions: 2, files: 3 },
      }),
      text(2, "b", "[Report](reports/result.pdf)"),
      userInputRowSchema.parse({
        ...base(3, "a"),
        kind: "userInput",
        origin: "realUser",
        text: "Produce a report",
        attachments: [
          { ref: "attachment:a", fileName: "input.pdf", mime: "application/pdf", bytes: 42 },
        ],
      }),
      text(4, "a", "[Report](result.pdf)"),
      text(5),
      text(6, "b", "Follow-up"),
      text(7, "a", '::zcode-file-citation{path="docs/result.pdf"}'),
    ] satisfies ConversationRow[]);
    const contexts = [
      {},
      {
        workspaceKey: "identity",
        remoteSessionId: "remote",
        sessionId: "session",
        revision: 12,
        logEpoch: "epoch",
        capabilitiesFingerprint: "caps",
      },
      { workspaceKey: "", productTurnId: "override", revision: 0 },
    ];
    const outputs = [];
    for (const root of ["/work", "C:\\work", ""]) {
      for (const context of contexts) {
        for (const ids of [["a", "b"], ["b", "a", "a", "missing", ""], []]) {
          const actual = conversationShareTurnFingerprints(rows, Object.freeze(ids), root, context);
          outputs.push([...actual]);
        }
      }
    }
    // 已在审计中与 HEAD 原始单轮算法独立核对；固定字节避免提交后依赖被删除的旧入口。
    expect(outputs).toMatchSnapshot();
  });

  it("does not inspect rows without a selection and rebuilds for replacement inputs", () => {
    const unreadable = new Proxy([] as ConversationRow[], {
      get() {
        throw new Error("rows should not be read");
      },
    });
    expect(conversationShareTurnFingerprints(unreadable, [])).toEqual(new Map());
    const oldRows = freeze([text(1, "a", "Old"), text(2, "ignored")]);
    const newRows = freeze([text(1, "a", "New"), text(2, "ignored")]);
    const oldResult = conversationShareTurnFingerprints(oldRows, ["a"]);
    const newResult = conversationShareTurnFingerprints(newRows, ["a"]);
    expect(oldResult.get("a")).not.toBe(newResult.get("a"));
    expect([oldResult.get("a"), newResult.get("a")]).toMatchInlineSnapshot(`
      [
        "c66d7cdd",
        "a440a23c",
      ]
    `);
  });

  it("keeps artifact state, tool status and duplicate row signatures", () => {
    const artifact = artifactRowSchema.parse({
      ...base(1, "a"),
      kind: "artifact",
      artifactVersionId: "artifact-a",
      logicalArtifactKey: "logical-a",
      displayName: "result.pdf",
      artifactType: "pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      sha256: "a".repeat(64),
      ref: "zcode-artifact://session/result",
      state: "current",
    });
    const tool = toolCallRowSchema.parse({
      ...base(2, "b"),
      kind: "toolCall",
      toolCallId: "tool-b",
      toolName: "Bash",
      status: "running",
      inputText: "command",
    });
    const rows = freeze([artifact, tool, text(3, "a"), artifact]);
    const result = conversationShareTurnFingerprints(rows, ["b", "a"]);
    expect([...result]).toMatchInlineSnapshot(`
      [
        [
          "b",
          "3982e675",
        ],
        [
          "a",
          "0de7326f",
        ],
      ]
    `);
    const changed = conversationShareTurnFingerprints(
      freeze([artifact, { ...tool, status: "success" }, rows[2]!, artifact]),
      ["b", "a"],
    );
    expect(changed.get("b")).not.toBe(result.get("b"));
    expect(changed.get("a")).toBe(result.get("a"));
    expect(conversationShareTurnFingerprints(rows.slice(0, -1), ["a"]).get("a")).not.toBe(
      result.get("a"),
    );
  });
});
