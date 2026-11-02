import { toast } from "@/components/ui/toast.js";
import {
  createUuid,
  REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE,
  type RemoteTarget,
} from "@zcode/shared";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { withDefaultRemoteResourcePackages } from "@/lib/remoteConnectionWizard.js";
import { getRemoteConnectionCompletionDialogState } from "@/lib/remoteConnectionDialogState.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import type { RemoteFlowContext } from "./flowContext.js";
import type { RemoteConnectionCompletionIntent } from "./completionIntent.js";
export async function runStartRemoteConnection(
  context: RemoteFlowContext,
  target: RemoteTarget,
  preferredDirectoryPath?: string,
  options?: RemoteConnectionCompletionIntent["options"],
) {
  const {
    activeRequestIdRef,
    entryEpochRef,
    setDirectoryPath,
    pendingCompletionIntentRef,
    setWorkspaceStepPath,
    resolveWorkspaceStepPath,
    updatePendingRemoteTarget,
    setLoading,
    updateConnectingRequestId,
    resetFeedback,
    resetConnectionLogs,
    setCurrentStep,
    onConnect,
    handleCancelSession,
    setRecognizedSourceServerId,
    sourceManagement,
    applySourceManagementSnapshot,
    setRecognizedDeviceName,
    ownsConnectedSessionRef,
    completion,
    setConnectedSessionId,
    minimizedRef,
    acknowledgeBoundary,
    setBlockedCompletion,
    onDeviceConnected,
    closeDialog,
    onConnectionReady,
    appendConnectionLog,
    onSelectProject,
    localWorkspacePath,
    applyOpenState,
    onProjectIntentCleared,
    setCancelled,
    setErrorCode,
    setRawError,
    setError,
    intl,
    pendingBackgroundCompletion,
    setBackgroundReady,
    openIntentId,
    resumeBackground,
  } = context;

  const nextTarget = withDefaultRemoteResourcePackages(target);

  if (activeRequestIdRef.current) {
    // Bugfix: React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
    // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
    return;
  }

  const operationEpoch = ++entryEpochRef.current;
  setDirectoryPath("");
  pendingCompletionIntentRef.current = {
    preferredDirectoryPath,
    options,
  };
  setWorkspaceStepPath(resolveWorkspaceStepPath(preferredDirectoryPath));

  updatePendingRemoteTarget(nextTarget);
  setLoading(true);
  const sessionsAtStart = new Set(
    Object.keys(useRemoteWorkspaceSessionStore.getState().sessionsById),
  );
  const requestId = createUuid();
  updateConnectingRequestId(requestId);
  resetFeedback();
  resetConnectionLogs();
  setCurrentStep("connecting");
  try {
    // 本仓仅连接用户预部署服务；版本或安装失败由普通错误路径展示，不下发安装授权。
    const sessionId = options?.announceReusedConnection
      ? await onConnect(nextTarget, requestId, undefined, { announceReusedConnection: true })
      : await onConnect(nextTarget, requestId);
    // 取消/关闭先撤销请求归属；迟到结果只释放临时 session，不能复活旧流程。
    const discardStaleResult = () => {
      if (activeRequestIdRef.current === requestId) return false;
      if (!sessionsAtStart.has(sessionId)) void handleCancelSession(sessionId);
      return true;
    };
    if (discardStaleResult()) return;
    const connectedSourceServerId =
      useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId]?.sourceServerId;
    // 识别时刻由连接结果驱动：directory-record 完成后 session 才携带 sourceServerId，
    // 此时展示「已识别为现有设备」并刷新快照，确保新识别设备的名称与目录历史立即可用。
    if (connectedSourceServerId) {
      setRecognizedSourceServerId(connectedSourceServerId);
      try {
        const nextSnapshot = await sourceManagement?.getSnapshot();
        if (discardStaleResult()) return;
        if (nextSnapshot) {
          // 经统一 hook 的 generation 判序入口写入，防止旧快照后至覆盖新内容。
          applySourceManagementSnapshot(nextSnapshot);
          setRecognizedDeviceName(
            nextSnapshot.directory.servers.find(
              (server) => server.sourceServerId === connectedSourceServerId,
            )?.displayName,
          );
        }
      } catch {
        // 设备名仅用于展示；快照读取失败时保留连接结果，不打断流程。
      }
    }
    if (discardStaleResult()) return;
    // 后台只保留本次意图的完成动作；不能在网络结果到达时恢复旧页面。
    // 设备管理只需 Source 身份，立即释放本次独占 attachment。
    ownsConnectedSessionRef.current =
      completion !== "device-management" && !sessionsAtStart.has(sessionId);
    if (completion === "device-management" && !sessionsAtStart.has(sessionId)) {
      await handleCancelSession(sessionId);
      if (discardStaleResult()) return;
    }
    setConnectedSessionId(completion === "device-management" ? null : sessionId);
    const finishConnection = async () => {
      const isCurrent = () => entryEpochRef.current === operationEpoch;
      if (!isCurrent()) return;
      if (minimizedRef.current) {
        deferCompletion();
        return;
      }
      // 读取/保存介绍也会跨过收起事件；前台权限必须与 epoch 一起在 await 后重验。
      const acknowledged =
        !connectedSourceServerId ||
        (await acknowledgeBoundary(
          () => isCurrent() && !minimizedRef.current,
          () => setBlockedCompletion(() => finishConnection),
        ));
      if (!isCurrent()) return;
      if (minimizedRef.current) {
        deferCompletion();
        return;
      }
      if (!acknowledged) return;
      if (completion === "device-management") {
        // 设备管理没有目录/项目副作用；只回收本次独占的临时 attachment，物理连接仍由 Source owner 保持。
        // 聊天返回仍需校验成员资格；必须等完成方确认，失败沿用本 flow 的错误和重试边界。
        await onDeviceConnected?.(
          connectedSourceServerId,
          () => isCurrent() && !minimizedRef.current,
        );
        if (!isCurrent()) return;
        if (minimizedRef.current) {
          deferCompletion();
          return;
        }
        closeDialog({ preserveSession: true });
        return;
      }
      if (onConnectionReady) {
        await onConnectionReady(sessionId);
        if (entryEpochRef.current !== operationEpoch) return;
        return;
      }
      if (preferredDirectoryPath?.trim()) {
        // 目录提交开始后由项目 owner 接管 attachment；取消 UI 不能回收可能已提交成功的会话。
        // 失败仍由下面的 catch 回收或恢复目录选择，介绍等待阶段的取消则由 flow 负责。
        setConnectedSessionId(null);
        // bind 不带连接日志；由 flow 记下“打开项目目录”这一步，连接屏据此显示进行中与失败。
        appendConnectionLog(
          "info",
          `[source-server:workspace] Preparing ${preferredDirectoryPath}`,
        );
        try {
          await onSelectProject(
            sessionId,
            preferredDirectoryPath,
            options?.localWorkspacePath ?? localWorkspacePath,
          );
          if (entryEpochRef.current !== operationEpoch) return;
          pendingCompletionIntentRef.current = {};
          minimizedRef.current = false;
          setDirectoryPath("");
          resetConnectionLogs();
          setCurrentStep("device");
          setConnectedSessionId(null);
          updatePendingRemoteTarget(null);
          setRecognizedDeviceName(undefined);
          updateConnectingRequestId(null);
          applyOpenState(false);
          return;
        } catch (selectionError) {
          if (entryEpochRef.current !== operationEpoch) {
            if (!sessionsAtStart.has(sessionId)) void handleCancelSession(sessionId);
            return;
          }
          if (
            selectionError &&
            typeof selectionError === "object" &&
            "code" in selectionError &&
            selectionError.code === "remote-connection-canceled"
          ) {
            // 成员移除属于意图取消，不是可改目录的 IO 错误；只回收本次新建的 attachment。
            if (!sessionsAtStart.has(sessionId)) await handleCancelSession(sessionId);
            if (entryEpochRef.current !== operationEpoch) return;
            pendingCompletionIntentRef.current = {};
            onProjectIntentCleared?.();
            resetFeedback();
            setCancelled(true);
            return;
          }
          const selectionCode =
            selectionError && typeof selectionError === "object" && "code" in selectionError
              ? String(selectionError.code)
              : undefined;
          if (selectionCode === REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE) {
            // Bug 原因（R8）：远端读目录卡住时，目录浏览器也会读同一台机器的目录，退回浏览器只会
            // 换个地方继续卡。留在连接屏，把“打开项目目录”标为失败并提供重试；本次临时
            // attachment 交还，重试会重新连接并再次打开同一目录。
            appendConnectionLog(
              "error",
              `[source-server:workspace] ${getErrorMessage(selectionError)}`,
            );
            if (!sessionsAtStart.has(sessionId)) await handleCancelSession(sessionId);
            if (entryEpochRef.current !== operationEpoch) return;
            setErrorCode(selectionCode);
            setRawError(getErrorMessage(selectionError));
            setError(
              formatRemoteConnectionError({
                fallback: getErrorMessage(selectionError),
                reasonCode: selectionCode,
                formatMessage: intl.formatMessage,
              }),
            );
            return;
          }
          // 历史目录可能已被删除或权限变化；保留连接并回退目录浏览器，不能把快速入口变成死路。
          setError(getErrorMessage(selectionError));
        }
      }
      const completionState = getRemoteConnectionCompletionDialogState("success", {
        directToDirectory: true,
      });
      setConnectedSessionId(sessionId);
      setCurrentStep(completionState.step);
      minimizedRef.current = false;
      applyOpenState(completionState.open);
    };
    const deferCompletion = () => {
      setConnectedSessionId(completion === "device-management" ? null : sessionId);
      const continueConnection = async () => {
        if (connectedSourceServerId && sourceManagement) {
          const latest = await sourceManagement.getSnapshot();
          if (entryEpochRef.current !== operationEpoch) return;
          applySourceManagementSnapshot(latest);
          if (
            !latest.directory.servers.some(
              (server) => server.sourceServerId === connectedSourceServerId,
            ) ||
            !latest.states.some(
              (state) =>
                state.sourceServerId === connectedSourceServerId && state.state === "online",
            )
          ) {
            if (completion !== "device-management" && !sessionsAtStart.has(sessionId))
              await handleCancelSession(sessionId);
            if (entryEpochRef.current !== operationEpoch) return;
            setConnectedSessionId(null);
            minimizedRef.current = true;
            setError(intl.formatMessage({ id: "project.connectionUnavailable" }));
            return;
          }
        }
        await finishConnection();
      };
      pendingBackgroundCompletion.current = continueConnection;
      setBackgroundReady(true);
      toast(intl.formatMessage({ id: "remote.background.ready" }), {
        variant: "info",
        dismissible: true,
        dismissLabel: intl.formatMessage({ id: "common.close" }),
        dedupeKey: `remote-connection:${openIntentId ?? 0}:${operationEpoch}`,
        actionLabel: intl.formatMessage({ id: "remote.background.continue" }),
        onAction: () => {
          if (
            entryEpochRef.current !== operationEpoch ||
            pendingBackgroundCompletion.current !== continueConnection
          )
            return;
          resumeBackground();
        },
      });
    };
    await finishConnection();
  } catch (connectError) {
    if (activeRequestIdRef.current !== requestId) return;
    if (
      connectError &&
      typeof connectError === "object" &&
      "code" in connectError &&
      connectError.code === "remote-connection-canceled"
    ) {
      resetFeedback();
      setCancelled(true);
      return;
    }
    const completionState = getRemoteConnectionCompletionDialogState("error");
    const failure = connectError as {
      code?: unknown;
      retryable?: unknown;
      profileId?: unknown;
      resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
    };
    const reasonCode = typeof failure.code === "string" ? failure.code : undefined;
    const errorMessage = formatRemoteConnectionError({
      fallback: getErrorMessage(connectError),
      reasonCode,
      retryable: typeof failure.retryable === "boolean" ? failure.retryable : undefined,
      formatMessage: intl.formatMessage,
    });
    setErrorCode(reasonCode);
    setRawError(getErrorMessage(connectError));
    setError(errorMessage);
    setCurrentStep(completionState.step);
    if (!minimizedRef.current) applyOpenState(completionState.open);
  } finally {
    // 成功恢复原目录会先清空 requestId；仍属同一流程时必须结束 busy，取消/重试则由新 epoch 接管。
    if (entryEpochRef.current === operationEpoch) {
      activeRequestIdRef.current = null;
      setLoading(false);
    }
  }
}
