import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { WorkspacePurpose } from "@zcode/shared";
import type { FileReferenceRoot } from "@/lib/fileReferenceRoot.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";

/**
 * 会话执行 cwd（conversation snapshot 的 additive 字段 `workspacePath`）。
 *
 * 唯一所有者是 Agent CLI：它把每个会话的真实执行目录投影到快照上（见
 * `docs/specs/conversation-session-workspace.md` 的所有者表「会话 cwd 的对外投影」）。
 * UI 只读，不缓存、不推导目录命名规则。字段是 optional：旧 CLI 缺席时返回 null，
 * 调用方回落 tab 的 workspacePath。
 */
export function readSessionWorkspacePath(
  // 只读这一个字段：显式声明依赖面，调用方传完整 snapshot 仍然成立。
  snapshot: Pick<ConversationSnapshot, "workspacePath"> | null,
): string | null {
  const value = snapshot?.workspacePath;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isSessionWorkspaceSnapshotReady(
  snapshot: Pick<ConversationSnapshot, "sessionId"> | null,
  sessionId: string | null,
): boolean {
  return sessionId !== null && snapshot?.sessionId === sessionId;
}

export function isTerminalExecutionPathReady(params: {
  hasWorkspaceIdentity: boolean;
  workspacePurpose?: WorkspacePurpose | null;
  sessionId: string | null;
  sessionSnapshotReady: boolean;
}): boolean {
  return (
    params.hasWorkspaceIdentity ||
    // 根因：对话根也能显式作为 project 打开；有会话时须等待 CLI 事实，purpose 不能证明 cwd。
    (params.sessionId === null && params.workspacePurpose === "project") ||
    (params.sessionId !== null && params.sessionSnapshotReady)
  );
}

/**
 * 会话 cwd 缺失时的回落规则（单一实现，调用方不再各写一遍 `?? workspacePath`）：
 * 会话已绑定且快照带 workspacePath → 用会话 cwd；否则退回 tab 的工作区路径（对话根）。
 */
export function resolveEffectiveWorkspacePath(
  sessionWorkspacePath: string | null,
  tabWorkspacePath: string,
): string {
  return sessionWorkspacePath && sessionWorkspacePath.trim().length > 0
    ? sessionWorkspacePath
    : tabWorkspacePath;
}

/**
 * pane 内的「文件搜索 / 相对路径解析根」派生（会话执行 cwd 的唯一读取点）。
 *
 * 与 shell 侧的 `useSessionWorkspacePath` 不同：shell 只认 `activeTaskId`（草稿态为 null →
 * 回落对话根，见 spec 已知边界 2），而 pane 草稿态的 lease 是按
 * `effectiveSessionId = sessionId ?? prewarmSessionId` 获取的，快照属于**预热会话**——
 * 它就是要承载首发的那个会话。只按 `sessionId` 校验身份会把草稿期的解析根打回对话根
 * （身份根），于是 `@` 提及搜索 / 拖拽 / Add to chat / 行内编辑器插入的是身份根相对路径：
 * 首发后模型按自己的 cwd（会话目录）解析这些相对路径就找不到文件。改动前会话 cwd 恰好
 * 等于身份根，所以旧行为在草稿期是对的，现在必须按预热会话目录解析。
 * 预热会话提升为正式会话时复用同一个 id 与同一个目录，因此首发不会闪一下。
 *
 * 身份校验不能省：`lease` 在 effect 里换，切会话 / 切 tab / 从已绑定会话切回草稿的首帧
 * `snapshot` 还是**上一个会话**的，不校验就会把上一会话的执行目录交给这一会话的提及根 /
 * 分享解析根（终端 PTY 一建就不再变）。角色不匹配时回落 tab 的 workspacePath，
 * 与 `useSessionWorkspacePath` 的已知边界 9 同一条规则。
 *
 * 返回值带 `resolved`（形状见 `FileReferenceRoot`）：根是**会话事实**还是纯回落值，上游据此
 * 决定提及能不能投相对路径。判据只有两条，都能证明「根 = 接收方 cwd」：
 * 1. 快照投影了 `workspacePath` ⇒ 该会话有独立执行目录，根就是它；
 * 2. 快照存在但没有该字段 ⇒ 该会话没有独立执行目录（项目/远端/旧 CLI/日期目录降级），
 *    按规则 6 它的 cwd 恒等于工作区键路径 = tab 的 workspacePath，也就是这个回落根。
 * 只有「没有可用的会话快照」（无会话、无预热、首帧身份不匹配、预热被丢弃）才是 `resolved: false`。
 */
export function resolvePaneFileSearchRoot(params: {
  /** 当前 pane 订阅到的快照（lease 换代的中间帧可能是上一个会话的）。 */
  snapshot: Pick<ConversationSnapshot, "sessionId" | "workspacePath"> | null;
  /** shell 绑定的会话（`activeTaskId`）；草稿态为 null。 */
  sessionId: string | null;
  /** 草稿态 pane 实际订阅、首发要用的预热会话 id；未预热时为 null。 */
  prewarmSessionId: string | null;
  /** tab 的工作区路径（对话根），任何一环缺省时回落它 = 改动前行为。 */
  tabWorkspacePath: string;
}): FileReferenceRoot {
  const paneSessionId = params.sessionId ?? params.prewarmSessionId;
  const matchedSnapshot =
    paneSessionId !== null && params.snapshot?.sessionId === paneSessionId ? params.snapshot : null;
  if (!matchedSnapshot) {
    // 没有可用的会话快照：根是回落值。上层据此把提及写成绝对路径（见本接口注释）。
    return { resolved: false, rootPath: params.tabWorkspacePath };
  }
  // 快照带的 `workspacePath` 缺席（项目/远端会话、旧 CLI、降级）时同样回落 tab 路径——
  // 那种会话的 Agent cwd 就是工作区键路径，因此这个回落值是**已被证明**的。
  return {
    resolved: true,
    rootPath: resolveEffectiveWorkspacePath(
      readSessionWorkspacePath(matchedSnapshot),
      params.tabWorkspacePath,
    ),
  };
}

export interface SessionWorkspacePathState {
  /** 快照投影的会话 cwd；会话未绑定 / 旧 CLI 缺席该字段时为 null。 */
  sessionWorkspacePath: string | null;
  /** 文件树、提及、终端、文件搜索应使用的归属目录（带回落）。 */
  effectiveWorkspacePath: string;
  /** 目标会话的快照已到达；路径字段缺席也属于已确认的工作区根。 */
  sessionWorkspacePathReady: boolean;
}

export function isSessionWorkspaceLeaseCurrent(params: {
  binding: { lease: SessionLease; workspacePath: string; agentService: unknown } | null;
  sessionId: string | null;
  workspacePath: string;
  agentService: unknown;
  rpcReady: boolean;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  resolvedRemoteSessionId?: string | null;
}): boolean {
  return Boolean(
    params.rpcReady &&
    !params.workspaceIdentity?.trim() &&
    !params.remoteSessionId?.trim() &&
    !params.resolvedRemoteSessionId &&
    params.binding?.workspacePath === params.workspacePath &&
    params.binding?.agentService === params.agentService &&
    params.binding?.lease.sessionId === params.sessionId,
  );
}

/**
 * 读取「当前 pane 的会话」的执行 cwd。
 *
 * `sessionId` 取自 shell 的 activeTaskId（= 主 pane 绑定的会话，草稿态为 null），
 * `workspacePath` 是 tab 的工作区路径（对话根）。两者都是路由/身份用途的既有值：
 * 连接仍按 endpoint + workspaceKey(= workspaceIdentity ?? workspacePath) 复用，
 * 这里不引入新的身份键。
 *
 * 订阅走既有读取路径：workspaceConnectionRegistry 的共享 SessionDataLayer →
 * 该 topic 的 ConversationProjectionStore（与 pane 内 SessionPane 同一个 store，
 * 只是多一个只读引用，不会另开连接、也不会另开订阅）。快照是 per-session 的，
 * 这里只按派生出的路径字符串订阅，conversation 每帧都不会重渲染调用方。
 */
export function useSessionWorkspacePath(params: {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): SessionWorkspacePathState {
  const { sessionId, workspacePath, workspaceIdentity, remoteSessionId } = params;
  const platform = usePlatform();
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId ?? null,
    workspaceIdentity ?? null,
    undefined,
    "exact",
  );
  const agentService = resolution.services.zcodeAgentService;
  const resolvedRemoteSessionId = resolution.remoteSessionId;
  const rpcReady = resolution.rpcReady;
  const createLocalMediaPreviewUrl = platform.createLocalMediaPreviewUrl;
  const [binding, setBinding] = useState<{
    lease: SessionLease;
    workspacePath: string;
    agentService: typeof agentService;
  } | null>(null);
  const lease = binding?.lease ?? null;

  useEffect(() => {
    // 身份类/远程 workspace 的会话不可能拥有会话执行目录：CLI 侧
    // `isConversationWorkspaceEnabled` 遇到 workspaceIdentity 直接禁用，远端 workspace 的路径形态
    // 也不受本地对话根约束（Host 不会给它们注入对话根标记），因此这种会话的快照不会有
    // `workspacePath`——见 docs/specs/conversation-session-workspace.md 的所有者表与规则 6/7。
    // 所以这里直接清空 lease 并返回：既不 acquireWorkspaceConnection（不借连接层读一个必然缺席的
    // 字段），也不激活远程 service 换代（不引入多余的连接换代副作用）。
    // `resolvedRemoteSessionId` 也算身份类：它可能来自 tab 元数据而不是本函数的 props。
    // 返回值因此恒为 { sessionWorkspacePath: null, effectiveWorkspacePath: workspacePath }。
    if (workspaceIdentity?.trim() || remoteSessionId?.trim() || resolvedRemoteSessionId) {
      setBinding(null);
      return;
    }
    if (!sessionId || !rpcReady) {
      setBinding(null);
      return;
    }

    // acquire/release 成对发生在同一个 effect 里：渲染期不产生引用计数副作用。
    const connectionLease = acquireWorkspaceConnection(
      {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(resolvedRemoteSessionId ? { remoteSessionId: resolvedRemoteSessionId } : {}),
      },
      agentService,
      resolvedRemoteSessionId ? undefined : createLocalMediaPreviewUrl,
    );
    // 远程 proxy 换代只在 commit 阶段激活（与 pane provider 同一约束）。
    connectionLease.activateRemoteService();
    const nextLease = connectionLease.layer.acquire(sessionId);
    setBinding({ lease: nextLease, workspacePath, agentService });
    return () => {
      nextLease.release();
      connectionLease.release();
    };
  }, [
    agentService,
    createLocalMediaPreviewUrl,
    remoteSessionId,
    resolvedRemoteSessionId,
    rpcReady,
    sessionId,
    workspaceIdentity,
    workspacePath,
  ]);

  const store = lease?.store ?? null;
  const subscribe = useCallback(
    (onChange: () => void) => store?.subscribe(onChange) ?? (() => {}),
    [store],
  );
  // 只取派生字符串：conversation 帧变化但会话 cwd 未变时 useSyncExternalStore
  // 走 Object.is 短路，不会把每帧都放大成壳层重渲染。
  const getSessionWorkspacePath = useCallback(
    () => readSessionWorkspacePath(store?.getState().snapshot ?? null),
    [store],
  );
  const sessionWorkspacePath = useSyncExternalStore(subscribe, getSessionWorkspacePath, () => null);
  const getSessionSnapshotReady = useCallback(
    () => isSessionWorkspaceSnapshotReady(store?.getState().snapshot ?? null, sessionId),
    [sessionId, store],
  );
  const sessionSnapshotReady = useSyncExternalStore(
    subscribe,
    getSessionSnapshotReady,
    () => false,
  );
  // 租约换成目标会话之前（切会话/切 workspace tab 的首帧）读到的仍是**上一个**会话的 store：
  // 不校验身份就会把 A 的会话目录交给 B 的文件树根、Cmd+P 与侧栏终端（终端 PTY 建了就不再变）。
  // 首帧必须回落 tab 的 workspacePath（= 已登记的已知边界 9），而不是"另一个会话的目录"。
  // 根因：sessionId 只在所属 Host/workspace 内唯一；effect 清租约前，跨 scope 同 id
  // 仍会命中旧 lease。渲染期同时验证来源，远端不能消费本机遗留目录来创建 PTY。
  const activeLease = isSessionWorkspaceLeaseCurrent({
    binding,
    sessionId,
    workspacePath,
    agentService,
    rpcReady,
    workspaceIdentity,
    remoteSessionId,
    resolvedRemoteSessionId,
  })
    ? (binding?.lease ?? null)
    : null;

  return {
    sessionWorkspacePath: activeLease ? sessionWorkspacePath : null,
    effectiveWorkspacePath: resolveEffectiveWorkspacePath(
      activeLease ? sessionWorkspacePath : null,
      workspacePath,
    ),
    sessionWorkspacePathReady:
      sessionId === null ||
      Boolean(workspaceIdentity?.trim() || remoteSessionId?.trim() || resolvedRemoteSessionId) ||
      Boolean(activeLease && sessionSnapshotReady),
  };
}
