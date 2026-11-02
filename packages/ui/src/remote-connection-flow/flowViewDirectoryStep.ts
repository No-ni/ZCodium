import { type ComponentProps } from "react";
import { RemoteConnectionDirectoryStep } from "@/RemoteConnectionDialogContent.js";
import type { RemoteFlowContext } from "./flowContext.js";
export function buildDirectoryStep(context: RemoteFlowContext) {
  const {
    entryEpochRef,
    directoryEpoch,
    setDirectoryPath,
    directoryBrowserServices,
    pendingRemoteTarget,
    recognizedSourceServerId,
    localWorkspacePath,
    selectingDirectory,
    handleSelectDirectory,
    withConfirmedDiscard,
    handleBackToConnection,
    handleCloseRequest,
    selectingDirectoryRef,
    closeDialog,
    recognizedDeviceName,
    activeProfileName,
    recognizedServer,
    quickOpenDirectoryData,
    directoryPath,
  } = context;
  return {
    directoryPath,
    onDirectoryPathChange: (path) => {
      if (entryEpochRef.current === directoryEpoch) setDirectoryPath(path);
    },
    services: directoryBrowserServices,
    remoteTarget: pendingRemoteTarget,
    sourceServerId: recognizedSourceServerId,
    localWorkspacePath: localWorkspacePath,
    selecting: selectingDirectory,
    onSelect: (path) => {
      void handleSelectDirectory(path);
    },
    onBack: () => {
      void withConfirmedDiscard(handleBackToConnection);
    },
    onCancel: () => {
      void handleCloseRequest();
    },
    onChooseLater: () => {
      // 只释放未绑定项目的临时 attachment；Host 的设备连接独立保留。
      if (!selectingDirectoryRef.current) closeDialog();
    },
    deviceName: recognizedDeviceName,
    profileName: activeProfileName,
    deviceVersion: recognizedServer?.version,
    quickOpenPaths: quickOpenDirectoryData.paths,
    quickOpenEntries: quickOpenDirectoryData.entries,
  } satisfies ComponentProps<typeof RemoteConnectionDirectoryStep>;
}
