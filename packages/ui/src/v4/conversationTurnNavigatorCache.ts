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

type Options = Required<BuildConversationTurnNavigatorItemsOptions>;
type BodyRow = Readonly<{ text: string }>;

interface PreviewEntry {
  options: Options;
  fallback: string;
  rows: readonly BodyRow[];
  exhausted: boolean;
  text: string;
}

/** 一个 Navigator 实例一个缓存；弱键不延长历史轮次或已关闭会话的寿命。 */
export class ConversationTurnNavigatorCache {
  private readonly entries = new WeakMap<ConversationTurnRenderUnit, Entry>();
  private readonly previews = new WeakMap<BodyRow, PreviewEntry>();

  preview(
    rows: readonly BodyRow[],
    fallback: string,
    options: Options,
    create: (texts: Iterable<string>) => string,
  ): string {
    const first = rows[0];
    if (!first) return fallback;
    const previous = this.previews.get(first);
    // unit 会因尾部工具/状态重建，正文行却不变；只比较实际消费前缀，避免再扫完整 body。
    // 已耗尽来源时必须比较行数，追加正文仍会失效；弱行键不按复用的 turnId 混用新会话。
    if (
      previous &&
      previous.fallback === fallback &&
      Object.is(previous.options.maxPreviewChars, options.maxPreviewChars) &&
      Object.is(previous.options.maxPreviewParagraphs, options.maxPreviewParagraphs) &&
      (!previous.exhausted || previous.rows.length === rows.length) &&
      previous.rows.every((row, index) => row === rows[index])
    )
      return previous.text;
    const consumed: BodyRow[] = [];
    let exhausted = false;
    function* texts() {
      for (const row of rows) {
        consumed.push(row);
        yield row.text;
      }
      exhausted = true;
    }
    const text = create(texts());
    this.previews.set(first, { options, fallback, rows: consumed, exhausted, text });
    return text;
  }

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
