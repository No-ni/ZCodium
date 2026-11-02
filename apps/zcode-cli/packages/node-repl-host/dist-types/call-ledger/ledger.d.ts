import type { NodeReplCuaAppIdentity, NodeReplImage, NodeReplRequestMeta } from "@zcode/core/repl";
/**
 * 一次 js 调用里由 broker 记下的可信事实。
 *
 * 只保留三类用途：会话归属（requestMeta）、过期调用防护（token 生命周期）、工具展示事实
 * （目标应用身份与浏览器截图）。上游在这里还挂了 `browserUse` / `computerUse` 两个「会话能力
 * 标签」位，供 core 拼 `x-zcode-session-features` 统计请求头；本仓按审计边界剥离统计上报，
 * 因此这两个字段不恢复，broker 也不写它（见 .agents/specs/official-3.17.1-cua.md §3.4）。
 */
export interface NodeReplCallFacts {
    /** CUA broker 从 runtime 结果读到的目标应用身份，按出现顺序。 */
    readonly cuaApps: NodeReplCuaAppIdentity[];
    /** 浏览器代理 broker 转发的成功截图，按出现顺序。 */
    readonly browserScreenshots: NodeReplImage[];
}
export interface NodeReplCallLedgerEntry {
    /** 只属于本次调用的 token，经 workerData 交给 Worker。 */
    readonly token: string;
    /** core 发出的 MCP 请求里的 request-context；broker 只用它构造会话信息。 */
    readonly requestMeta: Readonly<NodeReplRequestMeta>;
    readonly facts: NodeReplCallFacts;
}
export interface NodeReplOpenCall extends NodeReplCallLedgerEntry {
    /** tools/call 结束时调用；之后带这个 token 的请求一律拒绝。 */
    close(): void;
}
export interface NodeReplCallLedger {
    open(requestMeta: NodeReplRequestMeta): NodeReplOpenCall;
    /** 按 token 找到尚未关闭的调用；找不到（伪造、过期、非字符串）返回 undefined。 */
    resolve(token: unknown): NodeReplCallLedgerEntry | undefined;
}
export declare function createNodeReplCallLedger(): NodeReplCallLedger;
//# sourceMappingURL=ledger.d.ts.map
