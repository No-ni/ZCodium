import type { IPlatformService, WebRemoteControlBootstrapResult } from "@zcode/shared";
import type {
  MobileRootConnectionState,
  MobileRootSnapshot,
  MobileRootWorkspaceAccess,
} from "../contract.js";

/** 内部依赖装配；配对协议继续拥有 transport 的释放。 */
export interface MobileRootAdapters {
  /** 必须在发布 slot/首次 Root render 前同步注册；清理只撤销自身实例。 */
  registerWorkspace(access: MobileRootWorkspaceAccess): () => void;
  createPlatform(access: MobileRootWorkspaceAccess): IPlatformService;
}

export interface MobileRootController {
  start(): void;
  dispose(): void;
  update(
    connection: MobileRootConnectionState,
    bootstrap: WebRemoteControlBootstrapResult | null,
  ): void;
  retry(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): MobileRootSnapshot;
}
