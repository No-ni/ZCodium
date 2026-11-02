import type { RemoteFlowState } from "./flowState.js";
import { type ComponentProps } from "react";
import { type RemoteTarget } from "@zcode/shared";
import { collectRemoteFormFieldErrors } from "@/lib/remoteConnectionWizard.js";
import { RemoteConnectionSettingsStep } from "@/RemoteConnectionDialogContent.js";
import type { RemoteFlowContext } from "./flowContext.js";
export function buildSettingsStep(context: RemoteFlowContext) {
  const {
    addingDevice,
    availableKinds,
    kind,
    entryEpochRef,
    resetDraft,
    setKind,
    updatePendingRemoteTarget,
    setActiveProfileName,
    setRecognizedSourceServerId,
    setRecognizedDeviceName,
    resetFeedback,
    completion,
    intl,
    host,
    port,
    username,
    sshAuthMethod,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    wslDistros,
    dockerContainer,
    manualDockerContainer,
    serverUrl,
    serverName,
    serverToken,
    serverWorkspacePath,
    dockerContainers,
    dockerAvailable,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    currentRuntimeOptionsLoading,
    currentRuntimeOptionsError,
    remoteWorkspaceSessions,
    validationAttempt,
    formSnapshot,
    focusCredentials,
    loading,
    handleCloseRequest,
    setCurrentStep,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    setServerUrl,
    setServerName,
    setServerToken,
    setServerWorkspacePath,
    refreshDockerContainers,
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    handleConnect,
  } = context;
  return {
    availableKinds: addingDevice ? availableKinds : undefined,
    onKindChange: addingDevice
      ? (nextKind: RemoteTarget["kind"]) => {
          if (nextKind === kind) return;
          entryEpochRef.current += 1;
          resetDraft();
          setKind(nextKind);
          updatePendingRemoteTarget(null);
          setActiveProfileName(undefined);
          setRecognizedSourceServerId(undefined);
          setRecognizedDeviceName(undefined);
          resetFeedback();
        }
      : undefined,
    connectLabel:
      completion === "device-management"
        ? intl.formatMessage({ id: "remote.addAndConnect" })
        : undefined,
    kind: kind,
    host: host,
    port: port,
    username: username,
    sshAuthMethod: sshAuthMethod,
    password: password,
    privateKeyPath: privateKeyPath,
    privateKeyPassphrase: privateKeyPassphrase,
    wslDistro: wslDistro,
    wslUser: wslUser,
    wslDistros: wslDistros,
    dockerContainer: dockerContainer,
    manualDockerContainer: manualDockerContainer,
    serverUrl: serverUrl,
    serverName: serverName,
    serverToken: serverToken,
    serverWorkspacePath: serverWorkspacePath,
    dockerContainers: dockerContainers,
    dockerAvailable: dockerAvailable,
    sshConfigAliases: sshConfigAliases,
    sshConfigAliasesLoading: sshConfigAliasesLoading,
    sshConfigAliasesError: sshConfigAliasesError,
    selectedSshConfigAlias: selectedSshConfigAlias,
    currentRuntimeOptionsLoading: currentRuntimeOptionsLoading,
    currentRuntimeOptionsError: currentRuntimeOptionsError,
    remoteWorkspaceSessions: remoteWorkspaceSessions,
    // 错误由当前字段值实时计算，字段改为有效即消失；唯一规则来源为 collectRemoteFormFieldErrors。
    fieldErrors: validationAttempt > 0 ? collectRemoteFormFieldErrors(intl, formSnapshot) : [],
    validationAttempt,
    focusCredentials: focusCredentials,
    loading: loading,
    onBack: () => {
      if (addingDevice) {
        void handleCloseRequest();
        return;
      }
      resetFeedback();
      setCurrentStep("device");
    },
    onHostChange: setHost,
    onPortChange: setPort,
    onUsernameChange: setUsername,
    onSshAuthMethodChange: setSshAuthMethod,
    onPasswordChange: setPassword,
    onPrivateKeyPathChange: setPrivateKeyPath,
    onPrivateKeyPassphraseChange: setPrivateKeyPassphrase,
    onWslDistroChange: setWslDistro,
    onWslUserChange: setWslUser,
    onDockerContainerChange: setDockerContainer,
    onManualDockerContainerChange: setManualDockerContainer,
    onServerUrlChange: setServerUrl,
    onServerNameChange: setServerName,
    onServerTokenChange: setServerToken,
    onServerWorkspacePathChange: setServerWorkspacePath,
    onDockerContainersRefresh: refreshDockerContainers,
    onApplySshConfigAlias: applySshConfigAlias,
    onClearSelectedSshConfigAlias: clearSelectedSshConfigAlias,
    onConnect: () => {
      void handleConnect();
    },
  } satisfies ComponentProps<typeof RemoteConnectionSettingsStep>;
}

export function buildRemoteFlowFormSnapshot(state: RemoteFlowState) {
  return {
    kind: state.kind,
    host: state.host,
    port: state.port,
    username: state.username,
    sshAuthMethod: state.sshAuthMethod,
    password: state.password,
    privateKeyPath: state.privateKeyPath,
    privateKeyPassphrase: state.privateKeyPassphrase,
    selectedSshConfigAlias: state.selectedSshConfigAlias,
    wslDistro: state.wslDistro,
    wslUser: state.wslUser,
    dockerContainer: state.dockerContainer,
    manualDockerContainer: state.manualDockerContainer,
    serverUrl: state.serverUrl,
    serverName: state.serverName,
    serverToken: state.serverToken,
    serverWorkspacePath: state.serverWorkspacePath,
  };
}
