import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyConversationDeltas,
  DELIVERY_PROFILES,
  filterConversationDeltasForProfile,
  type CommandEnvelope,
  type ConversationRow,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

let registry: typeof import("@/v4/pendingCommandRegistry.js").pendingCommandRegistry;
let saved: Map<string, string>;
let storage: {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  vi.resetModules();
  saved = new Map();
  storage = {
    getItem: vi.fn((key: string) => saved.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      saved.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      saved.delete(key);
    }),
  };
  vi.stubGlobal("localStorage", storage);
  ({ pendingCommandRegistry: registry } = await import("@/v4/pendingCommandRegistry.js"));
});
afterEach(() => vi.unstubAllGlobals());

function command(
  commandId: string,
  sessionId: string | null = "session",
  type: CommandEnvelope["type"] = "sendText",
): CommandEnvelope {
  return {
    commandId,
    sessionId,
    clientId: "synthetic-client",
    issuedAt: 1,
    type,
    payload:
      type === "createSession" ? { firstInput: { text: "synthetic" } } : { text: "synthetic" },
  };
}

function row(rowId: number, kind = "assistantText", sourceCommandId?: string): ConversationRow {
  return {
    rowId,
    kind,
    sourceCommandId,
    marker: { type: "compact" },
    text: "synthetic",
    createdAt: 1,
    createdAtSeq: rowId,
    turnId: "turn",
    state: "streaming",
  } as ConversationRow;
}

function snapshot(
  rows: ConversationRow[],
  commands: string[] = [],
  sessionId = "session",
): ConversationSnapshot {
  return {
    sessionId,
    rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
    queue: { items: commands.map((sourceCommandId) => ({ sourceCommandId })) },
  } as ConversationSnapshot;
}

function noWindowReads(sessionId = "session"): ConversationSnapshot {
  return {
    sessionId,
    get queue() {
      throw new Error("Unexpected queue scan");
    },
    get rows() {
      throw new Error("Unexpected history scan");
    },
  } as ConversationSnapshot;
}

describe("bounded pending command snapshot reconciliation", () => {
  it.each(["continuous", "replayable"] as const)(
    "does not scan streamed history without pending entries (%s)",
    (profile) => {
      let reads = 0;
      const rows = Array.from({ length: 1000 }, (_, index) => {
        const value = row(index + 1);
        Object.defineProperty(value, "kind", {
          enumerable: true,
          get() {
            reads += 1;
            return "assistantText";
          },
        });
        return value;
      });
      let current = snapshot(rows);
      let reconciliationReads = 0;
      for (let index = 0; index < 100; index += 1) {
        current = applyConversationDeltas(
          current,
          filterConversationDeltasForProfile(
            [{ op: "row.delta", rowId: 1000, path: "text", append: "." }],
            DELIVERY_PROFILES[profile],
          ),
        );
        const before = reads;
        registry.reconcileSnapshot(current);
        reconciliationReads += reads - before;
      }
      expect(reconciliationReads).toBe(0);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    },
  );

  it("skips unrelated session and unbound createSession entries without touching the window", () => {
    registry.record(command("other", "other-session"));
    registry.record(command("create", null, "createSession"));
    registry.reconcileSnapshot(noWindowReads());
    expect(registry.list("other-session")).toHaveLength(1);
    expect(registry.list(null)).toHaveLength(1);
  });

  it("stops at queue evidence without scanning remaining queue items or rows", () => {
    registry.record(command("queued"));
    const current = {
      sessionId: "session",
      queue: {
        items: [
          { sourceCommandId: "queued" },
          {
            get sourceCommandId() {
              throw new Error("Past all pending commands");
            },
          },
        ],
      },
      get rows() {
        throw new Error("Queue already settled all pending commands");
      },
    } as ConversationSnapshot;
    storage.setItem.mockClear();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    try {
      registry.reconcileSnapshot(current);
      expect(registry.list("session")).toEqual([]);
      expect(storage.removeItem).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("stops after the last pending userInput and compact anchor, committing once", () => {
    registry.record(command("user"));
    registry.record(command("compact", "session", "compact"));
    const tail = {
      get kind() {
        throw new Error("Past all pending anchors");
      },
    } as ConversationRow;
    const current = snapshot([
      row(1, "userInput", "user"),
      row(2, "timelineMarker", "compact"),
      tail,
    ]);
    Object.freeze(current.rows.window);
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    try {
      registry.reconcileSnapshot(current);
      expect(registry.list("session")).toEqual([]);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(storage.removeItem).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("retains unproven entries and isolates the same command ID in another session", () => {
    for (const id of ["queue", "user", "compact", "unproven"]) registry.record(command(id));
    registry.record(command("user", "other-session"));
    const current = snapshot(
      [
        row(1, "userInput", "unknown"),
        row(2, "assistantText", "unproven"),
        { ...row(3, "timelineMarker", "unproven"), marker: { type: "other" } } as ConversationRow,
        row(4, "userInput", "user"),
        row(5, "userInput", "user"),
        row(6, "timelineMarker", "compact"),
      ],
      ["queue", "queue"],
    );
    const original = structuredClone(current);
    storage.setItem.mockClear();
    registry.reconcileSnapshot(current);
    expect(registry.list("session").map((item) => item.commandId)).toEqual(["unproven"]);
    expect(registry.list("other-session").map((item) => item.commandId)).toEqual(["user"]);
    expect(current).toEqual(original);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    registry.reconcileSnapshot(current);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("a new command is reconciled after an empty fast path; no cross-snapshot skip cache", () => {
    registry.reconcileSnapshot(noWindowReads());
    registry.record(command("new"));
    registry.reconcileSnapshot(snapshot([row(1, "userInput", "new")]));
    expect(registry.list("session")).toEqual([]);
    registry.reconcileSnapshot(noWindowReads());
  });

  it("createSession remains unbound until its ACK remaps it, then its first input settles it", () => {
    const envelope = command("create", null, "createSession");
    registry.record(envelope);
    const current = snapshot([row(1, "userInput", "create")]);
    registry.reconcileSnapshot(current);
    expect(registry.list(null)).toHaveLength(1);
    registry.applyAck(envelope, {
      commandId: "create",
      status: "accepted",
      revisionAtDecision: 0,
      result: { type: "createSession", sessionId: "session" },
    });
    registry.reconcileSnapshot(current);
    expect(registry.list(null)).toEqual([]);
    expect(registry.list("session")).toEqual([]);
  });
});
