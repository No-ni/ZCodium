import { getRemoteIdentityConfirmation } from "@/remote-connection-flow/identityConfirmation.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { findPreferredSourceConnectionProfile } from "@/lib/remoteConnectionWizard.js";
import type { RemoteFlowContext } from "./flowContext.js";
export function runFlowEffect7(context: RemoteFlowContext) {
  const {
    open,
    preferredSourceServerId,
    refreshingIntentRef,
    loading,
    connectedSessionId,
    consumedPreferredSourceServerIdRef,
    sourceManagementSnapshot,
    openPreferredSourceDirectory,
  } = context;

  if (
    !open ||
    !preferredSourceServerId ||
    refreshingIntentRef.current !== null ||
    loading ||
    connectedSessionId ||
    consumedPreferredSourceServerIdRef.current === preferredSourceServerId ||
    !sourceManagementSnapshot
  ) {
    return;
  }
  const profile = findPreferredSourceConnectionProfile(
    sourceManagementSnapshot,
    preferredSourceServerId,
  );
  if (!profile) return;

  // Bug 原因：侧栏设备组虽然已知 sourceServerId，弹窗入口过去只接受连接类型，
  // 打开后只能重置到设备首屏。这里一次性消费设备意图，并复用设备卡既有直达目录链路。
  consumedPreferredSourceServerIdRef.current = preferredSourceServerId;
  openPreferredSourceDirectory(profile);
}

export function runResumeBackground(context: RemoteFlowContext) {
  const {
    pendingBackgroundCompletion,
    handleOpenChange,
    entryEpochRef,
    minimizedRef,
    applyOpenState,
    setBackgroundReady,
    setCompletionRunning,
    setError,
    setCurrentStep,
  } = context;

  const finish = pendingBackgroundCompletion.current;
  if (!finish) {
    handleOpenChange(true);
    return;
  }
  const operationEpoch = entryEpochRef.current;
  // 先消费再运行，重复按钮和旧 toast 不能重复恢复。
  pendingBackgroundCompletion.current = null;
  minimizedRef.current = false;
  // 通知继续曾跳过前台通知，资格查询期间原草稿仍可发送；先由原 owner 恢复禁发，再等待 IO。
  applyOpenState(true);
  setBackgroundReady(false);
  setCompletionRunning(true);
  void finish()
    .catch((cause) => {
      // 快照读取也可能延迟失败；取消或换入口后不能用旧错误重新打开弹窗。
      if (entryEpochRef.current !== operationEpoch) return;
      setError(getErrorMessage(cause));
      setCurrentStep("connecting");
      // 显式继续也会等待资格 IO；用户再次收起后，迟到错误只能更新原后台操作。
      if (!minimizedRef.current) applyOpenState(true);
    })
    .finally(() => {
      if (entryEpochRef.current === operationEpoch) setCompletionRunning(false);
    });
}

export function runHandleRetryConnection(context: RemoteFlowContext) {
  const {
    errorCode,
    handleStartPendingRemoteConnection,
    sourceManagementSnapshot,
    pendingRemoteTarget,
    preferredProfileId,
    sourceManagement,
    entryEpochRef,
    identityAdmissionRef,
    sourceManagementRef,
    setIdentityLoading,
    applySourceManagementSnapshot,
    setError,
  } = context;

  if (errorCode !== "source-server-identity-change-pending") {
    handleStartPendingRemoteConnection();
    return;
  }
  const confirmation = getRemoteIdentityConfirmation(
    sourceManagementSnapshot,
    pendingRemoteTarget,
    preferredProfileId,
  );
  if (!confirmation || !sourceManagement) return;
  const management = sourceManagement;
  const epoch = entryEpochRef.current;
  // React disabled 提交前也必须同步占位，双击不能产生两次身份确认。
  if (
    identityAdmissionRef.current?.epoch === epoch &&
    identityAdmissionRef.current.management === management
  )
    return;
  const admission = { epoch, management };
  identityAdmissionRef.current = admission;
  const isCurrent = () =>
    entryEpochRef.current === epoch &&
    sourceManagementRef.current === management &&
    identityAdmissionRef.current === admission;
  void (async () => {
    if (!isCurrent()) return;
    setIdentityLoading(true);
    try {
      const snapshot = await management.confirmIdentityChange(confirmation);
      if (!isCurrent()) return;
      applySourceManagementSnapshot(snapshot);
      setIdentityLoading(false);
      handleStartPendingRemoteConnection();
    } catch (cause) {
      if (isCurrent()) setError(getErrorMessage(cause));
    } finally {
      // 旧 manager 的失败/finally 无权发布当前 UI 或清理新操作。
      if (isCurrent()) setIdentityLoading(false);
      if (identityAdmissionRef.current === admission) identityAdmissionRef.current = null;
    }
  })();
}
