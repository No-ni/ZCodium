import type {
  BuildConversationTurnNavigatorItemsOptions,
  ConversationTurnNavigatorItem,
} from "./conversationTurnNavigatorHelpers.js";
import type { ConversationTurnRenderUnit } from "./conversationTurnRenderUnits.js";

interface Entry {
  unitIndex: number;
  options: Required<BuildConversationTurnNavigatorItemsOptions>;
  items: ConversationTurnNavigatorItem[];
}

/** 一个 Navigator 实例一个缓存；弱键不延长历史轮次或已关闭会话的寿命。 */
export class ConversationTurnNavigatorCache {
  private readonly entries = new WeakMap<ConversationTurnRenderUnit, Entry>();

  materialize(
    unit: ConversationTurnRenderUnit,
    unitIndex: number,
    options: Required<BuildConversationTurnNavigatorItemsOptions>,
    build: () => ConversationTurnNavigatorItem[],
  ): ConversationTurnNavigatorItem[] {
    const previous = this.entries.get(unit);
    // 尾轮每帧变化曾让所有历史正文重新 join/split；只复用不可变 unit，
    // 并校验文案与位置，避免换语言、补页或跨会话同 ID 时保留旧摘要/导航目标。
    if (
      previous?.unitIndex === unitIndex &&
      previous.options.assistantEmptyPreview === options.assistantEmptyPreview &&
      previous.options.assistantRunningPreview === options.assistantRunningPreview &&
      previous.options.userFallbackPreview === options.userFallbackPreview &&
      previous.options.maxPreviewChars === options.maxPreviewChars &&
      previous.options.maxPreviewParagraphs === options.maxPreviewParagraphs
    )
      return previous.items;
    const items = build();
    this.entries.set(unit, { unitIndex, options, items });
    return items;
  }
}
