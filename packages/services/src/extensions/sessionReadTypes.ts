import type { IDisposable } from "@zcode/rpc";
import type { AppSessionRef } from "@zcode/session-control/contracts";
import {
  ExtensionError,
  type SessionConversationEvent,
  type SessionInteractionsEvent,
  type SessionListEvent,
  type SessionReadRowsInput,
  type SessionReadRowsResult,
  type SessionRowsEvent,
  type SessionTargetInput,
} from "@zcode/shared/extension-host";
import {
  TopicWireFrameAssembler,
  type ConversationSnapshot,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgent.js";
import { type ZCodeAgentConnectionScope } from "#src/zcode-agent/zcodeAgentConnectionScope.js";
import type {
  CapabilityCallContext,
  CapabilitySubscription,
} from "#src/extensions/capabilityTypes.js";
import { type ExtensionTaskRowsSource } from "#src/extensions/sessionListPump.js";
import type { SessionsBackend } from "#src/extensions/sessionsBackend.js";

// 会话读连接（docs/plugins/extension-host.md §17.5，P3b）：插件是与手机同级的客户端，读走自己的连接。
//
//   ctx.sessions.onDidChangeRows({ sessionId }) ──► 网关（已查声明、协议、授权）
//       ├─ 上限：该插件的不同会话 ≤ 8，全局镜像 ≤ 32（limit-exceeded）
//       ├─ 解析：facade readSession(view: summary) → 会话引用（与模型工具同一份授权）
//       └─ 镜像（按会话共享）：scope（extension-host:<gen>，replayable）订阅 conversation topic，
//          snapshot → reset；deltas → apply 后的整行；断档 → forceSnapshot 重同步 → reset
//
// 连接作用域属于一代扩展进程：detach 时 scope.dispose() 全部退订，插件重连后重订，第一个事件是 reset。
// 列表泵在 sessionListPump.ts，与连接无关（读的是 Window Host 控制器投影）。

export interface SessionReadsDeps {
  /** 连接作用域的底座：Window Host 的 IZCodeAgentService（只在本进程内）。 */
  agent: IZCodeAgentService | undefined;
  /** 解析会话目标走 facade（客户端类调用方，与 readSession 同一份授权与代际检查）。 */
  sessions: SessionsBackend;
  /** Window Host 控制器的任务投影；缺省时列表订阅报 unavailable。 */
  taskRows: ExtensionTaskRowsSource | undefined;
  /** 本机来源 id（会话引用的 sourceServerId）；没有会话 facade 时为 undefined。 */
  localSourceServerId(): string | undefined;
  /** 当前连接的扩展进程代际；没有连接时为 null。 */
  currentGen(): number | null;
  /**
   * 回答审批与切换权限模式的范围检查（§17.12）：会话不在调用方插件的项目里时抛 forbidden。
   * 只用于 interactions 一类的登记；缺省时这类登记一律 forbidden。
   */
  controlScope?(pluginId: string, session: AppSessionRef): Promise<void>;
  logger: Pick<ServiceLogger, "debug" | "info" | "warn">;
}

/** 一次性读取的结果：会话目标与当前交互（§17.12，回答与切换前的检查用）。 */
export interface SessionInteractionsRead {
  target: ZCodeAgentWorkspaceTarget & { sessionId: string };
  event: SessionInteractionsEvent;
}

export interface SessionReads {
  readRows(
    call: CapabilityCallContext,
    input: SessionReadRowsInput,
  ): Promise<SessionReadRowsResult>;
  onDidChangeList(call: CapabilityCallContext): CapabilitySubscription<SessionListEvent>;
  onDidChangeConversation(
    call: CapabilityCallContext,
    input: SessionTargetInput,
  ): CapabilitySubscription<SessionConversationEvent>;
  onDidChangeRows(
    call: CapabilityCallContext,
    input: SessionTargetInput,
  ): CapabilitySubscription<SessionRowsEvent>;
  /** 插件项目里的会话：待处理的审批与提问、当前权限模式（§17.12）。 */
  onDidChangeInteractions(
    call: CapabilityCallContext,
    input: SessionTargetInput,
  ): CapabilitySubscription<SessionInteractionsEvent>;
  /**
   * 读一次当前交互（同样经范围检查）：会话已有镜像时直接取，没有时临时挂一个、拿到快照就释放
   * （计入每插件的会话上限）。换代或断开时以 cancelled 结束。
   */
  readInteractions(
    call: CapabilityCallContext,
    sessionId: string,
  ): Promise<SessionInteractionsRead>;
  /** 换代或断开：释放连接作用域与全部镜像。 */
  detach(): void;
  dispose(): void;
}

type Target = ZCodeAgentWorkspaceTarget & { sessionId: string };

interface Registration {
  pluginId: string;
  sessionId: string;
  kind: "rows" | "conversation" | "interactions";
  /** 一次性读取的登记：换代或断开时要以 cancelled 结束（订阅由 RPC 服务端一起释放，不需要）。 */
  oneShot?: boolean;
  listener: (event: never) => void;
  fail: (error: ExtensionError) => void;
  mirror: Mirror | null;
  disposed: boolean;
}

interface Mirror {
  key: string;
  target: Target;
  topic: string;
  assembler: TopicWireFrameAssembler<ConversationTopicFrame>;
  registrations: Set<Registration>;
  /** 每次（重新）订阅加一：迟到的 ACK 与失败按它判断是否过期。 */
  attempt: number;
  phase: "subscribing" | "live" | "resyncing" | "detached" | "closed";
  subscriptionId: string | null;
  snapshot: ConversationSnapshot | null;
  rowBytes: Map<number, number>;
  totalBytes: number;
  /** 最近一次推给会话状态订阅者的 logEpoch/revision/phase。 */
  stateKey: string | null;
  /** 最近一次推给交互订阅者的权限模式与交互（不含修订号：流式期间修订号一直变，内容没变不推）。 */
  interactionsKey: string | null;
  lifecycleRevision: number;
}

interface Connection {
  gen: number;
  scope: ZCodeAgentConnectionScope;
  ready: Promise<void>;
  /** 每个工作区一条帧流与一条会话生命周期流，按 topic 分给镜像。 */
  workspaces: Map<string, IDisposable[]>;
  runtime: IDisposable[];
}
export { type Target, type Registration, type Mirror, type Connection };
