import { type Modifier } from "@dnd-kit/core";
import type { QueueState } from "@zcode/shared/zcode-protocol-v4";

type QueueItem = QueueState["items"][number];

/**
 * 编辑锁归属（docs/ui/composer-edit-mode.md「锁的释放」）：本端锁 = editorId 相同且本地编辑态正在编辑该项。
 * Bug 根因：
 * - lock ACK 可能早于 editLock 投影；只看投影时，该行会先回到普通行再变成占位。投影确认前以本端编辑态为准。
 * - 曾只按 editorId 判定本端，刷新后遗留锁的自动释放失败时，该行只有聚焦按钮、没有「解除」，队首一直冻结。
 *   没有本地编辑态的锁一律按其他端显示，带「解除」入口。
 */
function resolveEditLockOwner(
  item: QueueItem,
  editorId: string | undefined,
  activeEditQueueItemId: string | null,
  activeEditLockConfirmed: boolean,
): "self" | "other" | null {
  const editingHere = activeEditQueueItemId === item.queueItemId;
  if (!item.editLock) return editingHere && !activeEditLockConfirmed ? "self" : null;
  return editingHere && item.editLock.editorId === editorId ? "self" : "other";
}

export interface V4QueueReorderAnchor {
  beforeQueueItemId: string | null;
  queueItemId: string;
}

export function resolveV4QueueReorderAnchor(
  items: readonly QueueItem[],
  activeQueueItemId: string,
  overQueueItemId: string,
): V4QueueReorderAnchor | null {
  if (activeQueueItemId === overQueueItemId) {
    return null;
  }

  const fromIndex = items.findIndex((item) => item.queueItemId === activeQueueItemId);
  const overIndex = items.findIndex((item) => item.queueItemId === overQueueItemId);
  if (fromIndex < 0 || overIndex < 0) {
    return null;
  }

  if (fromIndex < overIndex) {
    const itemsAfterRemoval = items.filter((item) => item.queueItemId !== activeQueueItemId);
    const overIndexAfterRemoval = itemsAfterRemoval.findIndex(
      (item) => item.queueItemId === overQueueItemId,
    );
    const nextItem = itemsAfterRemoval[overIndexAfterRemoval + 1];
    return {
      beforeQueueItemId: nextItem?.queueItemId ?? null,
      queueItemId: activeQueueItemId,
    };
  }

  return {
    beforeQueueItemId: overQueueItemId,
    queueItemId: activeQueueItemId,
  };
}

const restrictQueueDragToPanel: Modifier = ({
  transform,
  draggingNodeRect,
  activeNodeRect,
  containerNodeRect,
  windowRect,
}) => {
  const nodeRect = draggingNodeRect ?? activeNodeRect;
  const boundaryRect = containerNodeRect ?? windowRect;
  if (!nodeRect || !boundaryRect) {
    return {
      ...transform,
      x: 0,
    };
  }

  const minY = boundaryRect.top - nodeRect.top;
  const maxY = boundaryRect.bottom - nodeRect.bottom;
  return {
    ...transform,
    x: 0,
    y: Math.min(Math.max(transform.y, minY), maxY),
  };
};
export { type QueueItem, resolveEditLockOwner, restrictQueueDragToPanel };
