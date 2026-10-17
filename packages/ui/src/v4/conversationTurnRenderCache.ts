import type { ConversationRow, SessionPhase, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnRenderUnit } from "./conversationTurnRenderUnits.js";

interface Entry {
  rows: readonly ConversationRow[];
  header?: TurnHeaderRow;
  last: boolean;
  phase?: SessionPhase;
  pins: readonly boolean[];
  unit: ConversationTurnRenderUnit;
}

/** 一个 Timeline 实例一个缓存；仅持有当前窗口，不能跨 session 共享。 */
export class ConversationTurnRenderCache {
  private entries = new Map<string, Entry>();
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) if (!keys.has(key)) this.entries.delete(key);
  }
  materialize(
    key: string,
    input: Omit<Entry, "unit">,
    build: () => ConversationTurnRenderUnit,
  ): ConversationTurnRenderUnit {
    const previous = this.entries.get(key);
    // 完整 immutable row 引用 + 折叠裁决决定分组；不能只按 rowId 缓存，upsert/rewind 会沿用 ID。
    if (
      previous &&
      previous.header === input.header &&
      previous.last === input.last &&
      previous.phase === input.phase &&
      previous.rows.length === input.rows.length &&
      previous.rows.every((row, i) => row === input.rows[i]) &&
      previous.pins.length === input.pins.length &&
      previous.pins.every((pin, i) => pin === input.pins[i])
    )
      return previous.unit;
    const unit = build();
    this.entries.set(key, { ...input, unit });
    return unit;
  }
}
