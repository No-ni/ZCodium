import { describe, expect, it } from "vitest";
import {
  conversationRowSchema,
  type AssistantTextRow,
  type ConversationRow,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  deriveLogicalUiInstances,
  type PluginUiInstanceDerivation,
} from "@/plugin-ui/domain/pluginUiInstancePolicy.js";

function textRow(id: number, turnId = `round10:turn-${id}`): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId: id,
    turnId,
    createdAt: id,
    createdAtSeq: id,
    text: `Answer ${id}`,
    state: "complete",
  };
}

type Ui = NonNullable<Extract<NonNullable<ToolCallRow["display"]>, { kind: "mcp_tool" }>["ui"]>;

function toolRow(
  id: number,
  options: {
    turnId?: string;
    toolCallId?: string;
    status?: ToolCallRow["status"];
    serverName?: string;
    ui?: Partial<Ui>;
  } = {},
): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: id,
    turnId: options.turnId ?? "round10:turn",
    createdAt: id,
    createdAtSeq: id,
    toolCallId: options.toolCallId ?? `round10:call-${id}`,
    toolName: "mcp__fixture__edit",
    status: options.status ?? "success",
    inputText: "{}",
    ...(options.status === "error" ? { error: { code: "fixture", message: "fixture" } } : {}),
    display: {
      kind: "mcp_tool",
      serverName: options.serverName ?? "fixture",
      toolName: "edit",
      ui: { pluginId: "fixture", resourceUri: "ui://fixture", surface: "panel", ...options.ui },
    },
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Count actual element reads performed by native includes, only for this fixture's IDs. */
function countMembershipReads(derive: () => PluginUiInstanceDerivation) {
  const original = Array.prototype.includes;
  let reads = 0;
  Array.prototype.includes = function (
    this: unknown[],
    searchElement: unknown,
    fromIndex?: number,
  ): boolean {
    if (typeof searchElement !== "string" || !searchElement.startsWith("round10:")) {
      return original.call(this, searchElement, fromIndex);
    }
    const counted = new Proxy(this, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    return original.call(counted, searchElement, fromIndex);
  };
  try {
    return { result: derive(), reads: () => reads };
  } finally {
    Array.prototype.includes = original;
  }
}

describe("plugin UI instance derivation work", () => {
  it("does not repeatedly scan prior turns in a long conversation without plugin cards", () => {
    const rows = Array.from({ length: 2_000 }, (_, index) => textRow(index));
    const measured = countMembershipReads(() => deriveLogicalUiInstances(rows));
    expect(measured.result).toEqual({ instances: [], byToolCallId: {} });
    expect(measured.reads()).toBeLessThanOrEqual(rows.length * 6);
  });

  it("does not rescan all superseded calls for every revision of the same surface", () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => toolRow(index));
    const measured = countMembershipReads(() => deriveLogicalUiInstances(rows));
    expect(measured.result.instances).toHaveLength(1);
    expect(measured.result.instances[0]?.activeToolCallId).toBe("round10:call-999");
    expect(measured.result.instances[0]?.supersededToolCallIds).toEqual(
      rows.slice(0, -1).map((row) => row.toolCallId),
    );
    expect(measured.result.byToolCallId["round10:call-0"]?.superseded).toBe(true);
    expect(measured.result.byToolCallId["round10:call-999"]?.superseded).toBe(false);
    expect(measured.reads()).toBeLessThanOrEqual(rows.length * 6);
  });

  it("keeps membership work bounded when all plugin turns are configured to auto-expand", () => {
    const rows = Array.from({ length: 1_000 }, (_, index) =>
      toolRow(index, { turnId: `round10:turn-${index}`, ui: { surface: undefined } }),
    );
    const measured = countMembershipReads(() =>
      deriveLogicalUiInstances(rows, { autoExpandTurns: Infinity }),
    );
    expect(measured.result.instances).toHaveLength(rows.length);
    expect(Object.values(measured.result.byToolCallId).every((row) => row.autoExpand)).toBe(true);
    expect(measured.reads()).toBeLessThanOrEqual(rows.length * 6);
  });
});

describe("plugin UI instance derivation compatibility", () => {
  it("preserves an own __proto__ call disposition without changing the output prototype", () => {
    const rows = freeze([
      toolRow(1, { toolCallId: "__proto__" }),
      toolRow(2, { toolCallId: "__proto__", ui: { showInline: true } }),
      toolRow(3),
    ]);
    for (const row of rows) expect(conversationRowSchema.safeParse(row).success).toBe(true);
    const result = deriveLogicalUiInstances(rows);
    expect(Object.getPrototypeOf(result.byToolCallId)).toBe(Object.prototype);
    expect(Object.hasOwn(result.byToolCallId, "__proto__")).toBe(true);
    expect(Object.keys(result.byToolCallId)).toEqual(["__proto__", "round10:call-3"]);
    expect(Object.getOwnPropertyDescriptor(result.byToolCallId, "__proto__")).toEqual({
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        key: result.instances[0]!.key,
        superseded: true,
        autoExpand: true,
        forcedInline: true,
      },
    });
    expect(
      deriveLogicalUiInstances([toolRow(4, { toolCallId: "__proto__" })]).byToolCallId["__proto__"],
    ).toMatchObject({ superseded: false, forcedInline: false });
  });

  it("preserves full original outputs for mixed rows, scopes, duplicates and slice options", () => {
    const repeated = toolRow(18, { turnId: "old", ui: { showInline: true } });
    const rows = freeze([
      textRow(0, "old"),
      toolRow(1, { turnId: "old" }),
      toolRow(2, { turnId: "middle", status: "running" }),
      textRow(3, "new"),
      toolRow(4, { turnId: "middle", ui: { isError: true } }),
      toolRow(5, { turnId: "old", status: "error" }),
      toolRow(6, { turnId: "new", status: "cancelled" }),
      toolRow(7, { turnId: "__proto__", ui: { surface: "other", showInline: true } }),
      toolRow(8, { turnId: "constructor", serverName: "other" }),
      toolRow(9, { turnId: "toString", ui: { pluginId: "other" } }),
      toolRow(10, { turnId: "", ui: { resourceUri: "ui://other" } }),
      toolRow(11, { turnId: "new", ui: { surface: undefined } }),
      toolRow(12, { turnId: "old", ui: { surface: undefined } }),
      ...[13, 14, 15].map((id) =>
        toolRow(id, {
          ui: {
            surface: undefined,
            widgetMeta: JSON.stringify({ "openai/widgetSessionId": "counter" }),
            csp: { resourceDomains: id === 15 ? ["b"] : ["b", "a"] },
          },
        }),
      ),
      toolRow(16, { status: "pendingApproval", ui: { surface: "unsuccessful" } }),
      toolRow(17, { status: "inputStreaming", ui: { surface: "unsuccessful" } }),
      repeated,
      repeated,
      toolRow(19, { toolCallId: repeated.toolCallId, status: "running" }),
      toolRow(20, { toolCallId: "constructor", ui: { surface: "special" } }),
      toolRow(21, { toolCallId: "toString", ui: { surface: "special" } }),
    ]);
    for (const row of rows) expect(conversationRowSchema.safeParse(row).success).toBe(true);
    const options = [undefined, 0, 1, 3, -1, 1.9, -1.9, NaN, Infinity, -Infinity];
    expect(
      options.map((autoExpandTurns) => ({
        option: String(autoExpandTurns),
        result: deriveLogicalUiInstances(rows, freeze({ autoExpandTurns })),
      })),
    ).toMatchSnapshot();
  });

  it("counts empty and non-plugin turns by first appearance and preserves the zero option", () => {
    const rows = freeze([
      toolRow(1, { turnId: "old" }),
      textRow(2, "new"),
      textRow(3, "last"),
      toolRow(4, { turnId: "old", ui: { surface: "other" } }),
      textRow(5, "last"),
      textRow(6, ""),
    ]);
    expect(deriveLogicalUiInstances(rows).byToolCallId["round10:call-1"]?.autoExpand).toBe(false);
    expect(
      deriveLogicalUiInstances(rows, { autoExpandTurns: 0 }).byToolCallId["round10:call-1"],
    ).toMatchObject({ autoExpand: true });
    expect(deriveLogicalUiInstances([])).toEqual({ instances: [], byToolCallId: {} });
  });

  it("derives replacement snapshots and options afresh without retaining removed rows", () => {
    const initial = freeze([toolRow(1), toolRow(2)]);
    const original = deriveLogicalUiInstances(initial);
    const replacement: ConversationRow[] = freeze([
      toolRow(1),
      toolRow(2, { status: "error" }),
      textRow(3, "new-a"),
      textRow(4, "new-b"),
      textRow(5, "new-c"),
    ]);
    const next = deriveLogicalUiInstances(replacement);
    expect(original.instances[0]?.activeToolCallId).toBe("round10:call-2");
    expect(next.instances[0]?.activeToolCallId).toBe("round10:call-1");
    expect(next.byToolCallId["round10:call-1"]).toMatchObject({
      autoExpand: false,
      superseded: false,
    });
    expect(
      deriveLogicalUiInstances(replacement, { autoExpandTurns: Infinity }).byToolCallId[
        "round10:call-1"
      ]?.autoExpand,
    ).toBe(true);
    expect(
      deriveLogicalUiInstances([replacement[0]!]).byToolCallId["round10:call-2"],
    ).toBeUndefined();
    expect(deriveLogicalUiInstances(initial)).toEqual(original);
  });
});
