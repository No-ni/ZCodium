import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { profileMatchesRemoteTarget } from "@/lib/remoteConnectionWizard.js";
import { type ConnectionProfile, type RemoteTarget } from "@zcode/shared";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { buildRemoteTargetFromProfile } from "@/lib/remoteConnectionWizard.js";
import { loadConnectionProfileCredentials } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import type { RemoteFlowContext } from "./flowContext.js";
export function runHandleSelectProfile(
  context: RemoteFlowContext,
  profile: ConnectionProfile,
  preferredDirectoryPath?: string,
  selectOptions?: {
    initialFailure?: RemoteConnectionOpenPreference["initialFailure"];
    directToDirectory?: boolean;
    localWorkspacePath?: string;
  },
) {
  const {
    entryEpochRef,
    resetFeedback,
    pendingCompletionIntentRef,
    setWorkspaceStepPath,
    resolveWorkspaceStepPath,
    setDirectoryPath,
    setActiveProfileName,
    setRecognizedSourceServerId,
    setRecognizedDeviceName,
    sourceManagementSnapshot,
    setCurrentStep,
    acceptInitialFailure,
    setKind,
    baseServices,
    updatePendingRemoteTarget,
    setPassword,
    setPrivateKeyPassphrase,
    setServerToken,
    setHost,
    setPort,
    setUsername,
    setPrivateKeyPath,
    setSshAuthMethod,
    setErrorCode,
    setError,
    intl,
    startRemoteConnection,
  } = context;

  const entryEpoch = ++entryEpochRef.current;
  resetFeedback();
  // 凭据缺失时也保留目录意图，不能等真正拨号才记录。
  pendingCompletionIntentRef.current = { preferredDirectoryPath, options: selectOptions };
  // Bug 原因：下面在拨号前就进入连接屏（读取或补凭据），阶段数必须同时按本次目录意图计算。
  setWorkspaceStepPath(resolveWorkspaceStepPath(preferredDirectoryPath));
  setDirectoryPath("");
  setActiveProfileName(profile.displayName);
  setRecognizedSourceServerId(profile.sourceServerId);
  setRecognizedDeviceName(
    sourceManagementSnapshot?.directory.servers.find(
      (server) => server.sourceServerId === profile.sourceServerId,
    )?.displayName,
  );
  // Bug 原因：外部连接入口过去先在原界面直接执行 connectProfile，导致 toast、静默连接和
  // 弹窗进度三套反馈并存。精确 Profile intent 在加载凭据前就进入连接屏，后续安装/升级/
  // 失败/重试全部由同一个连接步骤承接。
  setCurrentStep("connecting");
  void (async () => {
    try {
      const target = buildRemoteTargetFromProfile(profile);
      const failure = selectOptions?.initialFailure;
      if (
        failure?.code === "source-server-upgrade-required" &&
        failure.failedTarget &&
        !profileMatchesRemoteTarget(profile, failure.failedTarget)
      ) {
        // 新 Profile 的凭据也不能混入旧失败目标；先交回原身份，让恢复校验提供显式重试。
        acceptInitialFailure(failure.failedTarget, failure);
        return;
      }
      setKind(target.kind);
      // Bug 原因：设备首屏之前只把 Profile 的非敏感 metadata 传给 Host，
      // Host manager.connect 不会替 UI 解析 credential refs，密码线路因此必然认证失败。
      const credentials = await loadConnectionProfileCredentials({
        profile,
        loadCredential: baseServices.credentialService.load,
      });
      if (entryEpochRef.current !== entryEpoch) return;
      if (target.kind === "ssh") {
        const hasPasswordAuth = Boolean(credentials?.password);
        const expectsPrivateKeyPassphrase =
          profile.target.kind === "ssh" &&
          Boolean(profile.target.privateKeyPassphraseCredentialKey);
        const hasPrivateKeyAuth = Boolean(
          target.privateKeyPath &&
          (!expectsPrivateKeyPassphrase || credentials?.privateKeyPassphrase),
        );
        if (!hasPasswordAuth && !hasPrivateKeyAuth) {
          // Bug 原因：Profile ref 存在但 value 缺失时，旧路径仍以空认证 target 发起 SSH，
          // 把“需要交互凭据”误报成服务端认证失败。认证链不完整必须在网络调用前 fail closed。
          updatePendingRemoteTarget(target);
          // 补凭据时仍保留原线路配置，返回设置不能变成空白的新连接。
          setKind("ssh");
          // 自动换目标不能混用常驻表单中上一设备的凭据，缺凭据只能重新输入。
          setPassword("");
          setPrivateKeyPassphrase("");
          setServerToken("");
          setHost(target.host);
          setPort(String(target.port ?? 22));
          setUsername(target.username);
          setPrivateKeyPath(target.privateKeyPath ?? "");
          setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
          setErrorCode("credentials-required");
          setError(intl.formatMessage({ id: "remote.error.credentialsRequired" }));
          return;
        }
      }
      const targetWithCredentials =
        target.kind === "ssh" && credentials
          ? {
              ...target,
              ...(credentials.password ? { password: credentials.password } : {}),
              ...(credentials.privateKeyPassphrase
                ? {
                    privateKeyPassphrase: credentials.privateKeyPassphrase,
                  }
                : {}),
            }
          : target;
      // 已保存线路可能直接进入连接屏；返回修改用户名/密钥时必须编辑这条线路，而非旧表单草稿。
      if (targetWithCredentials.kind === "ssh") {
        setHost(targetWithCredentials.host);
        setPort(String(targetWithCredentials.port ?? 22));
        setUsername(targetWithCredentials.username);
        setPrivateKeyPath(targetWithCredentials.privateKeyPath ?? "");
        setSshAuthMethod(targetWithCredentials.privateKeyPath ? "privateKey" : "password");
        setPassword(targetWithCredentials.password ?? "");
        setPrivateKeyPassphrase(targetWithCredentials.privateKeyPassphrase ?? "");
      }
      updatePendingRemoteTarget(targetWithCredentials);
      if (acceptInitialFailure(targetWithCredentials, selectOptions?.initialFailure)) return;
      await startRemoteConnection(targetWithCredentials, preferredDirectoryPath, selectOptions);
    } catch (cause) {
      if (entryEpochRef.current !== entryEpoch) return;
      setError(getErrorMessage(cause));
      setCurrentStep("connecting");
    }
  })();
}

export function runAcceptOpenIntent(context: RemoteFlowContext) {
  const {
    minimizedRef,
    closeDialog,
    sourceManagement,
    entryEpochRef,
    refreshingIntentRef,
    setRefreshingIntent,
    applySourceManagementSnapshot,
    setError,
  } = context;

  // 新入口先撤销旧 epoch/等待点，再由下面的偏好 effect 消费；恢复卡片不走这里。
  const wasBackground = minimizedRef.current;
  closeDialog({ keepOpen: true });
  if (wasBackground && sourceManagement) {
    const epoch = entryEpochRef.current;
    refreshingIntentRef.current = epoch;
    setRefreshingIntent(true);
    // 后台订阅保持存活，新入口仍须先读最新 Profile，不能消费旧快照的已编辑线路。
    void sourceManagement
      .getSnapshot()
      .then((snapshot) => {
        if (entryEpochRef.current === epoch) applySourceManagementSnapshot(snapshot);
      })
      .catch((cause) => {
        if (entryEpochRef.current === epoch) setError(getErrorMessage(cause));
      })
      .finally(() => {
        if (refreshingIntentRef.current !== epoch) return;
        refreshingIntentRef.current = null;
        setRefreshingIntent(false);
      });
  }
}

export function runApplyPreferredTarget(context: RemoteFlowContext, target: RemoteTarget) {
  const {
    entryEpochRef,
    setFocusCredentials,
    setPassword,
    setPrivateKeyPassphrase,
    setServerToken,
    setKind,
    updatePendingRemoteTarget,
    pendingCompletionIntentRef,
    setHost,
    setPort,
    setUsername,
    setPrivateKeyPath,
    setSshAuthMethod,
    setWslDistro,
    setWslUser,
    setManualDockerContainer,
    setDockerContainer,
    setServerUrl,
    setServerName,
    acceptInitialFailure,
    initialFailure,
    setCurrentStep,
    preferredDirectoryPath,
  } = context;

  entryEpochRef.current += 1;
  setFocusCredentials(false);
  // 只替换地址会把上一目标的密码/token 带进新请求；清理发生在换目标而非收起时。
  setPassword("");
  setPrivateKeyPassphrase("");
  setServerToken("");
  setKind(target.kind);
  updatePendingRemoteTarget(target);
  pendingCompletionIntentRef.current = {
    preferredDirectoryPath,
    options: { directToDirectory: true },
  };
  if (target.kind === "ssh") {
    setHost(target.host);
    setPort(String(target.port ?? 22));
    setUsername(target.username);
    setPrivateKeyPath(target.privateKeyPath ?? "");
    setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
    // 已有线路必须沿用保存的下载侧，不能被新建表单的默认值覆盖。
  } else if (target.kind === "wsl") {
    setWslDistro(target.distro ?? "");
    setWslUser(target.user ?? "");
  } else if (target.kind === "docker") {
    setManualDockerContainer(target.container);
    setDockerContainer(target.container);
  } else {
    setServerUrl(target.url);
    setServerName(target.name ?? "");
  }
  if (!acceptInitialFailure(target, initialFailure)) setCurrentStep("settings");
}

export function runFlowEffect5(context: RemoteFlowContext) {
  const {
    open,
    currentStep,
    pendingRemoteTarget,
    connectedSessionId,
    loading,
    consumedPreferredTargetRef,
    preferredTarget,
    preferredProfileId,
    applyPreferredTarget,
  } = context;

  if (!open && currentStep === "device" && !pendingRemoteTarget && !connectedSessionId && !loading)
    consumedPreferredTargetRef.current = null;
  if (
    !open ||
    !preferredTarget ||
    preferredProfileId ||
    loading ||
    connectedSessionId ||
    consumedPreferredTargetRef.current === preferredTarget
  )
    return;
  consumedPreferredTargetRef.current = preferredTarget;
  applyPreferredTarget(preferredTarget);
}

export function runFlowEffect6(context: RemoteFlowContext) {
  const {
    open,
    preferredProfileId,
    refreshingIntentRef,
    loading,
    connectedSessionId,
    consumedPreferredProfileIdRef,
    sourceManagementSnapshot,
    openPreferredProfile,
  } = context;

  if (
    !open ||
    !preferredProfileId ||
    refreshingIntentRef.current !== null ||
    loading ||
    connectedSessionId ||
    consumedPreferredProfileIdRef.current === preferredProfileId ||
    !sourceManagementSnapshot
  ) {
    return;
  }
  const profile = sourceManagementSnapshot.directory.profiles.find(
    (candidate) => candidate.profileId === preferredProfileId,
  );
  if (!profile) return;

  consumedPreferredProfileIdRef.current = preferredProfileId;
  openPreferredProfile(profile);
}
