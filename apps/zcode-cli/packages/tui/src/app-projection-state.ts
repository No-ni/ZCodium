import type { ModelUsageSummary, TodoItem, TurnId } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import { useMemo, useState } from "react";
import { appendAgentResult } from "./app-submit.js";
import { createSelectionState } from "./app-selection-state.js";
import type {
  CacheStats,
  ContextUsage,
  DraftAttachment,
  Message,
  ModifiedFileStat,
  NetworkRequest,
  QueuedInput,
  SelectionState,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiOptions } from "./types.js";
/** TUI 投影仍由同一挂载实例持有；这里只移动原初始化，不创建第二份状态。 */
export function useTuiProjectionState(options: TuiOptions) {
  // Startup sentinels are diagnostics, not user-visible transcript messages.
  const initialResult = options.initialResult;
  const [messages, setMessages] = useState<Message[]>(() =>
    initialResult
      ? appendAgentResult([], initialResult, { workspaceDirectory: options.workspaceDirectory })
      : [],
  );
  const [draft, setDraftState] = useState("");
  const [, setDraftAttachmentsState] = useState<DraftAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(initialResult?.mode ?? options.initialMode ?? "build");
  const [model, setModel] = useState(initialResult?.model ?? options.initialModel ?? "unknown");
  const [thoughtLevel, setThoughtLevel] = useState(
    initialResult?.thoughtLevel ?? options.initialThoughtLevel ?? "",
  );
  const [locale, setLocale] = useState(options.locale ?? "en-US");
  const [lastEvent, setLastEvent] = useState("idle");
  const [lastError, setLastError] = useState<string | undefined>();
  const copy = useMemo(() => getZCodeCopy(locale), [locale]);
  const [modelSetupRequired, setModelSetupRequired] = useState(
    initialResult?.modelSetupRequired ?? options.modelSetupRequired ?? false,
  );
  const [status, setStatus] = useState(
    initialResult?.selection?.prompt ??
      (modelSetupRequired ? copy.tui.modelSetupRequired.status : copy.tui.status.ready),
  );
  const [statusDetails, setStatusDetails] = useState<string[]>([]);
  const [traceId, setTraceId] = useState<string | undefined>();
  const [activeTurnId, setActiveTurnId] = useState<TurnId | undefined>();
  const [contextUsage, setContextUsage] = useState<ContextUsage>({});
  const [cacheStats, setCacheStats] = useState<CacheStats | undefined>();
  const [usage, setUsage] = useState<ModelUsageSummary | undefined>();
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [modifiedFiles, setModifiedFiles] = useState<ModifiedFileStat[]>([]);
  const [liveModelText, setLiveModelText] = useState("");
  const [queuedInputs, setQueuedInputs] = useState<QueuedInput[]>([]);
  const [selection, setSelection] = useState<SelectionState | undefined>(() =>
    createSelectionState(initialResult?.selection),
  );
  const [slashSelection, setSlashSelection] = useState<SlashSelectionState | undefined>();
  const [inputCursorToEndVersion, setInputCursorToEndVersion] = useState(0);
  return {
    initialResult,
    copy,
    messages,
    setMessages,
    draft,
    setDraftState,
    setDraftAttachmentsState,
    busy,
    setBusy,
    mode,
    setMode,
    model,
    setModel,
    thoughtLevel,
    setThoughtLevel,
    locale,
    setLocale,
    lastEvent,
    setLastEvent,
    lastError,
    setLastError,
    modelSetupRequired,
    setModelSetupRequired,
    status,
    setStatus,
    statusDetails,
    setStatusDetails,
    traceId,
    setTraceId,
    activeTurnId,
    setActiveTurnId,
    contextUsage,
    setContextUsage,
    cacheStats,
    setCacheStats,
    usage,
    setUsage,
    todos,
    setTodos,
    networkRequests,
    setNetworkRequests,
    modifiedFiles,
    setModifiedFiles,
    liveModelText,
    setLiveModelText,
    queuedInputs,
    setQueuedInputs,
    selection,
    setSelection,
    slashSelection,
    setSlashSelection,
    inputCursorToEndVersion,
    setInputCursorToEndVersion,
  };
}
