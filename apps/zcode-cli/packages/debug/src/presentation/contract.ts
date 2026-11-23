/** 只读观察数据的展示契约；无业务持久化或网络采样。 */
export interface ObservationEventState {
 connected: boolean;
 error: string | null;
 lastChangeAt?: string;
 watchedPathCount: number;
}
export type {
  CacheReport, ContextSectionSource, ContextSnapshotView, ContextUsageSnapshotView,
  ContextUsageSource, ProjectSummary, SourceStatus, TokenConfidence, TokenMethod,
  TimelineItem, TraceDetailResponse, TraceSpan, TraceSpanLane, TraceSummary,
} from "../shared.js";
export type DebugView = "trace" | "gantt";
