import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  WindowHostControllerTaskActivity,
  WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { areStabilizedValuesEquivalent } from "@/v4/taskListItemStabilization.js";
import type { ProjectAvailability } from "@/project-sidebar/contract.js";

export const sameReadErrors = (
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
) =>
  left.size === right.size && [...left].every(([hostId, message]) => right.get(hostId) === message);
export const sameAvailability = (
  left: ReadonlyMap<string, ProjectAvailability>,
  right: ReadonlyMap<string, ProjectAvailability>,
) =>
  left.size === right.size &&
  [...right].every(([key, value]) => areStabilizedValuesEquivalent(left.get(key), value));

/**
 * 实时 sessions-index 只附加 activity sidecar，不补行也不写回归属；
 * 缺 sidecar 的会话不产生 address，由项目树的行集合决定可见性。
 */
export function collectSessionRowActivities(items: readonly ZCodeTaskMeta[]): {
  address: WindowHostTaskAddress;
  activity: WindowHostControllerTaskActivity;
}[] {
  return items.flatMap((task) => {
    const live = getTaskListRowActivity(task);
    return live
      ? [
          {
            address: {
              taskId: task.taskId,
              workspacePath: task.workspacePath,
              workspaceIdentity: task.workspaceIdentity,
            },
            activity: live,
          },
        ]
      : [];
  });
}
