import type { ZCodeModelTrajectoryRecord } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

function SourceTitle({ record, intl }: { record: ZCodeModelTrajectoryRecord; intl: IntlShape }) {
  const callSource: NonNullable<ZCodeModelTrajectoryRecord["callSource"]> = record.callSource ?? {
    kind: "main",
  };
  const labelId = sourceLabelId(callSource);

  return (
    <span
      data-trajectory-source-title=""
      // E2E 曾把英文展示文案当成功能合同，切换到中文后误报轨迹投影失败；稳定属性保留原始语义，文案继续独立国际化。
      data-trajectory-source-kind={callSource.kind}
      data-trajectory-query-source={callSource.querySource}
      className="min-w-0 shrink truncate text-ui-sm font-medium text-foreground"
      title={callSource.querySource ? `querySource: ${callSource.querySource}` : undefined}
    >
      {intl.formatMessage({ id: labelId })}
    </span>
  );
}

function sourceLabelId(callSource: NonNullable<ZCodeModelTrajectoryRecord["callSource"]>): string {
  switch (callSource.querySource) {
    case "main_turn":
      return "modelTrajectory.source.main";
    case "session_title":
      return "modelTrajectory.source.sessionTitle";
    case "compact":
      return "modelTrajectory.source.compact";
    case "prompt_enhance":
      return "modelTrajectory.source.promptEnhance";
    case "target_completion_verification":
      return "modelTrajectory.source.targetCompletion";
    case "subagent":
      return "modelTrajectory.source.subagent";
    default:
      break;
  }

  switch (callSource.kind) {
    case "main":
      return "modelTrajectory.source.main";
    case "subagent":
      return "modelTrajectory.source.subagent";
    case "compact":
      return "modelTrajectory.source.compact";
    case "sidecar":
      return "modelTrajectory.source.sidecar";
    case "unknown":
      return "modelTrajectory.source.unknown";
  }
}
export { SourceTitle, sourceLabelId };
