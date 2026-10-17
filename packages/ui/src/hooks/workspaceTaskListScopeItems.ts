import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

interface WorkspaceTaskListScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

function bucketItemsByWorkspace(
  items: ZCodeTaskMeta[],
  requestedKeys: ReadonlySet<string>,
): Map<string, ZCodeTaskMeta[]> {
  const buckets = new Map<string, ZCodeTaskMeta[]>();
  for (const workspaceKey of requestedKeys) buckets.set(workspaceKey, []);
  for (const item of items) {
    const workspaceKey = buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity);
    buckets.get(workspaceKey)?.push(item);
  }
  return buckets;
}

export function buildWorkspaceTaskListScopeItems(params: {
  scopes: WorkspaceTaskListScope[];
  sessions: ZCodeTaskMeta[];
  taskIndexItems: ZCodeTaskMeta[];
}) {
  const scopes = params.scopes.map((scope) => ({
    scope,
    workspaceKey: buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  }));
  if (scopes.length === 0) return [];
  // 每个 scope 各 filter 全量列表会重复扫描其它 workspace；本轮分桶只读取每行一次，
  // 并沿用 identity key。桶不跨 refresh 保留，避免新 membership/activity 命中旧数据。
  const requestedKeys = new Set(scopes.map(({ workspaceKey }) => workspaceKey));
  const sessions = bucketItemsByWorkspace(params.sessions, requestedKeys);
  const taskIndexItems = bucketItemsByWorkspace(params.taskIndexItems, requestedKeys);
  return scopes.map(({ scope, workspaceKey }) => ({
    scope,
    workspaceKey,
    // 重复 scope 仍有各自的输入数组，保留原 filter 的修改隔离与行引用。
    sessions: sessions.get(workspaceKey)?.slice() ?? [],
    taskIndexItems: taskIndexItems.get(workspaceKey)?.slice() ?? [],
  }));
}
