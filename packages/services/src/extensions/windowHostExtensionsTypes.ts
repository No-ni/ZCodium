import {
  ChannelClient,
  ChannelServer,
  MessagePortProtocol,
  type IDisposable,
  type MessagePortLike,
} from "@zcode/rpc";
import {
  type ExtensionWindowToMainMessage,
  type IExtensionHostChannel,
  type MainToExtensionWindowMessage,
} from "@zcode/shared/extension-host";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import type { IPluginManagementService } from "#src/plugins/pluginManagement.js";
import type { IModelSelectionService } from "#src/model-provider/providerFacadeServices.js";
import type { PluginMutationSucceededEvent } from "#src/plugins/pluginManagementService.js";
import type { PluginUserOptionsReader } from "#src/zcode-agent/pluginHostQueriesClient.js";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type { AppControlServiceHandle } from "#src/app-control/contract.js";
import type { ExtensionTaskRowsSource } from "#src/extensions/sessionListPump.js";
import type { IExtensionsService } from "#src/extensions/contract.js";
import type { IExtensionViewsService } from "#src/extensions/views/contract.js";
import type { IExtensionGrantsService } from "#src/extensions/grants/contract.js";
import type { IProjectService } from "#src/project/contract.js";

// Window Host 的扩展门面实现（docs/plugins/extension-host.md §3.4、§3.5、§13、§16.1）：
// - 静态表的唯一 owner：插件清单的 owner 是 CLI，读出用户级启用的插件后逐个读 plugin.json 校验，
//   整份推给 Renderer；只把合法、兼容的扩展声明推给扩展进程。启动、插件管理成功、重新加载时重读。
// - 按代际连接扩展进程（Main 牵线的 L1 端口），只持最近一份贡献表快照（运行状态与动态值）并转给 Renderer。
// - 扩展进程状态的 owner 是 Main：经 parentPort 收到后转给 Renderer。
// - 日志缓冲的 owner 也是 Main（§16.8）：追加的批次与快照回包都只转发，不留副本。
// - 能力网关：extension-window 频道的唯一服务端；后端是 Renderer 报告、两个数据泵与视图中转。

export interface WindowHostExtensionsDeps {
  /** 读插件清单（静态表、settings.*）；settings.update 经 configurePlugin 写 user 层（§18.1 H1）。 */
  pluginManagement: Pick<IPluginManagementService, "listPlugins" | "configurePlugin">;
  /**
   * 数据泵的来源：context 组成与生成速率都由 CLI 产生（§3.4）；会话读连接以它为底座建连接作用域（§17.5）。
   * 只在本进程内传递。
   */
  agent: IZCodeAgentService;
  /** Window Host 控制器的任务投影（会话列表泵，§17.5）：只在本进程内传递。缺省时列表订阅报 unavailable。 */
  taskRows?: ExtensionTaskRowsSource;
  /** 扩展视图的沙箱登记（Host → Main）。缺省时扩展视图不可用。 */
  registerSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  /** 读用户级插件清单用的本地目录（与 Agent 的 fallback cwd 同源）。 */
  inventoryWorkspacePath: string;
  /**
   * 能力 settings.get 的读取器（§16.7）：Window Host 进程内，含敏感值，不在任何 RPC 频道上。
   * undefined 时按旧 CLI 处理（只有非敏感值）。
   */
  userOptionsReader: PluginUserOptionsReader | undefined;
  /**
   * 会话能力的后端（§17.2）：createLocalServices 经 onAppControlServiceCreated 交出的 facade。
   * 只在本进程内传递，不在任何 RPC 频道上。undefined 时会话能力报 unavailable。
   */
  appControl: AppControlServiceHandle | undefined;
  /** 插件项目（§17.4，P3c-2）：本机 Host 的项目服务，与侧栏「新建项目」同一条 saveProject 路径。 */
  projects: Pick<IProjectService, "readProjects" | "saveProject">;
  /** 能力 models.list 的来源（§18.1 H9）：输入框模型选择器同一份视图。缺省时报 unavailable。 */
  modelSelection?: Pick<IModelSelectionService, "getView">;
  /** 本服务的数据目录（`~/.zcode/v2/extensions`）：授权记录 grants.json 与审计目录 audit/（§17.7、§17.8）。 */
  dataDir: string;
  postToMain(message: ExtensionWindowToMainMessage): void;
}

export interface WindowHostExtensions {
  readonly service: IExtensionsService;
  /** 扩展视图门面：与 service 同一份状态（同一个视图中转），另一个频道。 */
  readonly viewsService: IExtensionViewsService;
  /** 授权门面（§17.7）：与 service 同一份状态，另一个频道；只在桌面本机 Host 注册。 */
  readonly grantsService: IExtensionGrantsService;
  /** Window Host 服务已就绪：读静态表，并请 Main 牵线。 */
  announceReady(): void;
  /** Main 的 L0 消息：pair 带一个已包装的端口。 */
  receiveControl(
    message: MainToExtensionWindowMessage,
    port?: { port: MessagePortLike; onClose(listener: () => void): void },
  ): void;
  /**
   * 插件管理操作成功（安装、卸载、启停、配置）：重读静态表并重推扩展声明；user 层的配置或重置
   * 另通知该插件的 settings.onDidChange（§16.7）。
   */
  refreshInventory(change?: PluginMutationSucceededEvent): void;
  dispose(): void;
}

interface Connection {
  gen: number;
  protocol: MessagePortProtocol;
  server: ChannelServer;
  client: ChannelClient;
  host: IExtensionHostChannel;
  subscription: IDisposable;
}
export { type Connection };

import type {
  ExtensionHostStatus,
  ContributionSnapshot,
  ExtensionStaticTable,
  ExtensionDeclarations,
  StaticPlugin,
  ExtensionDeclaration,
} from "@zcode/shared/extension-host";
export interface WindowExtensionState {
  status: ExtensionHostStatus;
  snapshot: ContributionSnapshot | null;
  table: ExtensionStaticTable;
  declarations: ExtensionDeclarations | null;
  connection: Connection | null;
  disposed: boolean;
  resolvedPlugins: Array<{ entry: StaticPlugin; declaration: ExtensionDeclaration | null }>;
}
