import type {
  ConversationRow,
  ConversationRowsPartition,
  SessionPhase,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  BuildConversationTurnRenderUnitsOptions,
  ConversationTurnRenderUnit,
} from "./conversationTurnRenderUnitTypes.js";

export interface ConversationTurnRenderUnitsPartition {
  readonly history: readonly ConversationTurnRenderUnit[];
  readonly tail: readonly ConversationTurnRenderUnit[];
}

export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface DraftBase {
  key: string;
  header?: TurnHeaderRow;
  orderedRows: ConversationRow[];
}
type Options = BuildConversationTurnRenderUnitsOptions;

/** 算法与全量 builder 共用端口；只缓存派生值，不修改 rows/组织态。 */
export function createRenderPartitionSelector<Draft extends DraftBase>(ports: {
  group: (rows: readonly ConversationRow[]) => Draft[];
  materialize: (
    draft: Draft,
    index: number,
    total: number,
    options: Options,
  ) => ConversationTurnRenderUnit;
  keep: (unit: ConversationTurnRenderUnit) => boolean;
  normalize: (
    unit: ConversationTurnRenderUnit,
    index: number,
    total: number,
    options: Options,
  ) => ConversationTurnRenderUnit;
  running: (draft: Draft, options: Options) => boolean;
  pinned: (row: ConversationRow, resolver?: Options["pluginUiPinResolver"]) => boolean;
}) {
  type Entry = {
    draft: Draft;
    last: boolean;
    phase?: SessionPhase;
    clock?: number;
    pins: ConversationRow[];
    unit: ConversationTurnRenderUnit;
  };
  type History = {
    rows: readonly ConversationRow[];
    draftCount: number;
    phaseDependent: boolean;
    phase?: SessionPhase;
    clockDependent: boolean;
    clock: number;
    pinDependent: boolean;
    resolver?: Options["pluginUiPinResolver"];
    units: ConversationTurnRenderUnit[];
    tailDropped?: { phase?: SessionPhase; units: readonly ConversationTurnRenderUnit[] };
  };
  let history: History | null = null;
  let historyEntries = new Map<string, Entry>();
  let tailEntries = new Map<string, Entry>();
  const buildEntry = (
    draft: Draft,
    index: number,
    total: number,
    options: Options & { nowMs: number },
    lookup: (key: string) => Entry | undefined,
    next: Map<string, Entry>,
  ) => {
    const old = lookup(draft.key);
    const last = index === total - 1;
    const phase = draft.header ? undefined : options.sessionPhase;
    const clock = ports.running(draft, options) ? options.nowMs : undefined;
    const pins = draft.orderedRows.filter((row) => ports.pinned(row, options.pluginUiPinResolver));
    const unchanged =
      old &&
      old.draft.header === draft.header &&
      sameItems(old.draft.orderedRows, draft.orderedRows) &&
      old.last === last &&
      old.phase === phase &&
      old.clock === clock &&
      sameItems(old.pins, pins);
    const entry = {
      draft,
      last,
      phase,
      clock,
      pins,
      unit: unchanged ? old.unit : ports.materialize(draft, index, total, options),
    };
    next.set(draft.key, entry);
    return entry;
  };
  return (
    partition: ConversationRowsPartition,
    options: Options = {},
  ): ConversationTurnRenderUnitsPartition => {
    const current = { ...options, nowMs: options.nowMs ?? Date.now() };
    const oldHistory = historyEntries,
      oldTail = tailEntries;
    const tailDrafts = ports.group(partition.tail);
    const reusable =
      history &&
      history.rows === partition.history &&
      (!history.phaseDependent || history.phase === current.sessionPhase) &&
      (!history.clockDependent || history.clock === current.nowMs) &&
      (!history.pinDependent || history.resolver === current.pluginUiPinResolver);
    if (!reusable) {
      const drafts = ports.group(partition.history);
      const next = new Map<string, Entry>();
      let clockDependent = false;
      const materialized = drafts.map((draft, index) => {
        const entry = buildEntry(
          draft,
          index,
          drafts.length + tailDrafts.length,
          current,
          (key) => oldHistory.get(key) ?? oldTail.get(key),
          next,
        );
        clockDependent ||= entry.clock !== undefined;
        return entry.unit;
      });
      historyEntries = next;
      const kept = materialized.filter(ports.keep);
      history = {
        rows: partition.history,
        draftCount: drafts.length,
        phaseDependent: drafts.some((draft) => !draft.header),
        phase: current.sessionPhase,
        clockDependent,
        clock: current.nowMs,
        pinDependent: drafts.some((draft) => draft.orderedRows.some((row) => ports.pinned(row))),
        resolver: current.pluginUiPinResolver,
        units: kept.map((unit, index) => ports.normalize(unit, index, kept.length + 1, current)),
      };
    }
    const cache = history!;
    const nextTail = new Map<string, Entry>();
    const tailKept = tailDrafts
      .map(
        (draft, index) =>
          buildEntry(
            draft,
            cache.draftCount + index,
            cache.draftCount + tailDrafts.length,
            current,
            (key) => oldTail.get(key) ?? oldHistory.get(key),
            nextTail,
          ).unit,
      )
      .filter(ports.keep);
    tailEntries = nextTail;
    const tail = tailKept.map((unit, index) =>
      ports.normalize(
        unit,
        cache.units.length + index,
        cache.units.length + tailKept.length,
        current,
      ),
    );
    let historic: readonly ConversationTurnRenderUnit[] = cache.units;
    // 尾轮全被过滤时重归一化历史末项；按 phase 缓存，避免每帧换引用。
    if (tail.length === 0 && cache.units.length > 0) {
      if (!cache.tailDropped || cache.tailDropped.phase !== current.sessionPhase) {
        const index = cache.units.length - 1;
        const last = ports.normalize(cache.units[index]!, index, cache.units.length, current);
        cache.tailDropped = {
          phase: current.sessionPhase,
          units: last === cache.units[index] ? cache.units : [...cache.units.slice(0, -1), last],
        };
      }
      historic = cache.tailDropped.units;
    }
    return { history: historic, tail };
  };
}
