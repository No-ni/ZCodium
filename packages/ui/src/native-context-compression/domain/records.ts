import type { NativeContextOperationDetail } from "../contract.js";

/** 来源和摘要分别翻页时不能把同一条记录的不同只读世代拼在一起。 */
export function assertNativeContextRecordPage(
  current: NativeContextOperationDetail,
  page: NativeContextOperationDetail,
): void {
  if (
    current.operationId !== page.operationId ||
    current.revision !== page.revision ||
    current.viewGeneration !== page.viewGeneration ||
    current.viewHistoryVersion !== page.viewHistoryVersion ||
    current.sourceTotal !== page.sourceTotal ||
    current.summaryTotalChars !== page.summaryTotalChars
  )
    throw new Error("native-context-record-view-changed");
}
