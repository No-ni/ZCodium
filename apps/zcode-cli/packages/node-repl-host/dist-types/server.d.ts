import { Server } from "@modelcontextprotocol/server";
import { type NodeReplRequestMeta, type NodeReplRunResult } from "@zcode/core/repl";
import { type ComputerUseRuntime } from "@zcode/zcode-cua";
import { type NodeReplBrowserBrokerConnection } from "./browser-bridge.js";
import { type NodeReplBrowserBrokerUpstream } from "./call-ledger/contract.js";
import { type NodeReplCuaBrokerConnection } from "./cua-bridge.js";
import { installNodeReplProcessGuards, installNodeReplShutdownTriggers } from "./process-lifecycle.js";
export declare const NODE_REPL_MCP_PROCESS_TITLE = "zcode-node-repl-mcp";
export interface NodeReplExecuteInput {
    code: string;
    requestMeta: NodeReplRequestMeta;
    signal: AbortSignal;
    syncTimeoutMs: number;
    cuaBroker?: NodeReplCuaBrokerConnection;
    browserBroker?: NodeReplBrowserBrokerConnection;
}
export type NodeReplExecutor = (input: NodeReplExecuteInput) => Promise<NodeReplRunResult>;
export interface NodeReplMcpRuntime {
    dispose(): void;
    server: Server;
}
export declare function setNodeReplMcpProcessTitle(target?: {
    title: string;
}): void;
/**
 * 测试与同进程嵌入入口使用同一条执行逻辑；生产 stdio 默认在一次性 Worker 中调用它，
 * 从而连 Node 的模块缓存也随调用一起销毁。
 */
export declare function createInProcessNodeReplExecutor(): NodeReplExecutor;
export declare function createNodeReplMcpRuntime(input?: {
    executeJs?: NodeReplExecutor;
    cuaRuntime?: ComputerUseRuntime;
    /** ZCode 主进程浏览器 broker 的地址和 token；默认从环境变量读取（测试注入假 broker）。 */
    browserBrokerUpstream?: NodeReplBrowserBrokerUpstream;
    writeStderr?: (text: string) => void;
}): NodeReplMcpRuntime;
export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };
export declare function main(): Promise<void>;
/**
 * 按平台装配 Computer Use 运行时（本轮保留 `@trycua/cua-driver` 旧后端）：
 * - 只有显式给出 `ZCODE_CUA_DRIVER_SOCKET`，或 `ZCODE_CUA_DRIVER_EMBEDDED=1` 自起 driver，才构造 runtime；
 * - Linux 先探 shell / portal / WinRects 版本，决定是否挂老 GNOME 物理输入兼容层；
 * - driver 缺失保持 fail-closed，不回落任何官方 broker socket。
 *
 * 修复原因：上游 3.17.1 把装配入口改成 `ZCODE_CUA_PERMISSION_BROKER_SOCKET` + 占位 runtime，
 * 而旧后端的 producer 是 driver daemon / embedded SDK；沿用官方读点会让本来可用的 driver 路径
 * 被永久判成 unavailable（见 .agents/specs/official-3.17.1-cua.md §3）。
 */
export declare function captureComputerUseRuntimeFromEnvironment(env?: NodeJS.ProcessEnv): Promise<ComputerUseRuntime | undefined>;
//# sourceMappingURL=server.d.ts.map