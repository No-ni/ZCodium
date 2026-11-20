import { useTuiApplyResult } from "./app-result.js";
import { useSessionEventApplier } from "./app-session-event-handler.js";
import type { useTuiProjectionState } from "./app-projection-state.js";
import type { TuiOptions } from "./types.js";
type ResultInput = Parameters<typeof useTuiApplyResult>[0];
type EventInput = Parameters<typeof useSessionEventApplier>[0];
/** 同一次挂载的投影 setter、去重 applier 和提交回调，不创建第二份 runtime 状态。 */
export function useTuiRuntimeBindings(
  projection: ReturnType<typeof useTuiProjectionState>,
  options: TuiOptions,
  input: Pick<ResultInput, "modifiedFileToolCallIds" | "setEffortOptions" | "setModelOptions"> &
    Pick<
      EventInput,
      | "observeSessionEvent"
      | "setWorkflowMirror"
      | "assistantMessageIdsByToolCallId"
      | "toolNamesById"
    >,
) {
  const {
    locale,
    modelSetupRequired,
    mode,
    model,
    copy,
    setActiveTurnId,
    setCacheStats,
    setContextUsage,
    setLastEvent,
    setLiveModelText,
    setLocale,
    setModelSetupRequired,
    setMessages,
    setMode,
    setModel,
    setModifiedFiles,
    setNetworkRequests,
    setQueuedInputs,
    setSelection,
    setStatus,
    setThoughtLevel,
    setTodos,
    setTraceId,
    setUsage,
    setLastError,
  } = projection;
  const applyResult = useTuiApplyResult({
    fallback: { locale, modelSetupRequired, mode, model },
    modifiedFileToolCallIds: input.modifiedFileToolCallIds,
    setActiveTurnId,
    setCacheStats,
    setContextUsage,
    setEffortOptions: input.setEffortOptions,
    setLastEvent,
    setLiveModelText,
    setLocale,
    setModelSetupRequired,
    setMessages,
    setMode,
    setModel,
    setModelOptions: input.setModelOptions,
    setModifiedFiles,
    setNetworkRequests,
    setQueuedInputs,
    setSelection,
    setStatus,
    setThoughtLevel,
    setTodos,
    setTraceId,
    setUsage,
    workspaceDirectory: options.workspaceDirectory,
  });

  const applySessionEvent = useSessionEventApplier({
    subscribeSessionEvents: options.subscribeSessionEvents,
    observeSessionEvent: input.observeSessionEvent,
    copy: copy.tui,
    getMainSessionId: options.getMainSessionId,
    setActiveTurnId,
    setCacheStats,
    setContextUsage,
    setLastError,
    setLastEvent,
    setLiveModelText,
    setMessages,
    setModel,
    setThoughtLevel,
    setModifiedFiles,
    setNetworkRequests,
    setQueuedInputs,
    setStatus,
    setTodos,
    setUsage,
    setWorkflowMirror: input.setWorkflowMirror,
    assistantMessageIdsByToolCallId: input.assistantMessageIdsByToolCallId,
    modifiedFileToolCallIds: input.modifiedFileToolCallIds,
    toolNamesById: input.toolNamesById,
    workspaceDirectory: options.workspaceDirectory,
  });

  return { applyResult, applySessionEvent };
}
