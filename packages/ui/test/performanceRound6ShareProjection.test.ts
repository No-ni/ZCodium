import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactRowSchema,
  assistantTextRowSchema,
  hookInvocationRowSchema,
  subagentRowSchema,
  turnHeaderRowSchema,
  type ArtifactRow,
  type ConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationSharePublicProjection as project,
  type ConversationSharePublicArtifact,
} from "../../services/src/conversation-share/conversationSharePublicProjection.js";
import { ConversationShareServiceError } from "../../services/src/conversation-share/conversationShare.js";

const base = (rowId: number, turn = "a") => ({
  rowId,
  turnId: `turn-${turn}`,
  productTurnId: `product-${turn}`,
  createdAt: rowId,
  createdAtSeq: rowId,
});
const header = (rowId = 1, turn = "a") =>
  turnHeaderRowSchema.parse({
    ...base(rowId, turn),
    kind: "turnHeader",
    origin: "userInput",
    startedAt: 1,
    state: "completedSuccess",
  });
const artifact = (rowId: number, turn = "a", id = `id-${rowId}`): ArtifactRow =>
  artifactRowSchema.parse({
    ...base(rowId, turn),
    kind: "artifact",
    artifactVersionId: id,
    logicalArtifactKey: `key-${id}`,
    displayName: `output-${rowId}.txt`,
    artifactType: "text",
    mimeType: "text/plain",
    sizeBytes: rowId,
    sha256: "a".repeat(64),
    ref: `zcode-artifact://session/${id}`,
    state: "current",
  });
const text = (rowId: number, turn = "a") =>
  assistantTextRowSchema.parse({
    ...base(rowId, turn),
    kind: "assistantText",
    text: `answer ${rowId}`,
    state: "complete",
  });
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function assertManifest(
  rows: ConversationRow[],
  selected = ["product-a"],
  additionalArtifacts?: ConversationSharePublicArtifact[],
) {
  freeze(rows);
  const output = project({ rows, selectedProductTurnIds: selected, additionalArtifacts });
  const source = rows.filter((row): row is ArtifactRow => row.kind === "artifact");
  const projected = output.rows.filter((row): row is ArtifactRow => row.kind === "artifact");
  expect(projected).toHaveLength(source.length);
  source.forEach((row, i) => {
    const result = projected[i]!;
    expect(result.artifactVersionId).toBe(`share-artifact-${i + 1}`);
    expect(output.artifacts[i]).toEqual({
      sourceRef: row.ref,
      descriptor: {
        artifact_id: result.artifactVersionId,
        logical_artifact_key: result.logicalArtifactKey,
        producer_product_turn_id: result.productTurnId,
        artifact_version: 1,
        state: row.state,
        ref: result.ref,
        artifact_type: row.artifactType,
        display_name: row.displayName,
        extension: "txt",
        mime_type: row.mimeType,
        size_bytes: row.sizeBytes,
        sha256: row.sha256,
      },
    });
  });
  expect(output.rows.map((row) => row.rowId)).toEqual(output.rows.map((_, i) => i + 1));
  return output;
}

afterEach(() => vi.restoreAllMocks());

describe("public share artifact manifest work", () => {
  it("does not rescan a long row window for each artifact", () => {
    const rows = [
      header(),
      ...Array.from({ length: 1000 }, (_, i) => text(i + 2)),
      ...Array.from({ length: 32 }, (_, i) => artifact(i + 1002)),
    ];
    const find = Array.prototype.find;
    let visits = 0;
    vi.spyOn(Array.prototype, "find").mockImplementation(
      function (this: unknown[], predicate, thisArg) {
        const isRows = (this[0] as ConversationRow | undefined)?.kind === "turnHeader";
        return find.call(this, (value, index, array) => {
          if (isRows) visits += 1;
          return predicate.call(thisArg, value, index, array);
        });
      },
    );
    assertManifest(rows);
    expect(visits).toBeLessThanOrEqual(rows.length * 2);
  });

  it("preserves interleaved product order and strips subagent details", () => {
    const rows: ConversationRow[] = [
      header(),
      artifact(2, "a", "z"),
      text(3),
      subagentRowSchema.parse({
        ...base(4),
        kind: "subagent",
        childSessionId: "child",
        status: "success",
        subagentType: "test",
        summaryText: "done",
      }),
      hookInvocationRowSchema.parse({
        ...base(4.5),
        kind: "hookInvocation",
        hookInvocationId: "hook",
        hookEventName: "Stop",
        hookCount: 1,
        state: "completed",
        startedAt: 4,
        lane: "assistantWork",
        executions: [],
      }),
      header(5, "b"),
      artifact(6, "b", "a"),
      text(7, "b"),
      artifact(8, "b", "m"),
    ];
    const output = assertManifest(rows, ["product-b", "product-a"]);
    expect(output.selectedProductTurnIds).toEqual(["share-product-turn-1", "share-product-turn-2"]);
    expect(
      output.artifacts.map((item) => [item.sourceRef, item.descriptor.producer_product_turn_id]),
    ).toEqual([
      ["zcode-artifact://session/z", "share-product-turn-2"],
      ["zcode-artifact://session/a", "share-product-turn-1"],
      ["zcode-artifact://session/m", "share-product-turn-1"],
    ]);
    expect(output.rows.some((row) => row.kind === "subagent")).toBe(false);
    expect(output.rows.some((row) => row.kind === "hookInvocation")).toBe(false);
    expect(JSON.stringify(output)).toMatchSnapshot();
  });

  it("appends additional attachment manifests and keeps producer remapping", () => {
    const additional: ConversationSharePublicArtifact = freeze({
      sourceRef: "attachment:synthetic",
      descriptor: {
        artifact_id: "attachment-1",
        logical_artifact_key: "attachment-key-1",
        producer_product_turn_id: "product-a",
        artifact_version: 1,
        state: "current",
        ref: "zcode-artifact://share/attachment-1",
        artifact_type: "text",
        display_name: "input.txt",
        extension: "txt",
        mime_type: "text/plain",
        size_bytes: 0,
        sha256: "b".repeat(64),
      },
    });
    const output = assertManifest([header(), artifact(2)], undefined, [additional]);
    expect(output.artifacts[1]).toEqual({
      ...additional,
      descriptor: {
        ...additional.descriptor,
        producer_product_turn_id: "share-product-turn-1",
      },
    });
    expect(assertManifest([header(), text(2)]).artifacts).toEqual([]);
    expect(() =>
      assertManifest([header()], undefined, [
        {
          ...additional,
          descriptor: {
            ...additional.descriptor,
            producer_product_turn_id: "unselected",
          },
        },
      ]),
    ).toThrow(ConversationShareServiceError);
    expect(() =>
      assertManifest([header(), artifact(2)], undefined, [
        {
          ...additional,
          descriptor: {
            ...additional.descriptor,
            artifact_id: "share-artifact-1",
          },
        },
      ]),
    ).toThrow(/identities must be unique/);
  });

  it("retains original rejection boundaries", () => {
    const a = artifact(2);
    for (const rows of [
      [header(), a, { ...artifact(3), artifactVersionId: a.artifactVersionId }],
      [header(), a, { ...artifact(3), logicalArtifactKey: a.logicalArtifactKey }],
      [header(), { ...a, displayName: "no-extension" }],
      [{ ...header(), state: "running" }, a],
      [header(), artifact(2, "other")],
    ] as ConversationRow[][]) {
      freeze(rows);
      expect(() => project({ rows, selectedProductTurnIds: ["product-a"] })).toThrow(
        ConversationShareServiceError,
      );
    }
  });
});
