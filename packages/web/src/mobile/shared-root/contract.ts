import type { RemoteServiceAccess } from "@zcode/client";
import type { ComponentProps } from "react";
import type { Root } from "@zcode/ui";
import type {
  IPlatformService,
  WebRemoteControlAppPayload,
  WebRemoteControlBootstrapResult,
  WebRemoteControlBridgeDescriptor,
  WebRemoteControlMobileTaskView,
  WebRemoteControlWorkspaceListResult,
} from "@zcode/shared";

export type MobileRootProps = ComponentProps<typeof Root>;
export type MobileRootWorkspaceSwitcher = NonNullable<
  MobileRootProps["webRemoteControlWorkspaceSwitcher"]
>;
export type MobileRootDraftRequest = Parameters<
  NonNullable<MobileRootWorkspaceSwitcher["openProjectDraft"]>
>[0];

export type MobileRootConnectionState =
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "closed"
  | "error";

export interface MobileRootWorkspaceTarget {
  workspaceKey: string;
  remoteSessionId?: string;
  taskId?: string;
}

export interface MobileRootWorkspaceAccess {
  readonly services: RemoteServiceAccess;
  readonly descriptor: WebRemoteControlBridgeDescriptor;
  readonly generation: number;
  /** 既有协议所有者同时复检 accessor 实例、scope 与 generation。 */
  isCurrent(): boolean;
}

/** 已配对客户端提供传输 port；本模块不创建 socket、业务队列或 service 副本。 */
export interface MobileSharedRootTransport {
  openSharedWorkspace(target: MobileRootWorkspaceTarget): Promise<MobileRootWorkspaceAccess>;
  onSharedWorkspaceInvalidated(listener: () => void): () => void;
  request(
    payload: WebRemoteControlAppPayload & { requestId: string },
  ): Promise<WebRemoteControlAppPayload>;
  sendPayload(payload: WebRemoteControlAppPayload): void;
  updateMobileTaskView(view: WebRemoteControlMobileTaskView | null): void;
}

export interface SharedMobileRootProps {
  client: MobileSharedRootTransport;
  connection: MobileRootConnectionState;
  bootstrap: WebRemoteControlBootstrapResult | null;
  title: string;
  description: string;
  notice?: string | null;
  saveFile: NonNullable<IPlatformService["saveFile"]>;
  onWorkspaceListUpdated(result: WebRemoteControlWorkspaceListResult): void;
}

/** 仅恢复导航意图；任务正文、正在生成的状态与 accepted queue 由共享 Root/CLI 持有。 */
export interface MobileRootNavigation {
  workspaceKey: string;
  taskId?: string;
  revision: number;
  mobileNavigationIntent?: "chat";
  fileTreeTaskId?: string;
  draft?: MobileRootDraftRequest;
}

export interface MobileRootSlot {
  key: string;
  access: MobileRootWorkspaceAccess;
  rootProps: MobileRootProps;
}

export interface MobileRootSnapshot {
  slot: MobileRootSlot | null;
  loading: boolean;
  error: boolean;
}
