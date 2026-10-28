import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserTabRecoveryStore,
  type BrowserTabPageStateRecord,
  type BrowserTabShellRecord,
} from "./browserTabRecoveryStore.js";

function shell(
  tabId: string,
  overrides: Partial<BrowserTabShellRecord> = {},
): BrowserTabShellRecord {
  return {
    schemaVersion: 1,
    tabId,
    windowBindingId: null,
    workspaceKey: "workspace",
    sessionId: "session",
    origin: "agent",
    lifecycle: "active",
    restoreUrl: null,
    title: tabId,
    faviconUrl: null,
    viewport: { width: 800, height: 600 },
    openedAt: 1,
    lastSelectedAt: null,
    updatedAt: 1,
    ...overrides,
  };
}

function page(tabId: string, count = 3): BrowserTabPageStateRecord {
  return {
    schemaVersion: 1,
    tabId,
    entries: Array.from({ length: count }, (_, i) => ({ url: `https://example.test/${i}` })),
    activeIndex: 1,
    updatedAt: 1,
  };
}

describe("browser recovery read work", () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "zcodium-recovery-read-"));
    file = join(directory, "recovery.json");
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function seed(shells: BrowserTabShellRecord[], pageStates: BrowserTabPageStateRecord[]) {
    await writeFile(file, JSON.stringify({ schemaVersion: 1, shells, pageStates }), "utf8");
    return new BrowserTabRecoveryStore(file);
  }

  it("preserves lookup, scope fallback and stable shell ordering", async () => {
    const shells = [
      shell("b"),
      shell("a"),
      shell("early", { openedAt: 0, remoteSessionId: "" }),
      shell("other-session", { sessionId: "other" }),
      shell("remote", { remoteSessionId: "remote" }),
      shell("other-workspace", { workspaceKey: "other" }),
    ];
    const store = await seed(shells, [page("a")]);
    expect(await store.getShell("a")).toEqual(shells[1]);
    expect(await store.getShell("missing")).toBeNull();
    expect(await store.getPageState("a")).toEqual(page("a"));
    expect(await store.getPageState("missing")).toBeNull();
    expect(
      (await store.listShells({ workspaceKey: "workspace", sessionId: "session" })).map(
        ({ tabId }) => tabId,
      ),
    ).toEqual(["early", "a", "b"]);
    expect(
      (await store.listShells({ workspaceKey: "workspace", remoteSessionId: "" })).map(
        ({ tabId }) => tabId,
      ),
    ).toEqual(["early", "a", "b", "other-session"]);
    expect(
      (await store.listShells({ workspaceKey: "workspace", remoteSessionId: "remote" })).map(
        ({ tabId }) => tabId,
      ),
    ).toEqual(["remote"]);
    expect((await store.readSnapshot()).shells.map(({ tabId }) => tabId)).toEqual(
      shells.map(({ tabId }) => tabId),
    );
  });

  it("retains the existing record and history copy boundaries", async () => {
    const store = await seed([shell("a")], [page("a")]);
    const record = (await store.getShell("a"))!;
    const listed = (await store.listShells({ workspaceKey: "workspace" }))[0]!;
    record.title = "changed";
    listed.sessionId = "changed";
    expect((await store.getShell("a"))!.title).toBe("a");
    expect((await store.getShell("a"))!.sessionId).toBe("session");
    expect(record.viewport).toBe(listed.viewport);
    const state = (await store.getPageState("a"))!;
    state.activeIndex = 0;
    state.entries[0]!.url = "https://changed.test";
    state.entries.push({ url: "https://added.test" });
    expect(await store.getPageState("a")).toEqual(page("a"));
    const snapshot = await store.readSnapshot();
    snapshot.shells[0]!.title = "changed";
    snapshot.pageStates[0]!.entries[0]!.url = "https://changed.test";
    expect((await store.getShell("a"))!.title).toBe("a");
    expect(await store.getPageState("a")).toEqual(page("a"));
  });

  it("waits for accepted mutations before returning the selected records", async () => {
    const store = await seed([shell("a")], [page("a")]);
    const writeShell = store.upsert(shell("a", { title: "updated" }));
    const readShell = store.getShell("a");
    expect((await readShell)!.title).toBe("updated");
    await writeShell;
    const next = { ...page("a"), activeIndex: 2 };
    const writePage = store.upsertPageState(next);
    const readPage = store.getPageState("a");
    expect(await readPage).toEqual(next);
    await writePage;
    const writeOther = store.upsert(shell("b"));
    const listed = store.listShells({ workspaceKey: "workspace" });
    expect((await listed).map(({ tabId }) => tabId)).toEqual(["a", "b"]);
    await writeOther;
    await store.whenIdle();
    expect(await new BrowserTabRecoveryStore(file).readSnapshot()).toEqual(
      await store.readSnapshot(),
    );
  });

  it("does not copy unrelated navigation history for narrow reads", async () => {
    const store = await seed(
      Array.from({ length: 80 }, (_, i) => shell(`tab-${i}`)),
      Array.from({ length: 80 }, (_, i) => page(`tab-${i}`, 200)),
    );
    await store.readSnapshot();
    const snapshot = (store as unknown as { snapshot: { pageStates: BrowserTabPageStateRecord[] } })
      .snapshot;
    let visits = 0;
    for (const record of snapshot.pageStates) {
      for (const history of record.entries) {
        const url = history.url;
        Object.defineProperty(history, "url", {
          enumerable: true,
          get() {
            visits++;
            return url;
          },
        });
      }
    }
    await store.getShell("tab-0");
    const shellVisits = visits;
    visits = 0;
    await store.listShells({ workspaceKey: "workspace" });
    const listVisits = visits;
    visits = 0;
    expect((await store.getPageState("tab-0"))!.entries).toHaveLength(200);
    const pageVisits = visits;
    visits = 0;
    await store.getPageState("missing");
    const missingVisits = visits;
    visits = 0;
    await store.readSnapshot();
    expect(visits).toBe(16_000);
    expect({ shellVisits, listVisits, pageVisits, missingVisits }).toEqual({
      shellVisits: 0,
      listVisits: 0,
      pageVisits: 200,
      missingVisits: 0,
    });
  });
});
