import { releaseControlledReplay } from "../controlled-replay.js";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "../conversation-session-network.js";
import { sendV4Prompt, waitForV4ConversationState } from "../v4-conversation.js";
import { withNativeContextCleanup } from "./cleanup.js";
import {
  assertNativeContextMobileConfiguration,
  assertNativeContextMobileObservation,
  closeNativeContextMobileDetails,
  type NativeContextMobileBrowser,
} from "./mobile.js";
import { getNativeContextStatus, type NativeContextTestTarget } from "./queries.js";
import { assertNativeContextMobileLayout } from "./trends.js";
import { closeNativeContextDetails } from "./ui.js";

/** 只操作 runner 已创建的同一手机 Page；Provider/Host/CLI 在恢复前后保持同一实例。 */
export async function assertNativeContextMobileRecovery(
  mobile: NativeContextMobileBrowser,
  target: NativeContextTestTarget,
  marker: string,
  evidenceDirectory: string,
) {
  await mobile.openTask(target.sessionId);
  await assertNativeContextMobileConfiguration(mobile.page, await getNativeContextStatus(target));
  for (const width of [320, 390, 736])
    await assertNativeContextMobileLayout(mobile.page, width, evidenceDirectory);
  await closeNativeContextDetails();
  // 原因：下一请求的索引等于 count；排他边界应使用已存在的末索引。
  const afterIndex = (await getUpstreamRequestRecordCount()) - 1;
  await withNativeContextCleanup(
    async () => {
      await sendV4Prompt(`${marker}: Reply with exactly "upstream-e2e-ok" and no other text.`);
      await waitForV4ConversationState(
        (state) => state.state === "streaming",
        "NCTX mobile recovery has no real running request",
        30000,
      );
      await mobile.hide();
      await mobile.page.reload({ waitUntil: "domcontentloaded" });
      await mobile.show();
      await mobile.openTask(target.sessionId);
      await assertNativeContextMobileConfiguration(
        mobile.page,
        await getNativeContextStatus(target),
      );
      expect(
        (
          await getUpstreamRequestEvidence({ lastUserMessageIncludes: [marker] }, { afterIndex })
        ).map((request) => request.fixtureId),
      ).toEqual(["native-mobile-share-main"]);
    },
    async () => {
      await releaseControlledReplay("native-mobile-share-main");
    },
  );
  await waitForV4ConversationState(
    (state) => state.state === "idle" && state.queueCount === 0,
    "NCTX same desktop CLI did not settle after mobile replay recovery",
    90000,
  );
  let completed = await getNativeContextStatus(target);
  await browser.waitUntil(
    async () => {
      completed = await getNativeContextStatus(target);
      return (
        completed.lastObservation?.status === "completed" &&
        completed.lastObservation.actualInputTokens === 3400
      );
    },
    { timeout: 20000, timeoutMsg: "NCTX mobile did not retain the same completed observation" },
  );
  await assertNativeContextMobileObservation(mobile.page, completed.lastObservation!);
  expect(
    await getUpstreamRequestEvidence({ lastUserMessageIncludes: [marker] }, { afterIndex }),
  ).toHaveLength(1);
  await mobile.screenshot("shared-host-recovered.png");
  await closeNativeContextMobileDetails(mobile.page);
}
