/* eslint-disable max-lines -- 设置同步流程聚合了发现、选择与导入状态机，集中维护更利于问题定位 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SettingsSyncCategory,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
  SettingsSyncSelection,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import type { SettingsSyncUiState, SettingsSyncUiTask } from "@/settings-sync/types.js";

const IMPORTING_TASK_DELAY_MS = 320;
const FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH = false;

/** 首启自动检测与设置页手动重开对“空 discovery”的处理不同。 */
type LoadDiscoveryIntent = "firstRun" | "manual";

function createInitialState(): SettingsSyncUiState {
  return {
    open: false,
    loading: false,
    importing: false,
    step: "selection",
    discovery: null,
    selectedKeys: [],
    tasks: [],
    result: null,
    error: null,
  };
}

function getSelectionKey(agent: string, category: string): string {
  return `${agent}:${category}`;
}

/**
 * 首启 Onboarding 代理设置：仅模型供应商（providers），不展示、不迁移技能与插件。
 */
function visibleCategoriesForOnboarding(): SettingsSyncCategory[] {
  return ["providers"];
}

function normalizeDiscovery(discovery: SettingsSyncDiscoveryResult): SettingsSyncDiscoveryResult {
  return {
    agents: discovery.agents.map((agent) => {
      const categoryMap = new Map(
        agent.categories.map((category) => [category.category, category]),
      );
      const categories = visibleCategoriesForOnboarding().map((category) => {
        const existing = categoryMap.get(category);
        if (existing) {
          return existing;
        }
        return {
          category,
          discoveredCount: 0,
          importableCount: 0,
          selectedByDefault: false,
        };
      });
      return {
        ...agent,
        categories,
      };
    }),
  };
}

function buildDefaultSelectedKeys(discovery: SettingsSyncDiscoveryResult): string[] {
  return discovery.agents.flatMap((agent) =>
    agent.categories
      .filter((category) => category.selectedByDefault && category.discoveredCount > 0)
      .map((category) => getSelectionKey(agent.agent, category.category)),
  );
}

function buildTasks(
  discovery: SettingsSyncDiscoveryResult,
  selectedKeys: string[],
): SettingsSyncUiTask[] {
  const selected = new Set(selectedKeys);
  return discovery.agents.flatMap((agent) =>
    agent.categories
      .filter((category) => selected.has(getSelectionKey(agent.agent, category.category)))
      .map((category) => ({
        id: getSelectionKey(agent.agent, category.category),
        agent: agent.agent,
        category: category.category,
        discoveredCount: category.discoveredCount,
        status: "pending" as const,
      })),
  );
}

function buildStateSelections(selectedKeys: string[]): SettingsSyncSelection[] {
  return selectedKeys.map((key) => {
    const [agent, category] = key.split(":");
    return {
      agent: agent as SettingsSyncSelection["agent"],
      category: category as SettingsSyncSelection["category"],
    };
  });
}

function buildTasksFromSelections(selections: SettingsSyncSelection[]): SettingsSyncUiTask[] {
  return selections.map((selection, index) => ({
    id: `${selection.agent}:${selection.category}:${selection.sourceScope ?? "all"}:${selection.targetScope ?? "auto"}:${index}`,
    agent: selection.agent,
    category: selection.category,
    discoveredCount:
      selection.skillPaths?.length ??
      selection.commandPaths?.length ??
      selection.pluginPaths?.length ??
      selection.mcpServerPaths?.length ??
      1,
    status: "pending" as const,
  }));
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function applyTaskResults(
  tasks: SettingsSyncUiTask[],
  result: SettingsSyncImportResult,
): SettingsSyncUiTask[] {
  const taskResultQueues = new Map<string, SettingsSyncImportResult["taskResults"]>();
  for (const task of result.taskResults) {
    const key = `${task.agent}:${task.category}`;
    taskResultQueues.set(key, [...(taskResultQueues.get(key) ?? []), task]);
  }
  return tasks.map((task) => {
    const matched = taskResultQueues.get(`${task.agent}:${task.category}`)?.shift();
    return matched ? { ...task, status: matched.status } : { ...task, status: "skipped" };
  });
}

export function useSettingsSync(params: { workspacePath?: string; workspaceIdentity?: string }) {
  const { settingsSyncService } = useServices();
  const zcodeSessionService = useZCodeSessionService(
    params.workspacePath,
    undefined,
    params.workspaceIdentity,
  );
  const runningImportRef = useRef(0);
  const [state, setState] = useState<SettingsSyncUiState>(createInitialState);

  const loadDiscovery = useCallback(
    // Bugfix: 首启 effect 的取消边界原先只覆盖 getFirstRunPromptState 一个 await，随后
    // `await loadDiscovery()` 把边界关在了函数外。detect 在途时切换 workspace（path 或
    // identity 变化）或卸载，旧 scope 的回包会继续提交：非空回包用旧 agents 打开引导弹窗、
    // 空回包调用 app 级 markFirstRunPromptHandled 吞掉新 workspace 的首启提示、失败回包用
    // 旧错误打开弹窗，且旧回包可覆盖新回包。这里增加可选陈旧闸门 isStale（由首启 effect
    // 传入自己的 cancelled），在每个 await 之后复查；不新增状态、pending 队列或第二事实源。
    async (intent: LoadDiscoveryIntent = "firstRun", isStale?: () => boolean) => {
      if (!params.workspacePath) {
        return;
      }
      if (isStale?.()) {
        return;
      }

      setState((current) => ({
        ...current,
        loading: true,
        error: null,
      }));

      try {
        const rawDiscovery = await settingsSyncService.detect({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        });
        // detect 回包可能属于已切换/已卸载的旧 scope：先复查闸门再使用结果。
        if (isStale?.()) {
          return;
        }
        const discovery = normalizeDiscovery(rawDiscovery);
        if (discovery.agents.length === 0) {
          if (intent === "manual") {
            // 设置页点「引导」会 reopen 并补跑 detect；空结果沿用首启逻辑会把 open 重置为 false，
            // 用户会看到弹窗一闪即关。手动打开应保留欢迎页，让用户仍可走会话迁移等流程。
            setState((current) => ({
              ...current,
              open: true,
              loading: false,
              step: "selection",
              discovery,
              selectedKeys: [],
              tasks: [],
              result: null,
              error: null,
            }));
            logger.info("[settings-sync] discovery empty, keep onboarding open (manual)", {
              workspacePath: params.workspacePath,
            });
            return;
          }
          // 去掉三方 agent 迁移后，首启检测会返回空结果。
          // 空结果不应打开一个没有可操作项的 onboarding 弹窗，应直接标记为已处理。
          // markFirstRunPromptHandled 是 app 级持久化写（无 scope 参数）：旧 scope 的空回包
          // 不得替新 scope 把首启提示标记为已处理，否则新 workspace 的引导被静默吞掉。
          if (isStale?.()) {
            return;
          }
          await settingsSyncService.markFirstRunPromptHandled();
          // mark 在途期间又发生切换/卸载：已发出的 mark 不倒退，但不得用旧回包重置新 scope
          // 的引导状态。
          if (isStale?.()) {
            return;
          }
          setState(createInitialState());
          logger.info("[settings-sync] discovery empty, prompt handled", {
            workspacePath: params.workspacePath,
          });
          return;
        }
        const selectedKeys = buildDefaultSelectedKeys(discovery);
        setState((current) => ({
          ...current,
          open: true,
          loading: false,
          step: "selection",
          discovery,
          selectedKeys,
          tasks: [],
          result: null,
          error: null,
        }));
        logger.info("[settings-sync] discovery loaded", {
          workspacePath: params.workspacePath,
          agentCount: discovery.agents.length,
          selectedCount: selectedKeys.length,
        });
      } catch (error) {
        // 旧 scope 的失败回包既不得打开错误态弹窗，也不得被记录为新 scope 的失败。
        if (isStale?.()) {
          return;
        }
        const message = normalizeError(error);
        logger.error("[settings-sync] discovery failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        setState((current) => ({
          ...current,
          open: true,
          loading: false,
          error: message,
        }));
      }
    },
    [params.workspaceIdentity, params.workspacePath, settingsSyncService],
  );

  useEffect(() => {
    if (!params.workspacePath) {
      setState(createInitialState());
      return;
    }

    let cancelled = false;

    if (FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH) {
      // 调试开关保持「每次 effect 都重新检测」的语义，但同样受 cleanup 取消边界约束，
      // 切换/卸载后旧 detect 回包不得提交。这里必须返回 cleanup：否则 cancelled 永远为
      // false，传入的 () => cancelled 闸门永久失效，旧 detect 回包仍可覆盖新 scope。
      void loadDiscovery("firstRun", () => cancelled);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        // onboarding 弹窗是“首启提示”，不是普通刷新提示。
        // 之前调试阶段直接每次进入 workspace 都弹，用户一旦跳过仍会被重复打断。
        // 这里先读取 handled 状态，只在第一次尚未消费时才继续做检测和展示。
        const promptState = await settingsSyncService.getFirstRunPromptState();
        if (cancelled) {
          return;
        }

        if (promptState.handled) {
          setState(createInitialState());
          return;
        }

        // 取消边界必须贯穿 loadDiscovery 的全部 await 之后：detect 在途时切换 workspace
        // 或卸载，旧 scope 的回包不得提交状态，也不得触发 app 级首启标记。
        await loadDiscovery("firstRun", () => cancelled);
      } catch (error) {
        const message = normalizeError(error);
        logger.error("[settings-sync] first run prompt state failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        if (cancelled) {
          return;
        }

        setState((current) => ({
          ...current,
          open: true,
          loading: false,
          error: message,
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadDiscovery, params.workspacePath, settingsSyncService]);

  const selectedCount = state.selectedKeys.length;
  const taskProgress = useMemo(() => {
    if (state.tasks.length === 0) return 0;
    const completedCount = state.tasks.filter(
      (task) => task.status !== "pending" && task.status !== "running",
    ).length;
    return Math.round((completedCount / state.tasks.length) * 100);
  }, [state.tasks]);

  const close = useCallback(() => {
    runningImportRef.current += 1;
    setState((current) => ({ ...current, open: false, importing: false }));
    if (FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH) {
      return;
    }
    // “关闭 onboarding”本身就表示用户已经处理过这次首启提示，
    // 无论是直接开始还是跳过迁移，都应该立刻落库，避免下次启动再次重复弹出。
    void settingsSyncService.markFirstRunPromptHandled().catch((error) => {
      logger.error("[settings-sync] mark first run prompt handled failed", {
        workspacePath: params.workspacePath,
        error: normalizeError(error),
      });
    });
  }, [params.workspacePath, settingsSyncService]);

  const reopen = useCallback(() => {
    setState((current) => {
      if (!current.discovery && !current.loading && params.workspacePath) {
        // 设置页里的“重新打开 onboarding”可能发生在首启提示已处理之后。
        // 这时本地状态已经回到初始态；如果只把 open 设成 true，用户会看到一个没有 discovery 数据的空弹窗。
        // 这里在缺少数据时主动补一次检测，保证从设置页进入仍然能拿到完整可迁移内容。
        void loadDiscovery("manual");
      }
      return { ...current, open: true };
    });
  }, [loadDiscovery, params.workspacePath]);

  const toggleSelection = useCallback((key: string) => {
    setState((current) => {
      const set = new Set(current.selectedKeys);
      if (set.has(key)) {
        set.delete(key);
      } else {
        set.add(key);
      }
      return {
        ...current,
        selectedKeys: [...set],
      };
    });
  }, []);

  const setAgentSelection = useCallback((agent: string, checked: boolean) => {
    setState((current) => {
      if (!current.discovery) {
        return current;
      }
      const next = new Set(current.selectedKeys);
      const targetAgent = current.discovery.agents.find((item) => item.agent === agent);
      if (!targetAgent) {
        return current;
      }
      for (const category of targetAgent.categories) {
        const key = getSelectionKey(agent, category.category);
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return {
        ...current,
        selectedKeys: [...next],
      };
    });
  }, []);

  const setCategorySelectionAllAgents = useCallback(
    (category: SettingsSyncCategory, checked: boolean) => {
      setState((current) => {
        if (!current.discovery) {
          return current;
        }
        const next = new Set(current.selectedKeys);
        for (const agentSummary of current.discovery.agents) {
          if (!agentSummary.categories.some((c) => c.category === category)) {
            continue;
          }
          const key = getSelectionKey(agentSummary.agent, category);
          if (checked) {
            next.add(key);
          } else {
            next.delete(key);
          }
        }
        return {
          ...current,
          selectedKeys: [...next],
        };
      });
    },
    [],
  );

  const startImportWithAdditionalSelections = useCallback(
    async (
      additionalSelections: SettingsSyncSelection[] = [],
      options: { includeCurrentSelections?: boolean } = {},
    ) => {
      if (!params.workspacePath) {
        return;
      }

      const includeCurrentSelections = options.includeCurrentSelections ?? true;
      // 数据迁移向导可临时隐藏代理设置步骤；隐藏时不能把默认选中的 providers 暗中导入。
      const stateSelections =
        includeCurrentSelections && state.discovery ? buildStateSelections(state.selectedKeys) : [];
      const selections: SettingsSyncSelection[] = [...stateSelections, ...additionalSelections];
      if (selections.length === 0) {
        return;
      }
      const runId = runningImportRef.current + 1;
      runningImportRef.current = runId;
      const initialTasks =
        state.discovery && includeCurrentSelections
          ? [
              ...buildTasks(state.discovery, state.selectedKeys),
              ...buildTasksFromSelections(additionalSelections),
            ]
          : buildTasksFromSelections(selections);

      setState((current) => ({
        ...current,
        importing: true,
        step: "importing",
        tasks: initialTasks,
        result: null,
        error: null,
      }));

      logger.info("[settings-sync] import started", {
        workspacePath: params.workspacePath,
        selections,
      });

      const importPromise = settingsSyncService.importSelected({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        selections,
      });

      for (let index = 0; index < initialTasks.length; index += 1) {
        if (runningImportRef.current !== runId) {
          return;
        }
        const task = initialTasks[index];
        if (!task) {
          continue;
        }
        setState((current) => ({
          ...current,
          tasks: current.tasks.map((item) =>
            item.id === task.id ? { ...item, status: "running" } : item,
          ),
        }));
        await new Promise((resolve) => setTimeout(resolve, IMPORTING_TASK_DELAY_MS));
      }

      try {
        const result = await importPromise;
        if (runningImportRef.current !== runId) {
          return;
        }

        if (selections.some((selection) => selection.category === "skills")) {
          await invalidateDeferredDraftSessionForSkillChange({
            zcodeSessionService,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            reason: "settings-sync-skill-import",
          });
        }

        setState((current) => ({
          ...current,
          importing: false,
          step: "complete",
          result,
          tasks: applyTaskResults(current.tasks, result),
        }));
        logger.info("[settings-sync] import completed", {
          workspacePath: params.workspacePath,
          result,
        });
      } catch (error) {
        const message = normalizeError(error);
        if (runningImportRef.current !== runId) {
          return;
        }
        logger.error("[settings-sync] import failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        setState((current) => ({
          ...current,
          importing: false,
          step: "complete",
          error: message,
          tasks: current.tasks.map((task) => ({ ...task, status: "failed" })),
          result: {
            successCount: 0,
            skippedCount: 0,
            failedCount: current.tasks.length,
            taskResults: current.tasks.map((task) => ({
              agent: task.agent,
              category: task.category,
              status: "failed" as const,
              importedCount: 0,
              skippedCount: 0,
              failedCount: 1,
            })),
          },
        }));
      }
    },
    [
      params.workspaceIdentity,
      params.workspacePath,
      settingsSyncService,
      zcodeSessionService,
      state.discovery,
      state.selectedKeys,
    ],
  );

  const startImport = useCallback(async () => {
    await startImportWithAdditionalSelections();
  }, [startImportWithAdditionalSelections]);

  const finish = useCallback(() => {
    close();
  }, [close]);

  return {
    state,
    selectedCount,
    taskProgress,
    actions: {
      close,
      reopen,
      reloadDiscovery: loadDiscovery,
      toggleSelection,
      setAgentSelection,
      setCategorySelectionAllAgents,
      startImport,
      startImportWithAdditionalSelections,
      finish,
    },
  };
}
