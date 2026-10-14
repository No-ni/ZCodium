import type { Event } from "@zcode/rpc";
import type {
  GenUiDocument,
  GenUiScope,
  GenUiStateChange,
  GenUiStateEntry,
  GenUiStateTarget,
  GenUiWidgetState,
} from "@zcode/shared/gen-ui";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";

export interface GenUiPrepareParams extends GenUiStateTarget {
  html: string;
  ownerWebContentsId: number;
  instanceKey: string;
}
/** Host 装配的可信查询端口；Renderer 不能提供执行目录来授权文件读取。 */
export interface GenUiConversationOutput {
  conversationWorkspaceRoot: string;
  resolveSessionWorkspacePath(scope: GenUiScope): Promise<string | undefined>;
}
/** readDocument runs on the executor Host. State and sandbox methods run on desktop base services. */
export interface IGenUiService {
  readDocument(target: GenUiStateTarget): Promise<GenUiDocument>;
  prepareSandbox(input: GenUiPrepareParams): Promise<PluginSandboxHandle>;
  getState(target: GenUiStateTarget): Promise<GenUiWidgetState | null>;
  setState(input: { target: GenUiStateTarget; state: GenUiWidgetState }): Promise<void>;
  listState(scope: GenUiScope): Promise<GenUiStateEntry[]>;
  onStateChanged: Event<GenUiStateChange>;
}
export const IGenUiService = createServiceDescriptor<IGenUiService>("gen-ui");
