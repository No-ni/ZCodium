import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type SourceServerWorkspaceHistoryEntry, type RemoteTarget } from "@zcode/shared";
import { useCancelPendingRemoteConnection } from "@/hooks/useCancelPendingRemoteConnection.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { isRemoteConnectionFlowActive } from "@/lib/remoteConnectionDialogState.js";
import { useRemoteBoundaryAcknowledgement } from "@/RemoteConnectionDialogContent.js";
import { type RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  normalizeRemoteConnectionOptions,
  type RemoteConnectionFlowOptions,
} from "@/remote-connection-flow/contract.js";
import type { RemoteConnectionCompletionIntent } from "./completionIntent.js";
export function useRemoteConnectionFlowState(
  options: RemoteConnectionFlowOptions,
  applyOpenState: (open: boolean) => void,
) {
  const normalizedOptions = normalizeRemoteConnectionOptions(options);
  const {
    completion,
    controlledOpen,
    isWindowsDesktop,
    preferredKind,
    preferredWslDistro,
    preferredSourceServerId,
    preferredProfileId,
    preferredTarget,
    initialFailure,
  } = normalizedOptions;
  const addingDevice =
    completion === "device-management" &&
    !preferredSourceServerId &&
    !preferredProfileId &&
    !preferredTarget;
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const acknowledgeBoundary = useRemoteBoundaryAcknowledgement();
  const cancelPendingRemoteConnection = useCancelPendingRemoteConnection();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const minimizedRef = useRef(false);
  const confirmationPending = useConfirmDialogStore((state) => Boolean(state.pendingRequest));
  const [discardPending, setDiscardPending] = useState(false);
  const [completionRunning, setCompletionRunning] = useState(false);
  const [blockedCompletion, setBlockedCompletion] = useState<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (confirmationPending || discardPending || !blockedCompletion) return;
    // 在关闭确认的 owner 处理完选择后重入，避免确认关闭与完成回调抢跑。
    setBlockedCompletion(null);
    const epoch = entryEpochRef.current;
    setCompletionRunning(true);
    void blockedCompletion()
      .catch((cause) => {
        if (entryEpochRef.current !== epoch) return;
        setError(getErrorMessage(cause));
        setCurrentStep("connecting");
        applyOpenState(true);
      })
      .finally(() => {
        if (entryEpochRef.current === epoch) setCompletionRunning(false);
      });
  }, [confirmationPending, discardPending, blockedCompletion]);
  const pendingBackgroundCompletion = useRef<(() => Promise<void>) | null>(null);
  const [backgroundReady, setBackgroundReady] = useState(false);
  const [aliasCredentialsPending, setAliasCredentialsPending] = useState(false);
  const activeRequestIdRef = useRef<string | null>(null);
  const entryEpochRef = useRef(0);
  const refreshingIntentRef = useRef<number | null>(null);
  const [refreshingIntent, setRefreshingIntent] = useState(false);
  const consumedOpenIntentIdRef = useRef<number | undefined>(undefined);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<string>();
  const [rawError, setRawError] = useState<string>();
  // 0 表示尚未提交；每次提交校验失败递增，表单据此显示内联错误并聚焦第一个出错字段（RDUX-27）。
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [focusCredentials, setFocusCredentials] = useState(false);
  const [directoryPath, setDirectoryPath] = useState("");
  const consumedKindPreferenceRef = useRef<string | null>(null);
  const [step, setCurrentStep] = useState<RemoteWizardStep>("device");
  // Root 常驻挂载，设置入口的首帧也直接展示分类表单，不等待 effect 隐藏旧选择屏。
  const currentStep = addingDevice && step === "device" ? "settings" : step;
  const ownsConnectedSessionRef = useRef(false);
  const [connectedSessionId, setConnectedSessionIdState] = useState<string | null>(null);
  const connectedSessionIdRef = useRef<string | null>(null);
  const setConnectedSessionId = useCallback((sessionId: string | null) => {
    connectedSessionIdRef.current = sessionId;
    setConnectedSessionIdState(sessionId);
  }, []);
  const [connectingRequestId, setConnectingRequestId] = useState<string | null>(null);
  const [pendingRemoteTarget, setPendingRemoteTarget] = useState<RemoteTarget | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [recognizedDeviceName, setRecognizedDeviceName] = useState<string | undefined>();
  const [recognizedSourceServerId, setRecognizedSourceServerId] = useState<string | undefined>();
  const [
    remoteConversationWorkspaceBySourceServerId,
    setRemoteConversationWorkspaceBySourceServerId,
  ] = useState<Record<string, { workspacePath: string; lastResolvedAt: number }>>({});
  /** 当前连接使用的线路名（SSH alias / 线路 displayName）；无名线路由消费方回退 user@host:port。 */
  const [remoteHistory, setRemoteHistory] = useState<SourceServerWorkspaceHistoryEntry[]>([]);
  const [activeProfileName, setActiveProfileName] = useState<string | undefined>();
  const consumedPreferredSourceServerIdRef = useRef<string | null>(null);
  const consumedPreferredProfileIdRef = useRef<string | null>(null);
  const consumedPreferredTargetRef = useRef<RemoteTarget | null>(null);
  const pendingCompletionIntentRef = useRef<RemoteConnectionCompletionIntent>({});
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const selectingDirectoryRef = useRef(false);
  const { connectionLogs, resetConnectionLogs, appendConnectionLog } =
    useRemoteConnectionLogs(connectingRequestId);
  // 连接成功后要打开的项目目录；有值时连接屏多一步“打开项目目录”。
  const [workspaceStepPath, setWorkspaceStepPath] = useState<string>();
  const open = controlledOpen ?? uncontrolledOpen;
  const form = useRemoteConnectionForm({
    open,
    isWindowsDesktop,
    preferredKind,
    preferredWslDistro,
    preserveDraftOnOpen: true,
    discoverAll: !addingDevice,
  });
  const directoryBrowserServices = useRemoteWorkspaceSessionStore((state) =>
    connectedSessionId ? (state.sessionsById[connectedSessionId]?.services ?? null) : null,
  );
  const baseServices = useBaseWorkspaceServices();
  const sourceManagement = baseServices.sourceServerManagementService;
  const sourceManagementRef = useRef(sourceManagement);
  sourceManagementRef.current = sourceManagement;
  const identityAdmissionRef = useRef<{
    epoch: number;
    management: NonNullable<typeof sourceManagement>;
  } | null>(null);
  useEffect(() => {
    if (identityAdmissionRef.current?.management !== sourceManagement) {
      identityAdmissionRef.current = null;
      setIdentityLoading(false);
    }
  }, [sourceManagement]);
  // 管理快照由统一 hook 串行重读，操作回包只触发刷新，不成为第二条状态写入路径。
  const { snapshot: sourceManagementSnapshot, applySnapshot: applySourceManagementSnapshot } =
    useSourceServerManagementSnapshot(sourceManagement, { enabled: open || minimizedRef.current });
  useEffect(() => {
    if (
      !open &&
      currentStep === "device" &&
      !pendingRemoteTarget &&
      !connectedSessionId &&
      !loading
    ) {
      consumedKindPreferenceRef.current = null;
      consumedPreferredSourceServerIdRef.current = null;
      consumedPreferredProfileIdRef.current = null;
    }
  }, [open, currentStep, pendingRemoteTarget, connectedSessionId, loading]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void baseServices.settingService
      .get()
      .then((settings) => {
        if (!disposed) {
          setRemoteHistory(settings.sourceServerWorkspaceHistory ?? []);
          setRemoteConversationWorkspaceBySourceServerId(
            settings.remoteConversationWorkspaceBySourceServerId ?? {},
          );
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [baseServices.settingService, open]);
  const flowSnapshot = useMemo(
    () => ({
      currentStep,
      loading,
      connectedSessionId,
    }),
    [connectedSessionId, currentStep, loading],
  );
  const flowActive =
    isRemoteConnectionFlowActive(flowSnapshot) ||
    identityLoading ||
    Boolean(blockedCompletion) ||
    completionRunning;
  const recognizedServer = useMemo(
    () =>
      recognizedSourceServerId
        ? (sourceManagementSnapshot?.directory.servers.find(
            (server) => server.sourceServerId === recognizedSourceServerId,
          ) ?? null)
        : null,
    [recognizedSourceServerId, sourceManagementSnapshot],
  );
  const visibleConnectionLogs = connectingRequestId
    ? connectionLogs
    : rawError === initialFailure?.message
      ? (initialFailure?.logs ?? [])
      : [];
  const quickOpenDirectoryData = useMemo(
    () => ({
      paths: remoteHistory
        .filter(
          (entry) =>
            recognizedSourceServerId &&
            entry.sourceServerId === recognizedSourceServerId &&
            remoteConversationWorkspaceBySourceServerId[recognizedSourceServerId]?.workspacePath !==
              entry.workspacePath,
        )
        .toSorted((left, right) => right.lastOpenedAt - left.lastOpenedAt)
        .slice(0, 3)
        .map((entry) => ({
          path: entry.workspacePath,
          label: formatTaskRelativeTime(entry.lastOpenedAt, intl),
        })),
      entries: [] as Array<{ path: string; label?: string }>,
    }),
    [intl, recognizedSourceServerId, remoteConversationWorkspaceBySourceServerId, remoteHistory],
  );
  return {
    ...normalizedOptions,
    ...form,
    addingDevice,
    intl,
    confirmDialog,
    acknowledgeBoundary,
    cancelPendingRemoteConnection,
    uncontrolledOpen,
    setUncontrolledOpen,
    loading,
    setLoading,
    minimizedRef,
    confirmationPending,
    discardPending,
    setDiscardPending,
    completionRunning,
    setCompletionRunning,
    blockedCompletion,
    setBlockedCompletion,
    pendingBackgroundCompletion,
    backgroundReady,
    setBackgroundReady,
    aliasCredentialsPending,
    setAliasCredentialsPending,
    activeRequestIdRef,
    entryEpochRef,
    refreshingIntentRef,
    refreshingIntent,
    setRefreshingIntent,
    consumedOpenIntentIdRef,
    cancelled,
    setCancelled,
    error,
    setError,
    errorCode,
    setErrorCode,
    rawError,
    setRawError,
    validationAttempt,
    setValidationAttempt,
    focusCredentials,
    setFocusCredentials,
    directoryPath,
    setDirectoryPath,
    consumedKindPreferenceRef,
    step,
    setCurrentStep,
    currentStep,
    ownsConnectedSessionRef,
    connectedSessionId,
    setConnectedSessionIdState,
    connectedSessionIdRef,
    setConnectedSessionId,
    connectingRequestId,
    setConnectingRequestId,
    pendingRemoteTarget,
    setPendingRemoteTarget,
    identityLoading,
    setIdentityLoading,
    recognizedDeviceName,
    setRecognizedDeviceName,
    recognizedSourceServerId,
    setRecognizedSourceServerId,
    remoteConversationWorkspaceBySourceServerId,
    setRemoteConversationWorkspaceBySourceServerId,
    remoteHistory,
    setRemoteHistory,
    activeProfileName,
    setActiveProfileName,
    consumedPreferredSourceServerIdRef,
    consumedPreferredProfileIdRef,
    consumedPreferredTargetRef,
    pendingCompletionIntentRef,
    selectingDirectory,
    setSelectingDirectory,
    selectingDirectoryRef,
    connectionLogs,
    resetConnectionLogs,
    appendConnectionLog,
    workspaceStepPath,
    setWorkspaceStepPath,
    open,
    directoryBrowserServices,
    baseServices,
    sourceManagement,
    sourceManagementRef,
    identityAdmissionRef,
    sourceManagementSnapshot,
    applySourceManagementSnapshot,
    flowSnapshot,
    flowActive,
    recognizedServer,
    visibleConnectionLogs,
    quickOpenDirectoryData,
  };
}
export type RemoteFlowState = ReturnType<typeof useRemoteConnectionFlowState>;
