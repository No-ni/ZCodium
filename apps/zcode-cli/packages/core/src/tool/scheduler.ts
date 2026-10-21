// ============================================================
// Tool Scheduler - Tool execution scheduling
// ============================================================

import type { ModelToolSideEffectScope, ToolCallId } from "@zcode/contracts";
import { createCoreError, CoreErrorType } from "@zcode/contracts";

// -----------------------------------------------
// Types
// -----------------------------------------------

export interface ToolSchedule {
  items: ToolScheduleItem[];
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

export interface ToolScheduleItem {
  toolCallId: ToolCallId;
  toolName?: string;
  dependencies: ToolCallId[];
  canRunParallel: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
}

export interface ToolDependency {
  toolCallId: ToolCallId;
  toolName?: string;
  dependsOn: ToolCallId[];
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
}

// -----------------------------------------------
// Scheduler
// -----------------------------------------------

interface ToolSchedulerOptions {
  maxConcurrency?: number;
  readOnlyTools?: Set<string>;
}

const DEFAULT_MAX_CONCURRENCY = 10;

export class ToolScheduler {
  private itemsMap = new Map<ToolCallId, ToolScheduleItem>();
  private maxConcurrency: number;
  private readOnlyTools: Set<string>;

  constructor(options: ToolSchedulerOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.readOnlyTools = options.readOnlyTools ?? READ_ONLY_TOOLS;
  }

  schedule(tools: ToolDependency[]): ToolSchedule {
    const items = tools.map((tool) => ({
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      dependencies: tool.dependsOn,
      canRunParallel: this.canRunInParallel(tool),
      readOnly: tool.readOnly ?? (tool.toolName ? this.readOnlyTools.has(tool.toolName) : undefined),
      destructive: tool.destructive,
      concurrentSafe: tool.concurrentSafe,
      sideEffectScope: tool.sideEffectScope,
    }));

    this.itemsMap = new Map(items.map((item) => [item.toolCallId, item]));

    const sorted = this.topologicalSort(items);
    const groups = this.groupByParallel(sorted);
    this.validateNoCycles(groups);

    return {
      items,
      parallelGroups: groups,
      executionOrder: groups.flat(),
    };
  }

  private canRunInParallel(tool: ToolDependency): boolean {
    const hasToolName = typeof tool.toolName === "string" && tool.toolName.length > 0;
    const hasSafetyMetadata =
      tool.readOnly !== undefined ||
      tool.destructive !== undefined ||
      tool.concurrentSafe !== undefined ||
      tool.sideEffectScope !== undefined;

    if (!hasToolName && !hasSafetyMetadata) {
      return true;
    }

    const readOnly = tool.readOnly ?? (hasToolName ? this.readOnlyTools.has(tool.toolName!) : false);
    if (tool.destructive) return false;
    if (tool.concurrentSafe === true) return true;
    if (tool.concurrentSafe === false) return false;
    if (readOnly) return true;
    return tool.sideEffectScope === "none";
  }

  private topologicalSort(items: ToolScheduleItem[]): ToolScheduleItem[] {
    const result: ToolScheduleItem[] = [];
    const remaining = new Map(items.map((item) => [item.toolCallId, item]));
    const inDegree = new Map<string, number>();
    const dependents = new Map<ToolCallId, ToolCallId[]>();

    for (const item of items) {
      inDegree.set(item.toolCallId, item.dependencies.length);
    }
    // 原算法每次出队都遍历 remaining；反向索引沿同一 Map 顺序建立，保留重复 ID 的覆盖语义。
    for (const [toolId, item] of remaining) {
      for (const dependency of new Set(item.dependencies)) {
        const tools = dependents.get(dependency);
        if (tools) tools.push(toolId);
        else dependents.set(dependency, [toolId]);
      }
    }

    const queue = items
      .filter((item) => item.dependencies.length === 0)
      .map((item) => item.toolCallId);

    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor]!;
      const item = remaining.get(current);

      if (!item) continue;

      result.push(item);
      remaining.delete(current);

      for (const toolId of dependents.get(current) ?? []) {
        if (!remaining.has(toolId)) continue;
        const newDegree = (inDegree.get(toolId) ?? 0) - 1;
        inDegree.set(toolId, newDegree);
        if (newDegree === 0) {
          queue.push(toolId);
        }
      }
    }

    if (remaining.size > 0) {
      throw createCoreError(
        CoreErrorType.InvalidStateTransition,
        "Circular dependency detected in tool scheduling",
        {
          context: {
            remaining: Array.from(remaining.keys()),
          },
          recoverable: false,
        },
      );
    }

    return result;
  }

  private groupByParallel(items: ToolScheduleItem[]): ToolCallId[][] {
    if (items.length === 0) return [];

    const levels = new Map<ToolCallId, number>();
    const byLevel = new Map<number, ToolScheduleItem[]>();

    for (const item of items) {
      let dependencyLevel = -1;
      for (const dependency of item.dependencies) {
        dependencyLevel = Math.max(dependencyLevel, levels.get(dependency) ?? 0);
      }
      const level = dependencyLevel + 1;
      levels.set(item.toolCallId, level);
      const levelItems = byLevel.get(level) ?? [];
      levelItems.push(item);
      byLevel.set(level, levelItems);
    }

    const groups: ToolCallId[][] = [];
    const sortedLevels = Array.from(byLevel.keys()).sort((a, b) => a - b);

    for (const level of sortedLevels) {
      let parallelGroup: ToolCallId[] = [];

      const flushParallelGroup = () => {
        if (parallelGroup.length === 0) return;
        groups.push(parallelGroup);
        parallelGroup = [];
      };

      for (const item of byLevel.get(level) ?? []) {
        if (item.canRunParallel) {
          // Flush if current group is full
          if (parallelGroup.length >= this.maxConcurrency) {
            flushParallelGroup();
          }
          parallelGroup.push(item.toolCallId);
          continue;
        }

        flushParallelGroup();
        groups.push([item.toolCallId]);
      }

      flushParallelGroup();
    }

    return groups;
  }

  private validateNoCycles(groups: ToolCallId[][]): void {
    for (const group of groups) {
      const groupSet = new Set(group);

      for (const toolId of group) {
        const item = this.itemsMap.get(toolId);
        if (!item) continue;

        for (const dep of item.dependencies) {
          if (groupSet.has(dep)) {
            throw createCoreError(
              CoreErrorType.InvalidStateTransition,
              `Circular dependency detected: ${toolId} depends on ${dep} in same group`,
              {
                context: { toolId, dependency: dep, group },
                recoverable: false,
              },
            );
          }
        }
      }
    }
  }
}

// -----------------------------------------------
// Default instance
// -----------------------------------------------

export const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoRead",
  "TodoWrite",
  "AskUserQuestion",
  "Skill",
]);

export const defaultToolScheduler = new ToolScheduler();
