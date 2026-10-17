import { expect, it, vi } from "vitest";
import {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type ProcessResourceSample,
} from "../../services/src/process/processResourceSampler.js";

function procStat(pid: number, command = `process ${pid}`, cpuTicks = 100): string {
  const fields = ["S", "1", ...Array.from({ length: 9 }, () => "0"), String(cpuTicks), "200"];
  return `${pid} (${command}) ${fields.join(" ")}`;
}

function procText(path: string): string {
  const pid = Number(path.split("/")[2]);
  return path.endsWith("/stat") ? procStat(pid) : "Name:\tprocess\nVmRSS:\t1234 kB\n";
}

async function microtasks() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

it("bounds /proc reads while retaining directory order across 200 processes", async () => {
  let active = 0;
  let peak = 0;
  let total = 0;
  const entries = Array.from({ length: 200 }, (_, index) => String(200 - index));
  const readTable = createProcessResourceTableReader({
    platform: "linux",
    readdir: async () => ["self", ...entries, "not-a-pid"],
    readFile: async (path) => {
      total++;
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => setTimeout(resolve, path.endsWith("/stat") ? 1 : 2));
      active--;
      return procText(path);
    },
  });

  const rows = await readTable();

  expect(rows?.map((row) => row.pid)).toEqual(entries.map(Number));
  expect(rows?.[0]).toMatchObject({ cpuTimeMs: 3000, rssKb: 1234, command: "process 200" });
  expect(total).toBe(400);
  expect(peak).toBe(16);
  expect(active).toBe(0);
});

it("keeps a worker occupied until both reads settle when one sibling fails", async () => {
  let active = 0;
  let peak = 0;
  const readTable = createProcessResourceTableReader({
    platform: "linux",
    readdir: async () => Array.from({ length: 100 }, (_, index) => String(index + 1)),
    readFile: async (path) => {
      peak = Math.max(peak, ++active);
      if (path.endsWith("/stat")) {
        active--;
        throw new Error("process exited");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active--;
      return procText(path);
    },
  });

  expect(await readTable()).toEqual([]);
  expect(peak).toBeLessThanOrEqual(16);
  expect(active).toBe(0);
});

it("also waits for started siblings when an injected reader throws synchronously", async () => {
  let active = 0;
  let peak = 0;
  const readTable = createProcessResourceTableReader({
    platform: "linux",
    readdir: async () => Array.from({ length: 100 }, (_, index) => String(index + 1)),
    readFile: (path) => {
      if (path.endsWith("/status")) throw new Error("synchronous read failure");
      peak = Math.max(peak, ++active);
      return new Promise<string>((resolve) =>
        setTimeout(() => {
          active--;
          resolve(procText(path));
        }, 1),
      );
    },
  });

  expect(await readTable()).toEqual([]);
  expect(peak).toBeLessThanOrEqual(16);
  expect(active).toBe(0);
});

it("skips per-process errors and invalid stat without reordering successful rows", async () => {
  const reads: string[] = [];
  const readTable = createProcessResourceTableReader({
    platform: "linux",
    readdir: async () => ["9", "self", "3", "8", "2", "1"],
    readFile: async (path) => {
      reads.push(path);
      if (path === "/proc/3/status") throw new Error("denied");
      if (path === "/proc/8/stat") return "invalid";
      return procText(path);
    },
  });

  expect((await readTable())?.map((row) => row.pid)).toEqual([9, 2, 1]);
  expect(reads).toHaveLength(10);
  expect(reads.every((path) => !path.includes("self"))).toBe(true);
});

it("does not start queued process reads after cancellation or write a CPU baseline", async () => {
  const controller = new AbortController();
  const releases: Array<() => void> = [];
  let blocking = true;
  let now = 1000;
  const reads: string[] = [];
  const readTable = createProcessResourceTableReader({
    platform: "linux",
    readdir: async () => Array.from({ length: 200 }, (_, index) => String(index + 1)),
    readFile: async (path) => {
      reads.push(path);
      if (blocking) await new Promise<void>((resolve) => releases.push(resolve));
      return path.endsWith("/stat") && !blocking
        ? procStat(Number(path.split("/")[2]), undefined, 400)
        : procText(path);
    },
  });
  const sampler = createProcessResourceSampler({ readTable, now: () => now, logicalCpuCount: 4 });
  const pending = sampler.sample(controller.signal);
  const rejection = expect(pending).rejects.toThrow();
  await microtasks();
  const firstBatchCount = reads.length;
  controller.abort();
  releases.splice(0).forEach((release) => release());
  await rejection;

  expect(firstBatchCount).toBeGreaterThan(0);
  expect(firstBatchCount).toBeLessThanOrEqual(16);
  expect(reads).toHaveLength(firstBatchCount);
  blocking = false;
  now = 2000;
  expect([...(await sampler.sample())!.values()].every((sample) => sample.cpuPercent === 0)).toBe(
    true,
  );
});

it("retains pre-abort, missing-directory and empty-directory results", async () => {
  const readdir = vi.fn(async () => []);
  const readFile = vi.fn(async () => "");
  const reader = createProcessResourceTableReader({ platform: "linux", readdir, readFile });
  const controller = new AbortController();
  controller.abort();
  await expect(reader(controller.signal)).rejects.toThrow();
  expect(readdir).not.toHaveBeenCalled();
  expect(await reader()).toEqual([]);
  expect(readFile).not.toHaveBeenCalled();

  const unavailable = createProcessResourceTableReader({
    platform: "linux",
    readdir: async () => {
      throw new Error("unavailable");
    },
  });
  expect(await unavailable()).toBeUndefined();
});

it("does not read process files when cancellation arrives during readdir", async () => {
  const controller = new AbortController();
  const readFile = vi.fn(async (path: string) => procText(path));
  const reader = createProcessResourceTableReader({
    platform: "linux",
    readdir: async () => {
      controller.abort();
      return ["1", "2"];
    },
    readFile,
  });

  expect(await reader(controller.signal)).toEqual([]);
  expect(readFile).not.toHaveBeenCalled();
});

function sample(pid: number, ppid: number): ProcessResourceSample {
  return { pid, ppid, cpuPercent: 2, rssKb: 1, command: `process-${pid}` };
}

it("attributes a 20,000-process chain without exhausting the JavaScript call stack", () => {
  const samples = new Map(
    Array.from({ length: 20_000 }, (_, index) => [index + 2, sample(index + 2, index + 1)]),
  );
  const rows = attributeHostProcessTree({ samples, hostPid: 1, agents: [] });

  expect(rows).toHaveLength(20_000);
  expect(rows[0]?.pid).toBe(2);
  expect(rows.at(-1)?.pid).toBe(20_001);
  expect(rows.every((row) => row.groupKey === "host")).toBe(true);
  expect(samples.size).toBe(20_000);
});

it("retains nearest owner precedence, detached root recovery, cycles and final PID order", () => {
  const samples = new Map(
    [
      sample(30, 1),
      sample(31, 30),
      sample(32, 31),
      sample(10, 32),
      sample(11, 10),
      sample(12, 11),
      sample(50, 0),
      sample(51, 50),
      sample(60, 51),
      sample(61, 60),
      sample(70, 0),
      sample(71, 70),
      sample(80, 0),
      sample(81, 80),
      sample(90, 91),
      sample(91, 90),
      sample(1, 12),
    ].map((value) => [value.pid, value]),
  );
  const agent = {
    pid: 30,
    provider: "zcode",
    workspacePath: "/workspace",
    children: [
      {
        pid: 10,
        serverName: "builtin-server",
        pluginName: "official",
        mcpSource: "builtin" as const,
      },
      { pid: 50, serverName: "third-party", pluginName: "community", mcpSource: "plugin" as const },
      { pid: 60, serverName: "custom-server", mcpSource: "custom" as const },
      { pid: 70, serverName: "overridden", mcpSource: "custom" as const },
      { pid: 90, serverName: "cyclic-server", mcpSource: "custom" as const },
      { pid: 999, serverName: "missing-server", mcpSource: "custom" as const },
    ],
  };
  const rows = attributeHostProcessTree({
    samples,
    hostPid: 1,
    agents: [agent],
    builtinPluginPids: new Map([
      [70, "native-helper"],
      [80, "orphan-helper"],
    ]),
  });

  expect(rows.map((row) => row.pid)).toEqual([
    10, 11, 12, 30, 31, 32, 50, 51, 60, 61, 70, 71, 80, 81, 90, 91,
  ]);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  expect(byPid.get(31)).toMatchObject({ name: "process-31", category: "base", groupKey: "cli" });
  expect(byPid.get(10)).toMatchObject({
    name: "builtin-server",
    category: "builtin-plugin",
    groupKey: "builtin:official",
  });
  expect(byPid.get(12)).toMatchObject({ category: "builtin-plugin", groupKey: "builtin:official" });
  expect(byPid.get(51)).toMatchObject({
    name: "process-51",
    category: "community-plugin",
    groupKey: "plugin:community",
  });
  expect(byPid.get(60)).toMatchObject({ name: "custom-server", groupKey: "custom:custom-server" });
  expect(byPid.get(61)).toMatchObject({ groupKey: "custom:custom-server" });
  expect(byPid.get(70)).toMatchObject({
    name: "process-70",
    category: "builtin-plugin",
    groupKey: "native-helper",
  });
  expect(byPid.get(71)).toMatchObject({ groupKey: "native-helper" });
  expect(byPid.get(81)).toMatchObject({ groupKey: "orphan-helper" });
  expect(byPid.get(91)).toMatchObject({
    groupKey: "custom:cyclic-server",
    cpuPercent: 2,
    memoryBytes: 1024,
  });
});

it("matches the original recursive attribution across deterministic small process graphs", () => {
  let seed = 391;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const agents = [
    {
      pid: 20,
      provider: "zcode",
      workspacePath: "/a",
      children: [
        { pid: 10, serverName: "mcp10", mcpSource: "custom" as const },
        { pid: 40, serverName: "mcp40", pluginName: "plugin40", mcpSource: "plugin" as const },
      ],
    },
    { pid: 30, provider: "zcode", workspacePath: "/b", children: [] },
  ];
  const builtinPluginPids = new Map([
    [40, "helper40"],
    [49, "helper49"],
  ]);
  const ownerRoots = new Map([
    [20, "cli"],
    [10, "custom:mcp10"],
    [40, "helper40"],
    [30, "cli"],
    [49, "helper49"],
  ]);

  for (let graph = 0; graph < 100; graph++) {
    const samples = new Map(
      Array.from({ length: 50 }, (_, index) => sample(index + 2, Math.floor(random() * 53)))
        .sort(() => random() - 0.5)
        .map((value) => [value.pid, value]),
    );
    const childrenByParent = new Map<number, number[]>();
    for (const value of samples.values()) {
      const siblings = childrenByParent.get(value.ppid) ?? [];
      siblings.push(value.pid);
      childrenByParent.set(value.ppid, siblings);
    }
    const expected: Array<{ pid: number; groupKey: string }> = [];
    const visited = new Set([1]);
    const visit = (pid: number, inheritedOwner: string) => {
      for (const childPid of childrenByParent.get(pid) ?? []) {
        if (visited.has(childPid)) continue;
        visited.add(childPid);
        if (!samples.has(childPid)) continue;
        const owner = ownerRoots.get(childPid) ?? inheritedOwner;
        expected.push({ pid: childPid, groupKey: owner });
        visit(childPid, owner);
      }
    };
    visit(1, "host");
    for (const [pid, owner] of ownerRoots) {
      if (visited.has(pid) || !samples.has(pid)) continue;
      visited.add(pid);
      expected.push({ pid, groupKey: owner });
      visit(pid, owner);
    }
    expected.sort((left, right) => left.pid - right.pid);

    expect(
      attributeHostProcessTree({ samples, hostPid: 1, agents, builtinPluginPids }).map(
        ({ pid, groupKey }) => ({ pid, groupKey }),
      ),
    ).toEqual(expected);
  }
});
