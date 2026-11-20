import { basename } from "node:path";
import os from "node:os";
import {
  formatZCodeAgentProcessName,
  type HostResourceUsageProcess,
  type ZCodeProcessChildProcess,
} from "@zcode/shared";
import { type ProcessResourceTableReader } from "./processResourceTable.js";
export {
  type ProcessResourceRow,
  type ProcessResourceTableReader,
  parseCpuTimeText,
  parseDarwinProcessTable,
  parseLinuxProcStat,
  parseLinuxVmRssKb,
  parseWindowsProcessTable,
  type CreateProcessResourceTableReaderOptions,
  createProcessResourceTableReader,
} from "./processResourceTable.js";

/** 上一轮 cputime 基线在这么久没被再次看到后丢弃（pid 复用防护） */
const CPU_BASELINE_TTL_MS = 60_000;

export interface ProcessResourceSample {
  pid: number;
  ppid: number;
  rssKb: number;
  /** 整机归一化 CPU 百分比；首个样本无差分基线记 0 */
  cpuPercent: number;
  command: string;
}

export interface ProcessResourceSampler {
  sample(signal?: AbortSignal): Promise<Map<number, ProcessResourceSample> | undefined>;
}

export interface CreateProcessResourceSamplerOptions {
  readTable: ProcessResourceTableReader;
  now?: () => number;
  logicalCpuCount?: number;
}

export function createProcessResourceSampler(
  options: CreateProcessResourceSamplerOptions,
): ProcessResourceSampler {
  const now = options.now ?? Date.now;
  const logicalCpuCount = Math.max(1, options.logicalCpuCount ?? os.cpus().length);
  const baselines = new Map<number, { cpuTimeMs: number; at: number; command: string }>();

  return {
    async sample(signal) {
      const rows = await options.readTable(signal);
      // 关窗后的迟到 IO 不能改变下一次打开窗口的采样基线。
      signal?.throwIfAborted();
      if (!rows) return undefined;
      const at = now();
      const samples = new Map<number, ProcessResourceSample>();
      for (const row of rows) {
        const baseline = baselines.get(row.pid);
        let cpuPercent = 0;
        // pid 复用防护：command 变了或 cputime 倒退都视为新进程，重新建立基线。
        const reusable =
          baseline &&
          baseline.command === row.command &&
          row.cpuTimeMs >= baseline.cpuTimeMs &&
          at > baseline.at;
        if (reusable) {
          const elapsedMs = at - baseline.at;
          cpuPercent = (((row.cpuTimeMs - baseline.cpuTimeMs) / elapsedMs) * 100) / logicalCpuCount;
        }
        baselines.set(row.pid, { cpuTimeMs: row.cpuTimeMs, at, command: row.command });
        samples.set(row.pid, {
          pid: row.pid,
          ppid: row.ppid,
          rssKb: row.rssKb,
          cpuPercent: Math.max(0, Math.min(100, roundPercent(cpuPercent))),
          command: row.command,
        });
      }
      for (const [pid, baseline] of baselines) {
        if (!samples.has(pid) && at - baseline.at > CPU_BASELINE_TTL_MS) {
          baselines.delete(pid);
        }
      }
      return samples;
    },
  };
}

function roundPercent(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

export interface HostResourceUsageAgent {
  pid: number;
  provider: string;
  workspacePath: string;
  /** CLI `process/childProcesses` 的回报；请求失败时为空数组，非根后代按任务进程归类 */
  children: readonly ZCodeProcessChildProcess[];
}

export interface AttributeHostProcessTreeOptions {
  samples: ReadonlyMap<number, ProcessResourceSample>;
  hostPid: number;
  agents: readonly HostResourceUsageAgent[];
  /** Host 直接管理的内置插件进程（如 Windows CUA Helper）：pid → 插件名 */
  builtinPluginPids?: ReadonlyMap<number, string>;
}

type Owner =
  | { kind: "agent"; agent: HostResourceUsageAgent }
  | { kind: "mcp"; child: ZCodeProcessChildProcess }
  | { kind: "builtin"; pluginName: string };

function commandDisplayName(command: string): string {
  const name = basename(command.trim()).replace(/\.exe$/i, "");
  return name || command.trim() || "process";
}

function ownerToRow(
  owner: Owner | undefined,
  sample: ProcessResourceSample,
  isOwnerRoot: boolean,
): HostResourceUsageProcess {
  const cpuPercent = sample.cpuPercent;
  const memoryBytes = sample.rssKb * 1024;
  if (!owner) {
    return {
      pid: sample.pid,
      name: commandDisplayName(sample.command),
      category: "base",
      groupKey: "host",
      groupLabel: "host",
      cpuPercent,
      memoryBytes,
    };
  }
  if (owner.kind === "agent") {
    return {
      pid: sample.pid,
      name: isOwnerRoot
        ? formatZCodeAgentProcessName(owner.agent.provider, owner.agent.workspacePath)
        : commandDisplayName(sample.command),
      // Agent 本身是基础开销；其非插件后代随用户任务变化，单独归入任务进程。
      category: isOwnerRoot ? "base" : "task",
      groupKey: "cli",
      groupLabel: "cli",
      cpuPercent,
      memoryBytes,
    };
  }
  if (owner.kind === "builtin") {
    return {
      pid: sample.pid,
      name: commandDisplayName(sample.command),
      category: "builtin-plugin",
      groupKey: owner.pluginName,
      groupLabel: owner.pluginName,
      cpuPercent,
      memoryBytes,
    };
  }
  const { child } = owner;
  const groupLabel = child.pluginName ?? child.serverName;
  return {
    pid: sample.pid,
    name: isOwnerRoot ? child.serverName : commandDisplayName(sample.command),
    // 用户裁决：官方市场插件是内置插件，其余（第三方市场 + 自定义 MCP）全部算社区插件。
    category: child.mcpSource === "builtin" ? "builtin-plugin" : "community-plugin",
    groupKey: `${child.mcpSource}:${groupLabel}`,
    groupLabel,
    cpuPercent,
    memoryBytes,
  };
}

/**
 * 把 Host 的全部后代按“最近的已知祖先”归属：
 * MCP 根 pid → 对应插件；Agent 根 → 基础服务，非插件后代 → 任务进程；无归属 → 基础服务 host。
 * Host 自身不在结果里（它的指标由 main 的 app.getAppMetrics 提供）。
 */
export function attributeHostProcessTree(
  options: AttributeHostProcessTreeOptions,
): HostResourceUsageProcess[] {
  const childrenByParent = new Map<number, number[]>();
  for (const sample of options.samples.values()) {
    const siblings = childrenByParent.get(sample.ppid) ?? [];
    siblings.push(sample.pid);
    childrenByParent.set(sample.ppid, siblings);
  }

  const ownerRoots = new Map<number, Owner>();
  for (const agent of options.agents) {
    ownerRoots.set(agent.pid, { kind: "agent", agent });
    for (const child of agent.children) {
      ownerRoots.set(child.pid, { kind: "mcp", child });
    }
  }
  for (const [pid, pluginName] of options.builtinPluginPids ?? []) {
    ownerRoots.set(pid, { kind: "builtin", pluginName });
  }

  const rows: HostResourceUsageProcess[] = [];
  const visited = new Set<number>([options.hostPid]);
  const visit = (pid: number, inheritedOwner: Owner | undefined): void => {
    // 进程链可能比 JavaScript 调用栈深；显式 DFS 帧保留原先逐个子节点进入的
    // 顺序、最近祖先归属和 visited 时机，避免递归溢出丢掉整轮资源快照。
    const stack = [
      { childPids: childrenByParent.get(pid) ?? [], nextIndex: 0, owner: inheritedOwner },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.nextIndex === frame.childPids.length) {
        stack.pop();
        continue;
      }
      const childPid = frame.childPids[frame.nextIndex++]!;
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      const sample = options.samples.get(childPid);
      if (!sample) continue;
      const rootOwner = ownerRoots.get(childPid);
      const owner = rootOwner ?? frame.owner;
      rows.push(ownerToRow(owner, sample, rootOwner !== undefined));
      stack.push({ childPids: childrenByParent.get(childPid) ?? [], nextIndex: 0, owner });
    }
  };
  visit(options.hostPid, undefined);

  // Agent 注册表里已知但不在 Host 子树下的进程（极端情况：ppid 被重排为 1）也补进来，避免拓扑丢行。
  for (const [pid, owner] of ownerRoots) {
    if (visited.has(pid)) continue;
    const sample = options.samples.get(pid);
    if (!sample) continue;
    visited.add(pid);
    rows.push(ownerToRow(owner, sample, true));
    visit(pid, owner);
  }

  return rows.sort((left, right) => left.pid - right.pid);
}
