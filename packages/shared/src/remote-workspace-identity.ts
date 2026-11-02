// 远程 workspace identity 的统一解析工具（Workspace Identity 约束：构造与解析
// 必须复用统一工具，禁止业务代码手写拼接/拆解规则）。
// 构造侧（对偶）：packages/ui/src/lib/remoteWorkspaceHistory.ts 的
// buildRemoteWorkspaceIdentity —— 格式契约：
//   remote:ssh:<host>:<port>:<username>:<posixPath>
//   remote:wsl:<distro>[:<user>]:<posixPath>
//   remote:docker:<container>:<posixPath>
// path 段经 normalizeWorkspacePathForIdentity 归一（分隔符 → "/"，去收尾斜杠，
// 空 → "/"），因此恒以 "/" 开头；authority 各段不含 "/"，SSH host 可以含 IPv6 冒号，
// port/username 与 docker 容器名/wsl 发行版名不含 ":" 与 "/"。
// 消费方：CLI v4 createSession 的 workspaceId（远程 pane 里 workspaceKey =
// identity）需要还原出真实 workspacePath 作为会话 workingDirectory。
import type { RemoteTarget } from "./remoteTarget.js";

/** Agent 子进程沿用 Host 的 workspace identity，不能按同路径合并远端环境。 */
export const ZCODE_WORKSPACE_IDENTITY_ENV = "ZCODE_WORKSPACE_IDENTITY";

export type RemoteWorkspaceIdentityKind = "ssh" | "wsl" | "docker" | "server";

export interface ParsedRemoteWorkspaceIdentity {
  kind: RemoteWorkspaceIdentityKind;
  serverId?: string;
  /** kind=server 时的稳定 Source Server id。 */
  sourceServerId?: string;
  /** 远端真实路径（posix 归一形态）。 */
  workspacePath: string;
}

const REMOTE_IDENTITY_PREFIX = "remote:";

/** authority 必选段数（不含 kind）：ssh = host/port/username，其余远端类型 = 单段。 */
const AUTHORITY_SEGMENTS: Record<RemoteWorkspaceIdentityKind, number> = {
  ssh: 3,
  wsl: 1,
  docker: 1,
  server: 1,
};

function isRemoteWorkspaceIdentityKind(value: string): value is RemoteWorkspaceIdentityKind {
  return value === "ssh" || value === "wsl" || value === "docker" || value === "server";
}

function normalizeWorkspacePathForIdentity(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}

export interface BuildServerRemoteWorkspaceIdentityOptions {
  serverId: string;
  workspacePath: string;
}

/**
 * 统一构造远程 workspace identity。Host、Main 和 UI 禁止自行拼接 authority；
 * `workspacePath` 只在这里归一后进入身份键，实际 IO 仍使用调用方原路径。
 */
export function buildRemoteWorkspaceIdentity(workspacePath: string, target: RemoteTarget): string {
  const normalizedPath = normalizeWorkspacePathForIdentity(workspacePath);
  switch (target.kind) {
    case "ssh":
      return `remote:ssh:${target.host.trim().toLowerCase()}:${target.port ?? 22}:${target.username.trim()}:${normalizedPath}`;
    case "wsl": {
      const distro = target.distro?.trim() || "default";
      const user = target.user?.trim();
      return user
        ? `remote:wsl:${distro}:${user}:${normalizedPath}`
        : `remote:wsl:${distro}:${normalizedPath}`;
    }
    case "docker":
      return `remote:docker:${target.container}:${normalizedPath}`;
    case "server":
      return buildServerRemoteWorkspaceIdentity({
        serverId: target.serverId ?? "",
        workspacePath: normalizedPath,
      });
  }
}

/** Source 身份只来自已鉴权的安装握手，不由连接地址推导。 */
export function buildServerRemoteWorkspaceIdentity(input: {
  serverId: string;
  workspacePath: string;
}): string {
  const serverId = input.serverId.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(serverId)) throw new Error("Invalid Source Server identity");
  return `remote:server:${serverId}:${normalizeWorkspacePathForIdentity(input.workspacePath)}`;
}

/**
 * 解析远程 workspace identity；非法/非远程 identity 返回 null（调用方回落
 * 「按本地 workspacePath 处理」）。只提取 workspacePath——authority 细节
 * （host/port 等）对消费方（CLI 运行在远端机器上）无意义，不透出。
 */
export function parseRemoteWorkspaceIdentity(
  identity: string,
): ParsedRemoteWorkspaceIdentity | null {
  if (!identity.startsWith(REMOTE_IDENTITY_PREFIX)) {
    return null;
  }
  const rest = identity.slice(REMOTE_IDENTITY_PREFIX.length);
  const kindEnd = rest.indexOf(":");
  if (kindEnd <= 0) {
    return null;
  }
  const kind = rest.slice(0, kindEnd);
  if (!isRemoteWorkspaceIdentityKind(kind)) {
    return null;
  }
  if (kind === "ssh") {
    // IPv6 host 自带冒号，固定消费三段会把合法身份解析成 null；从路径边界向左取用户和端口。
    const pathBoundary = rest.indexOf(":/", kindEnd + 1);
    if (pathBoundary < 0) return null;
    const userBoundary = rest.lastIndexOf(":", pathBoundary - 1);
    const portBoundary = rest.lastIndexOf(":", userBoundary - 1);
    if (
      portBoundary <= kindEnd + 1 ||
      userBoundary <= portBoundary + 1 ||
      pathBoundary <= userBoundary + 1
    ) {
      return null;
    }
    // `::` 是合法 IPv6 地址；上方只检查必选段边界，实际地址仍由原连接入口验证。
    return { kind, workspacePath: rest.slice(pathBoundary + 1) };
  }
  // 逐段消费 authority；path 段可能含 ":"（理论上 posix 路径允许），
  // 因此不能整体 split——按段推进后取剩余整段为 path。
  let cursor = kindEnd + 1;
  for (let i = 0; i < AUTHORITY_SEGMENTS[kind]; i++) {
    const next = rest.indexOf(":", cursor);
    if (next <= cursor) {
      return null;
    }
    cursor = next + 1;
  }
  // WSL identity 为区分默认用户与显式用户增加了可选 user 段，旧解析器
  // 仍只消费 distro，导致 user 被误判为路径并让 identity 整体解析失败。远端路径
  // 必须以 "/" 开头，因此可以无歧义地区分 legacy 无 user 格式与显式 user 格式。
  if (kind === "wsl" && rest[cursor] !== "/") {
    const userEnd = rest.indexOf(":", cursor);
    if (userEnd <= cursor) {
      return null;
    }
    cursor = userEnd + 1;
  }
  const workspacePath = rest.slice(cursor);
  if (!workspacePath.startsWith("/")) {
    return null;
  }
  if (kind === "server") {
    const serverId = rest.slice(kindEnd + 1, cursor - 1);
    if (!/^[A-Za-z0-9_-]+$/.test(serverId)) return null;
    // 新契约名称与旧解析调用共享同一已验证 ID，不重写历史 identity 或路径。
    return { kind, serverId, sourceServerId: serverId, workspacePath };
  }
  return { kind, workspacePath };
}

/** identity 是否是远程 workspace identity（可被 parseRemoteWorkspaceIdentity 解析）。 */
export function isRemoteWorkspaceIdentity(identity: string): boolean {
  return parseRemoteWorkspaceIdentity(identity) !== null;
}

/** 虚拟项目的 host 身份；只在统一 identity 模块裁剪路径，业务层不得自行拆 authority。 */
export function remoteHostIdFromWorkspaceIdentity(identity: string): string | null {
  const parsed = parseRemoteWorkspaceIdentity(identity);
  return parsed ? identity.slice(0, -(parsed.workspacePath.length + 1)) : null;
}

/** 从已登记的 Host 身份构造目录身份；不让业务模块拼接或解析 authority。 */
export function buildRemoteHostWorkspaceIdentity(hostId: string, workspacePath: string): string {
  const identity = `${hostId}:${normalizeWorkspacePathForIdentity(workspacePath)}`;
  if (remoteHostIdFromWorkspaceIdentity(identity) !== hostId)
    throw new Error("Invalid remote host identity");
  return identity;
}
