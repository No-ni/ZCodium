import type { ProcessIdentity } from "#src/process/processTreeTypes.js";

export function collectProcessDescendants(
  rootPid: number,
  identities: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const childrenByParentPid = new Map<number, ProcessIdentity[]>();
  for (const identity of identities) {
    const children = childrenByParentPid.get(identity.parentPid) ?? [];
    children.push(identity);
    childrenByParentPid.set(identity.parentPid, children);
  }

  const descendants: ProcessIdentity[] = [];
  const seen = new Set<number>([rootPid]);
  // 深后代链会让递归 DFS 溢出，导致 cleanup 无法取得身份快照；显式帧保留
  // 原先逐个进入子节点的顺序和首次 PID 去重时机，不改变环与重复 PID 的归属。
  const stack = [{ children: childrenByParentPid.get(rootPid) ?? [], nextIndex: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.nextIndex === frame.children.length) {
      stack.pop();
      continue;
    }
    const child = frame.children[frame.nextIndex++]!;
    if (seen.has(child.pid)) continue;
    seen.add(child.pid);
    descendants.push(child);
    stack.push({ children: childrenByParentPid.get(child.pid) ?? [], nextIndex: 0 });
  }
  return descendants;
}
