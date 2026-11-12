import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "../conversation-session-network.js";
import { buildReadonlyToolPrompt } from "../conversation-session-readonly-tool.js";
import { getV4Messages, sendV4Prompt, waitForV4ConversationState } from "../v4-conversation.js";
import { getNativeContextStatus, nativeContextCurrentTarget } from "./queries.js";

/** 共用现有 Read 链路建立完整历史，保留真实响应行供后续 fork 边界复用。 */
export async function createNativeContextReadonlyHistory(marker: string) {
  // 原因：证据过滤采用排他索引，count 是下一条索引；减一才能包含首个真实请求。
  const afterIndex = (await getUpstreamRequestRecordCount()) - 1;
  await sendV4Prompt(buildReadonlyToolPrompt(marker));
  await waitForV4ConversationState(
    (state) => state.state === "idle" && state.queueCount === 0,
    "NCTX readonly setup did not complete through the real Read tool",
    90000,
  );
  let requests = await getUpstreamRequestEvidence({ includes: [marker] }, { afterIndex });
  await browser.waitUntil(
    async () => {
      requests = await getUpstreamRequestEvidence({ includes: [marker] }, { afterIndex });
      return requests.some(
        (request) => request.fixtureId === "native-history-main" && request.status === "complete",
      );
    },
    {
      timeout: 90000,
      timeoutMsg: "NCTX readonly tool did not settle through its case-local main fixture",
    },
  );
  expect(requests.map((request) => request.fixtureId)).toEqual([
    "upstream-conversation-readonly-tool-call",
    "native-history-main",
  ]);
  expect(
    requests.every((request) => request.status === "complete" && request.statusCode === 200),
  ).toBe(true);
  const target = await nativeContextCurrentTarget();
  let status = await getNativeContextStatus(target);
  await browser.waitUntil(
    async () => {
      status = await getNativeContextStatus(target);
      return (
        status.lastObservation?.status === "completed" &&
        status.lastObservation.actualInputTokens === 1800
      );
    },
    { timeout: 20000, timeoutMsg: "NCTX readonly history did not freeze its actual usage" },
  );
  expect(status.policy.mode).toBe("auto");
  expect(status.lastObservation?.purpose).toBe("main");
  const rowId = (await getV4Messages("assistant")).at(-1)?.id;
  if (!rowId) throw new Error("NCTX completed Read response has no stable row identity");
  return { target, requestSeq: status.lastObservation!.requestSeq, rowId };
}
