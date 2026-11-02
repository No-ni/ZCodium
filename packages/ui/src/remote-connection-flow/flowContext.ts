import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { type ConnectionProfile, type RemoteTarget } from "@zcode/shared";
import type { RemoteFlowState } from "./flowState.js";
import type { RemoteConnectionCompletionIntent } from "./completionIntent.js";
export interface RemoteFlowContext extends RemoteFlowState {
  handleCancelSession: (sessionId: string) => Promise<void>;
  resetFeedback: () => void;
  resetDirectorySelectionState: () => void;
  updatePendingRemoteTarget: (target: RemoteTarget | null) => void;
  updateConnectingRequestId: (requestId: string | null) => void;
  applyOpenState: (nextOpen: boolean) => void;
  confirmRemoteFlowDiscard: () => Promise<boolean>;
  resolveWorkspaceStepPath: (path?: string) => string | undefined;
  closeDialog: (options?: { preserveSession?: boolean; keepOpen?: boolean }) => void;
  resumeBackground: () => void;
  formSnapshot: {
    kind: "ssh" | "wsl" | "docker" | "server";
    host: string;
    port: string;
    username: string;
    sshAuthMethod: import("@/hooks/useRemoteConnectionForm.js").SSHAuthMethod;
    password: string;
    privateKeyPath: string;
    privateKeyPassphrase: string;
    selectedSshConfigAlias: string | null;
    wslDistro: string;
    wslUser: string;
    dockerContainer: string;
    manualDockerContainer: string;
    serverUrl: string;
    serverName: string;
    serverToken: string;
    serverWorkspacePath: string;
  };
  startRemoteConnection: (
    target: RemoteTarget,
    preferredDirectoryPath?: string,
    options?: RemoteConnectionCompletionIntent["options"],
  ) => Promise<void>;
  handleConnect: () => Promise<void>;
  acceptInitialFailure: (
    target: RemoteTarget,
    initialFailure?: RemoteConnectionOpenPreference["initialFailure"],
  ) => boolean;
  applyPreferredTarget: (target: RemoteTarget) => void;
  openPreferredProfile: (profile: ConnectionProfile) => void;
  openPreferredSourceDirectory: (profile: ConnectionProfile) => void;
  handleOpenChange: (nextOpen: boolean) => void;
  handleStartPendingRemoteConnection: () => void;
  stepCopy: { title: string; description: string };
  handleCloseRequest: () => Promise<void>;
  directoryEpoch: number;
  displayTarget:
    | import("@zcode/shared").WSLConnectOptions
    | import("@zcode/shared").DockerConnectOptions
    | {
        kind: "ssh";
        host: string;
        username: string;
        port: number | undefined;
        url?: undefined;
        name?: undefined;
      }
    | {
        kind: "server";
        url: string;
        name: string | undefined;
        host?: undefined;
        username?: undefined;
        port?: undefined;
      }
    | null;
  handleSelectProfile: (
    profile: ConnectionProfile,
    preferredDirectoryPath?: string,
    selectOptions?: {
      initialFailure?: RemoteConnectionOpenPreference["initialFailure"];
      directToDirectory?: boolean;
      localWorkspacePath?: string;
    },
  ) => void;
  needsCredentials: boolean;
  passphraseRequired: boolean;
  handleCancelConnection: () => void;
  withConfirmedDiscard: (discard: () => void | Promise<void>) => Promise<void>;
  handleRetryConnection: () => void;
  handleSelectDirectory: (path: string) => Promise<void>;
  handleBackToConnection: () => Promise<void>;
}
