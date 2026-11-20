/** 宿主 renderer ↔ relay shell 之间唯一一条 MessageChannel 的名字；上面跑原始 JSON-RPC（官方 AppBridge / App）。 */
export const PLUGIN_SANDBOX_PORT_NAME = "plugin-sandbox-rpc";

/** MessagePort 的最小结构类型；宿主 renderer 的 Transport 与 relay shell 都只依赖这几个成员。 */
export interface PluginSandboxTransportPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start?(): void;
  close(): void;
}

/** main → 宿主 renderer 的端口事件（经 preload `window.postMessage` transfer）。 */
export interface PluginSandboxPortsEvent {
  sandboxId: string;
  initId: number;
  port: PluginSandboxTransportPort;
}

/**
 * renderer 可用的沙箱平台端口，以 `IPlatformService.pluginSandbox` 可选字段挂载；web 端为 undefined，UI 据此回退。
 * 登记沙箱不在这里：它由 host 经 parentPort 完成，renderer 只拿句柄。
 */
export interface PluginSandboxPlatformPort {
  /** preload 已安装限定的沙箱原子移动适配。 */
  supportsRetainedMove?: boolean;
  /** 仅宿主操作可用；Main 校验 owner/代次后复制当前页面内容。 */
  copyImage?(input: PluginSandboxCaptureRequest): Promise<void>;
  /** 只为指定代际的 MCP guest 保持可逆后台执行；不改变窗口或其他页面的节流。 */
  setExecutionActive?(sandboxId: string, initId: number, active: boolean): Promise<void>;
  /** 宿主窗口 webContents id；prepareSandbox 用它作为 owner，main 在 will-attach 时校验。 */
  getOwnerWebContentsId(): Promise<number>;
  /**
   * 释放沙箱。带 initId 时只释放捕获的登记：新页面使用新 Agent 凭证和 sandboxId，
   * 两条 IPC 路径不同（host parentPort vs ipcMain），旧 dispose 到得晚也不能误杀新登记。
   */
  disposeSandbox(sandboxId: string, initId?: number): Promise<void>;
  consumeUserGesture(sandboxId: string): Promise<boolean>;
  onPorts(handler: (event: PluginSandboxPortsEvent) => void): () => void;
}

export interface PluginSandboxCaptureRequest {
  sandboxId: string;
  initId: number;
  captureRect: { x: number; y: number; width: number; height: number };
  viewportSize: { width: number; height: number };
}
