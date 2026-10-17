import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  CommandEnvelope,
  CommandQueryItem,
  CommandsQueryResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";

const STORAGE_KEY = "zcode-v4-pending-commands:v1";
const NOW = 1_000_000;
const TTL = 24 * 60 * 60 * 1_000;
let registry: typeof import("@/v4/pendingCommandRegistry.js").pendingCommandRegistry;
let saved: Map<string, string>;
let storage: {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  saved = new Map();
  storage = {
    getItem: vi.fn((key: string) => saved.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => saved.set(key, value)),
    removeItem: vi.fn((key: string) => saved.delete(key)),
  };
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function entry(
  commandId: string,
  overrides: Partial<PendingCommandEntry> = {},
): PendingCommandEntry {
  return {
    commandId,
    clientId: "synthetic-client",
    sessionId: "session",
    issuedAt: NOW,
    expiresAt: NOW + TTL,
    replay: { kind: "input", type: "sendText", payload: { text: "synthetic" } },
    ...overrides,
  };
}

function command(commandId: string, sessionId: string | null = "session"): CommandEnvelope {
  return {
    commandId,
    sessionId,
    clientId: "synthetic-client",
    issuedAt: NOW,
    type: "sendText",
    payload: { text: "synthetic" },
  };
}

function ack(commandId: string, overrides: Partial<CommandAck> = {}): CommandAck {
  return { commandId, status: "accepted", revisionAtDecision: 0, ...overrides };
}

function item(
  commandId: string,
  result: CommandQueryItem["result"] = "unknown",
  sessionId: string | null = "session",
): CommandQueryItem {
  return { key: { sessionId, commandId }, result };
}

function discard(commandId: string, delivery?: "startNow" | "queue" | "guide"): CommandAck {
  return ack(commandId, {
    status: "failed",
    reasonCode: "fault.command.inputDiscardedOnRestart",
    ...(delivery ? { result: { type: "inputDisposition", delivery } } : {}),
  });
}

async function load(entries: PendingCommandEntry[]): Promise<void> {
  saved.set(STORAGE_KEY, JSON.stringify(entries));
  ({ pendingCommandRegistry: registry } = await import("@/v4/pendingCommandRegistry.js"));
}

function stored(): PendingCommandEntry[] {
  return JSON.parse(saved.get(STORAGE_KEY) ?? "[]") as PendingCommandEntry[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("pending command query persistence", () => {
  it("serializes the remaining ledger only once for a full 64-result response", async () => {
    await load(
      Array.from({ length: 128 }, (_, index) =>
        entry(`command-${index}`, {
          replay: { kind: "input", type: "sendText", payload: { text: "x".repeat(2048) } },
        }),
      ),
    );
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.applyQuery({
      results: Array.from({ length: 64 }, (_, index) => item(`command-${index}`)),
    });

    const serializedEntries = storage.setItem.mock.calls.reduce(
      (sum, [, value]) => sum + (JSON.parse(value) as unknown[]).length,
      0,
    );
    expect({
      writes: storage.setItem.mock.calls.length,
      serializedEntries,
      notifications: listener.mock.calls.length,
    }).toEqual({ writes: 1, serializedEntries: 64, notifications: 1 });
    expect(stored().map((value) => value.commandId)).toEqual(
      Array.from({ length: 64 }, (_, index) => `command-${index + 64}`),
    );
    expect(registry.list("session")).toEqual(stored());
  });

  it("removes the storage key once when the batch settles the last entries", async () => {
    await load([entry("first"), entry("second")]);
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.applyQuery({
      results: [item("first"), item("second"), item("first"), item("missing")],
    });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith(STORAGE_KEY);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.list("session")).toEqual([]);
  });

  it("publishes the final recovery state and retains the original expiry and dismissal", async () => {
    await load([
      entry("new-discard"),
      entry("dismissed", { recovery: "discarded", recoveryDismissed: true }),
      entry("accepted", { recovery: "discarded", recoveryDismissed: true }),
      entry("duplicate", { recovery: "discarded" }),
    ]);
    const states: PendingCommandEntry[][] = [];
    registry.subscribe(() => states.push(stored()));
    registry.applyQuery({
      results: [
        item("new-discard", discard("new-discard", "startNow")),
        item("dismissed", discard("dismissed")),
        item("accepted", ack("accepted")),
        item("duplicate", ack("duplicate", { status: "duplicate" })),
      ],
    });
    expect(registry.listRecoverable("session").map((value) => value.commandId)).toEqual([
      "new-discard",
    ]);
    expect(states).toEqual([
      [
        entry("new-discard", { recovery: "discarded", recoveryDismissed: false }),
        entry("dismissed", { recovery: "discarded", recoveryDismissed: true }),
        entry("accepted"),
        entry("duplicate"),
      ],
    ]);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("does not write or notify for accepted, unavailable, missing and unchanged recovery items", async () => {
    await load([
      entry("accepted"),
      entry("unavailable"),
      entry("discarded", { recovery: "discarded" }),
    ]);
    const listener = vi.fn();
    registry.subscribe(listener);
    const before = stored();
    registry.applyQuery({
      results: [
        item("accepted", ack("accepted")),
        item(
          "unavailable",
          ack("unavailable", { status: "failed", reasonCode: "fault.command.queryUnavailable" }),
        ),
        item("discarded", discard("discarded")),
        item("missing"),
      ],
    });
    expect(stored()).toEqual(before);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps query outcome rules for runtime discards, sensitive digests and terminal ACKs", async () => {
    const ids = [
      "queue",
      "guide",
      "sensitive",
      "rejected",
      "stale",
      "noop",
      "failed",
      "unavailable",
    ];
    await load(ids.map((id) => entry(id)));
    const sensitive = registry.record({
      ...command("answer"),
      type: "resolveInteraction",
      payload: { interactionId: "synthetic-interaction", answer: { freeText: "synthetic-secret" } },
    });
    expect(sensitive?.replay.kind).toBe("sensitiveDigest");
    expect(saved.get(STORAGE_KEY)).not.toContain("synthetic-secret");
    storage.setItem.mockClear();
    registry.applyQuery({
      results: [
        item("queue", discard("queue", "queue")),
        item("guide", discard("guide", "guide")),
        item("sensitive"),
        item("answer", ack("answer")),
        ...(["rejected", "stale", "noop", "failed"] as const).map((status) =>
          item(status, ack(status, { status })),
        ),
        item(
          "unavailable",
          ack("unavailable", { status: "failed", reasonCode: "fault.command.queryUnavailable" }),
        ),
      ],
    });
    expect(stored()).toEqual([entry("unavailable")]);
    expect(registry.listRecoverable("session")).toEqual([]);
    expect(registry.consumeReplay({ sessionId: "session", commandId: "answer" })).toBeNull();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("applies remapping and later response items in order without intermediate publications", async () => {
    const create = entry("create", {
      sessionId: null,
      replay: {
        kind: "input",
        type: "createSession",
        payload: { firstInput: { text: "synthetic" } },
      },
      recovery: "discarded",
      clientContext: {
        workspace: { workspacePath: "C:/synthetic", workspaceIdentity: "synthetic-remote" },
      },
    });
    await load([create, entry("same"), entry("same", { sessionId: "other" })]);
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.applyQuery({
      results: [
        item(
          "create",
          ack("create", { result: { type: "createSession", sessionId: "created" } }),
          null,
        ),
        item("create", discard("create"), "created"),
        item("same"),
      ],
    });
    expect(registry.list(null)).toEqual([]);
    expect(registry.list("session")).toEqual([]);
    expect(registry.list("other")).toEqual([entry("same", { sessionId: "other" })]);
    expect(registry.list("created")).toEqual([
      { ...create, sessionId: "created", recoveryDismissed: false },
    ]);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("lets a notification record and persist a new command before its send", async () => {
    await load([entry("first"), entry("second")]);
    let nested = false;
    let stateAtNotification: string[] | undefined;
    const send = vi.fn(() => expect(stored().map((value) => value.commandId)).toEqual(["new"]));
    registry.subscribe(() => {
      if (nested) return;
      nested = true;
      stateAtNotification = registry.list("session").map((value) => value.commandId);
      registry.record(command("new"));
      send();
    });
    registry.applyQuery({ results: [item("first"), item("second")] });
    expect(stateAtNotification).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(registry.list("session")).toEqual(stored());
  });

  it("a subscriber can reconcile another batch synchronously after the first commit", async () => {
    await load([entry("first"), entry("second"), entry("third"), entry("fourth")]);
    let reentered = false;
    registry.subscribe(() => {
      if (reentered) return;
      reentered = true;
      expect(stored().map((value) => value.commandId)).toEqual(["third", "fourth"]);
      registry.applyQuery({ results: [item("third"), item("fourth")] });
      expect(stored()).toEqual([]);
    });
    registry.applyQuery({ results: [item("first"), item("second")] });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
  });

  it("clears batching state before a throwing listener and later standalone mutations", async () => {
    await load([entry("first"), entry("second")]);
    const failure = new Error("synthetic listener failure");
    const unsubscribe = registry.subscribe(() => {
      throw failure;
    });
    expect(() => registry.applyQuery({ results: [item("first"), item("second")] })).toThrow(
      failure,
    );
    unsubscribe();
    expect(stored()).toEqual([]);
    registry.record(command("later"));
    expect(stored().map((value) => value.commandId)).toEqual(["later"]);
    registry.applyAck(command("later"), ack("later", { status: "rejected" }));
    expect(stored()).toEqual([]);
  });

  it("commits already-applied changes and releases the batch if synchronous processing fails", async () => {
    await load([entry("first"), entry("second"), entry("third")]);
    const failure = new Error("synthetic processing failure");
    const broken = {
      get key() {
        throw failure;
      },
    } as CommandQueryItem;
    expect(() => registry.applyQuery({ results: [item("first"), item("second"), broken] })).toThrow(
      failure,
    );
    expect(stored()).toEqual([entry("third")]);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    registry.record(command("later"));
    expect(stored().map((value) => value.commandId)).toEqual(["third", "later"]);
  });

  it("keeps one in-memory publication when storage is unavailable, then recovers", async () => {
    await load([entry("first"), entry("second"), entry("third")]);
    storage.setItem.mockImplementation(() => {
      throw new Error("synthetic quota");
    });
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.applyQuery({ results: [item("first"), item("second")] });
    expect(registry.list("session")).toEqual([entry("third")]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    storage.setItem.mockImplementation((key: string, value: string) => saved.set(key, value));
    registry.record(command("later"));
    expect(stored().map((value) => value.commandId)).toEqual(["third", "later"]);
  });

  it("does not extend TTL when restoring or marking entries recoverable", async () => {
    await load([entry("old", { expiresAt: NOW + 10 }), entry("kept")]);
    registry.applyQuery({ results: [item("old", discard("old"))] });
    expect(stored()[0].expiresAt).toBe(NOW + 10);
    vi.mocked(Date.now).mockReturnValue(NOW + 10);
    expect(registry.list("session")).toEqual([entry("kept")]);
    expect(stored()).toEqual([entry("kept")]);
  });
});

describe("production reconcileSession batching", () => {
  it("commits each response before querying the next 64 entries and shares in-flight work", async () => {
    await load(Array.from({ length: 130 }, (_, index) => entry(`command-${index}`)));
    const first = deferred<CommandsQueryResult>();
    const countsAtQuery: number[] = [];
    const query = vi.fn((params: { commands: CommandQueryItem["key"][] }) => {
      countsAtQuery.push(stored().length);
      if (countsAtQuery.length === 1) return first.promise;
      return Promise.resolve({
        results: params.commands.map((key) => ({ key, result: "unknown" as const })),
      });
    });
    const listener = vi.fn();
    registry.subscribe(listener);
    const pending = registry.reconcileSession("session", query);
    const unused = vi.fn();
    expect(registry.reconcileSession("session", unused)).toBe(pending);
    expect(unused).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    first.resolve({
      results: query.mock.calls[0][0].commands.map((key) => ({ key, result: "unknown" })),
    });
    await pending;
    expect(query.mock.calls.map(([params]) => params.commands.length)).toEqual([64, 64, 2]);
    expect(countsAtQuery).toEqual([130, 66, 2]);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(stored()).toEqual([]);
  });

  it("retains the unprocessed batch on query failure and permits a later retry", async () => {
    await load(Array.from({ length: 65 }, (_, index) => entry(`command-${index}`)));
    const failure = new Error("synthetic query failure");
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        results: Array.from({ length: 64 }, (_, index) => item(`command-${index}`)),
      })
      .mockRejectedValueOnce(failure);
    await expect(registry.reconcileSession("session", query)).rejects.toBe(failure);
    expect(stored()).toEqual([entry("command-64")]);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const retry = vi.fn().mockResolvedValue({ results: [item("command-64")] });
    await registry.reconcileSession("session", retry);
    expect(retry).toHaveBeenCalledExactlyOnceWith({
      commands: [{ sessionId: "session", commandId: "command-64" }],
    });
    expect(stored()).toEqual([]);
  });

  it("does not delay other sessions or new records while awaiting a remote response", async () => {
    await load([entry("remote"), entry("other", { sessionId: "other-session" })]);
    const remote = deferred<CommandsQueryResult>();
    const pending = registry.reconcileSession("session", () => remote.promise);
    await registry.reconcileSession("other-session", async () => ({
      results: [item("other", "unknown", "other-session")],
    }));
    registry.record(command("new"));
    expect(stored().map((value) => value.commandId)).toEqual(["remote", "new"]);
    remote.resolve({ results: [item("remote")] });
    await pending;
    expect(stored().map((value) => value.commandId)).toEqual(["new"]);
  });
});
