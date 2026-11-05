import { createE2EReportViewerUrl, readE2EReportSummary } from "./index.js";
import type { E2EReportContract } from "./contract.js";
const report: E2EReportContract = { createE2EReportViewerUrl, readE2EReportSummary };
/** 仅构造合成报告URL，不访问真实用户数据或打开浏览器。 */
export function exampleReportViewer(summaryJsonPath: string) {
  return report.createE2EReportViewerUrl({ summaryJsonPath, baseUrl: "http://127.0.0.1:4173/" });
}
