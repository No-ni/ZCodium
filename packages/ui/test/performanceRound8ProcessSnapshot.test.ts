import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  captureExitedRootDescendantsSnapshot,
  captureProcessTreeSnapshot,
} from "../../services/src/process/processTreeSnapshot.js";
import {
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
} from "../../services/src/process/processTreeSnapshotAsync.js";
import type { ProcessIdentity } from "../../services/src/process/processTreeTypes.js";
import { readWindowsProcessListAsync } from "../../services/src/process/windowsProcessListAsync.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../../services/src/process/windowsProcessListAsync.js", () => ({
  readWindowsProcessListAsync: vi.fn(),
  verifyWindowsProcessIdentityAsync: vi.fn(),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const EPOCH_TICKS = 621_355_968_000_000_000n;
const rootPid = 1;
const child = { pid: rootPid, exitCode: null, signalCode: null } as ChildProcess;

beforeEach(() => vi.clearAllMocks());
afterEach(() => Object.defineProperty(process, "platform", platformDescriptor));

function platform(value: string): void {
  Object.defineProperty(process, "platform", { value });
}

function identity(pid: number, parentPid: number, createdAtMs = 1500): ProcessIdentity {
  return { pid, parentPid, startTime: `windows-utc-us:${createdAtMs * 1000}` };
}

function deepTable(): ProcessIdentity[] {
  return Array.from({ length: 20_001 }, (_, index) => identity(index + 1, index));
}

function mockSyncTable(table: readonly ProcessIdentity[], windows = false): void {
  platform(windows ? "win32" : "darwin");
  const stdout = table
    .map((item) => {
      if (!windows)
        return `${item.pid} ${item.parentPid} ${item.processGroupId ?? 900} Sat Oct 17 00:00:00 2026 process`;
      const microseconds = BigInt(item.startTime.slice("windows-utc-us:".length));
      return `${item.pid} ${item.parentPid} ${EPOCH_TICKS + microseconds * 10n}`;
    })
    .join("\n");
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout,
    stderr: "",
  } as ReturnType<typeof spawnSync>);
}

function mockAsyncTable(table: readonly ProcessIdentity[]): void {
  platform("win32");
  vi.mocked(readWindowsProcessListAsync).mockResolvedValue(table);
}

function referenceDescendants(root: number, table: readonly ProcessIdentity[]): ProcessIdentity[] {
  const byParent = new Map<number, ProcessIdentity[]>();
  for (const item of table) {
    const siblings = byParent.get(item.parentPid) ?? [];
    siblings.push(item);
    byParent.set(item.parentPid, siblings);
  }
  const result: ProcessIdentity[] = [];
  const seen = new Set([root]);
  function visit(pid: number): void {
    for (const item of byParent.get(pid) ?? []) {
      if (seen.has(item.pid)) continue;
      seen.add(item.pid);
      result.push(item);
      visit(item.pid);
    }
  }
  visit(root);
  return result;
}

it("captures all 20,000 descendants synchronously without exhausting the call stack", () => {
  mockSyncTable(deepTable());
  const snapshot = captureProcessTreeSnapshot(child)!;
  expect(snapshot.identities).toHaveLength(20_001);
  expect(snapshot.descendantPids).toEqual(Array.from({ length: 20_000 }, (_, index) => index + 2));
});

it("captures all 20,000 descendants from the asynchronous Windows process table", async () => {
  const table = deepTable();
  mockAsyncTable(table);
  const snapshot = (await captureProcessTreeSnapshotAsync(child))!;
  expect(snapshot.identities).toEqual(table);
  expect(snapshot.descendantPids).toEqual(table.slice(1).map((item) => item.pid));
});

it("captures a deep chain after the root exits through the synchronous Windows entry", () => {
  const table = deepTable().slice(1);
  mockSyncTable(table, true);
  const snapshot = captureExitedRootDescendantsSnapshot(rootPid, {
    ownedProcessStartedAtMs: 1000,
    ownedProcessExitedAtMs: 2000,
  })!;
  expect(snapshot.descendantPids).toEqual(table.map((item) => item.pid));
});

it("captures a deep chain after the root exits through the asynchronous Windows entry", async () => {
  const table = deepTable().slice(1);
  mockAsyncTable(table);
  const snapshot = (await captureExitedRootDescendantsSnapshotAsync(rootPid, {
    ownedProcessStartedAtMs: 1000,
    ownedProcessExitedAtMs: 2000,
  }))!;
  expect(snapshot.identities).toEqual(table);
});

it("retains recursive DFS order and original identity references on branching cyclic graphs", async () => {
  const explicit = [
    identity(1, 0),
    identity(4, 2),
    identity(2, 1),
    identity(3, 1),
    identity(5, 3),
    identity(2, 3),
    identity(1, 5),
    identity(4, 3),
    identity(50, 90),
  ];
  let seed = 23;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let trial = 0; trial < 101; trial++) {
    const table = Object.freeze(
      (trial === 0
        ? explicit
        : [
            identity(1, 0),
            ...Array.from({ length: 30 }, () => identity(2 + (random() % 29), random() % 33)),
          ]
      ).map((item) => Object.freeze(item)),
    );
    mockAsyncTable(table);
    const expected = [table[0]!, ...referenceDescendants(1, table)];
    const actual = (await captureProcessTreeSnapshotAsync(child))!.identities;
    expect(actual).toEqual(expected);
    actual.forEach((item, index) => expect(item).toBe(expected[index]));
    mockSyncTable(table);
    const syncExpectedPids = [...new Set(expected.map((item) => item.pid))];
    expect(captureProcessTreeSnapshot(child)!.identities.map((item) => item.pid)).toEqual(
      syncExpectedPids,
    );
  }
});

it("preserves missing-root and unrelated-process boundaries", async () => {
  const table = [identity(2, 1), identity(3, 2), identity(50, 90)];
  mockSyncTable(table);
  expect(captureProcessTreeSnapshot(child)).toBeUndefined();
  mockAsyncTable(table);
  expect(await captureProcessTreeSnapshotAsync(child)).toBeUndefined();
  expect(
    await captureExitedRootDescendantsSnapshotAsync(1, {
      ownedProcessStartedAtMs: 1000,
      ownedProcessExitedAtMs: 2000,
    }),
  ).toMatchObject({ descendantPids: [2, 3] });
});

it("keeps lifecycle filtering when a root exits during the asynchronous query", async () => {
  const table = [
    identity(1, 0, 2500),
    identity(2, 1, 1500),
    identity(3, 2, 1600),
    identity(4, 1, 2000),
    identity(5, 1, 2501),
    identity(6, 4, 1500),
  ];
  mockAsyncTable(table);
  const exitingChild = { ...child } as ChildProcess;
  vi.mocked(readWindowsProcessListAsync).mockImplementation(async () => {
    exitingChild.exitCode = 0;
    return table;
  });
  expect(
    await captureProcessTreeSnapshotAsync(exitingChild, {
      ownedProcessStartedAtMs: 1000,
      resolveOwnedProcessExitedAtMs: () => 2000,
    }),
  ).toMatchObject({ rootPid: 1, descendantPids: [2, 3] });
  expect(await captureProcessTreeSnapshotAsync(exitingChild)).toBeUndefined();
});

it("preserves the synchronous lifecycle boundary while omitting disconnected candidates", () => {
  mockSyncTable(
    [
      identity(2, 1, 1000),
      identity(3, 2, 2000),
      identity(4, 1, 2001),
      identity(5, 4, 1500),
      identity(6, 1, 999),
    ],
    true,
  );
  expect(
    captureExitedRootDescendantsSnapshot(1, {
      ownedProcessStartedAtMs: 1000,
      ownedProcessExitedAtMs: 2000,
    }),
  ).toMatchObject({ descendantPids: [2, 3] });
});

it("keeps POSIX detached-group members after the normal DFS descendants", () => {
  const table = [
    { ...identity(1, 0), processGroupId: 1 },
    identity(2, 1),
    { ...identity(4, 90), processGroupId: 1 },
    { ...identity(5, 90), processGroupId: 900 },
    identity(3, 2),
  ];
  mockSyncTable(table);
  expect(captureProcessTreeSnapshot(child)).toMatchObject({ descendantPids: [2, 3, 4] });
  mockSyncTable([{ ...table[0]!, processGroupId: 900 }, ...table.slice(1)]);
  expect(captureProcessTreeSnapshot(child)).toMatchObject({ descendantPids: [2, 3] });
});
