import { RemoteConnectionSelection } from "@/remote-connection/RemoteConnectionSelection.js";
import { type ComponentProps } from "react";
import { type RemoteTarget } from "@zcode/shared";
import type { RemoteFlowContext } from "./flowContext.js";
export function buildSelectionStep(context: RemoteFlowContext) {
  const {
    sourceManagementSnapshot,
    remoteHistory,
    sshConfigAliases,
    wslDistros,
    dockerContainers,
    discoveryLoading,
    onProjectIntentCleared,
    handleSelectProfile,
    entryEpochRef,
    pendingCompletionIntentRef,
    updatePendingRemoteTarget,
    resetDraft,
    setDirectoryPath,
    setRecognizedDeviceName,
    setRecognizedSourceServerId,
    setKind,
    setActiveProfileName,
    setAliasCredentialsPending,
    setFocusCredentials,
    resetFeedback,
    setCurrentStep,
    setWslDistro,
    setDockerContainer,
    startRemoteConnection,
    applySshConfigAlias,
    availableKinds,
    dockerAvailable,
    discoveryError,
    remoteConversationWorkspaceBySourceServerId,
  } = context;
  return {
    snapshot: sourceManagementSnapshot,
    workspaceHistory: remoteHistory,
    aliases: sshConfigAliases,
    distros: wslDistros,
    containers: dockerContainers,
    availableKinds,
    dockerAvailable,
    loading: discoveryLoading,
    discoveryError,
    remoteConversationWorkspaceBySourceServerId,
    onSelectProfile: (profile, path) => {
      onProjectIntentCleared?.();
      handleSelectProfile(profile, path, { directToDirectory: true });
    },
    onNewConnection: (nextKind) => {
      entryEpochRef.current += 1;
      pendingCompletionIntentRef.current = { options: { announceReusedConnection: true } };
      updatePendingRemoteTarget(null);
      resetDraft();
      setDirectoryPath("");
      setRecognizedDeviceName(undefined);
      setRecognizedSourceServerId(undefined);
      setKind(nextKind);
      setActiveProfileName(undefined);
      setAliasCredentialsPending(false);
      setFocusCredentials(false);
      onProjectIntentCleared?.();
      resetFeedback();
      setCurrentStep("settings");
    },
    onSelectTarget: (target) => {
      resetDraft();
      setDirectoryPath("");
      setRecognizedDeviceName(undefined);
      setRecognizedSourceServerId(undefined);
      setKind(target.kind);
      if (target.kind === "wsl") setWslDistro(target.distro ?? "");
      if (target.kind === "docker") setDockerContainer(target.container);
      setActiveProfileName(undefined);
      onProjectIntentCleared?.();
      void startRemoteConnection(target);
    },
    onSelectAlias: (alias) => {
      resetDraft();
      setDirectoryPath("");
      setRecognizedDeviceName(undefined);
      setRecognizedSourceServerId(undefined);
      setKind("ssh");
      applySshConfigAlias(alias);
      setActiveProfileName(alias.alias);
      pendingCompletionIntentRef.current = {};
      onProjectIntentCleared?.();
      resetFeedback();
      const target: RemoteTarget = {
        kind: "ssh",
        host: alias.host?.trim() || alias.alias,
        username: alias.username?.trim() ?? "",
        port: alias.port,
        sshConfigAlias: alias.alias,
        privateKeyPath: alias.privateKeyPath,
      };
      updatePendingRemoteTarget(target);
      if (!target.username) {
        setCurrentStep("settings");
        return;
      }
      if (!target.privateKeyPath) {
        setAliasCredentialsPending(true);
        setCurrentStep("connecting");
        return;
      }
      void startRemoteConnection(target);
    },
  } satisfies ComponentProps<typeof RemoteConnectionSelection>;
}
