import {
  nativeContextCompressToolSchema,
  type NativeContextConfiguration,
  type NativeContextStatus,
} from "@zcode/shared/native-context-compression";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "../conversation-session-network.js";
import { getV4ComposerText, setV4ComposerText } from "../v4-conversation.js";
import { runNativeContextCleanup, withNativeContextCleanup } from "./cleanup.js";
import { sendNativeContextPrompt } from "./images.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  nativeContextCurrentTarget,
  readNativeContextRecord,
  readNativeContextSource,
  type NativeContextTestTarget,
} from "./queries.js";
import {
  NATIVE_CONTEXT_MAINTENANCE_MARKER,
  NATIVE_CONTEXT_REPLAY_SUMMARY,
  NATIVE_CONTEXT_SUMMARY_SOURCE_MARKER,
  NATIVE_CONTEXT_AUTO_MAINTENANCE_MARKER,
  NATIVE_CONTEXT_AUTO_SUMMARY_SOURCE_MARKER,
  nativeContextSummaryReplayVariable,
  type NativeContextMaintenanceReplayMode,
} from "./replay-summary.js";
import {
  chooseNativeContextOption,
  closeNativeContextDetails,
  nativeContextElement,
  openNativeContextDetails,
  saveNativeContextConfiguration,
} from "./ui.js";

const REPLAYS = {
  manual: {
    marker: NATIVE_CONTEXT_MAINTENANCE_MARKER,
    sourceMarker: NATIVE_CONTEXT_SUMMARY_SOURCE_MARKER,
    readyMarker: "E2E_NCTX_MAINTENANCE_READY",
    afterMarker: "E2E_NCTX_AFTER_SUMMARY",
    fixturePrefix: "native-",
  },
  automatic: {
    marker: NATIVE_CONTEXT_AUTO_MAINTENANCE_MARKER,
    sourceMarker: NATIVE_CONTEXT_AUTO_SUMMARY_SOURCE_MARKER,
    readyMarker: "E2E_NCTX_AUTO_MAINTENANCE_READY",
    afterMarker: "E2E_NCTX_AUTO_AFTER_SUMMARY",
    fixturePrefix: "native-auto-",
  },
} as const;
const FACTS =
  "The fixture requested repeatable native compression testing. Preserve immutable original image artifacts, exact canonical part identities, completed tool call/result groups, unknown versus zero usage, and original-image retrieval. No file modifications were requested.\n";

async function waitForNativeSummary(
  target: NativeContextTestTarget,
  before: NativeContextStatus,
  mode: NativeContextMaintenanceReplayMode,
) {
  let completed = before;
  await browser.waitUntil(
    async () => {
      completed = await getNativeContextStatus(target);
      const operation = completed.lastOperation;
      if (!operation || operation.operationId === before.lastOperation?.operationId) return false;
      if (["error", "cancelled", "obsolete", "no-benefit"].includes(operation.status))
        throw new Error(
          "NCTX synthetic maintenance did not commit: " + operation.status + "/" + operation.reason,
        );
      return (
        completed.phase === "idle" &&
        operation.kind === "summary" &&
        operation.status === "completed"
      );
    },
    {
      timeout: 90000,
      timeoutMsg: `NCTX ${mode} maintenance did not finish through the existing CLI`,
    },
  );
  return completed;
}

/** 主请求播种真实历史；手动 admission 或下一请求安全点维护复用同一真实链路断言。 */
export async function assertNativeContextMaintenance(
  mode: NativeContextMaintenanceReplayMode = "manual",
) {
  const replay = REPLAYS[mode];
  const target = await nativeContextCurrentTarget();
  const initial = await getNativeContextStatus(target);
  const original: NativeContextConfiguration = {
    schemaVersion: 1,
    mode: initial.policy.mode,
    parameters: structuredClone(initial.policy.parameters),
  };
  const draft = (await getV4ComposerText()) ?? "";
  const candidate = structuredClone(original);
  candidate.mode = mode === "manual" ? "manual" : "auto";
  Object.assign(candidate.parameters.history, {
    preserveTurns: 1,
    preserveMessages: 0,
    preserveTokens: 0,
    protectedTools: ["Read"],
    protectedLatestTools: [],
    earlyFoldTools: [],
    preserveRecentTools: [],
  });
  Object.assign(candidate.parameters.summary, {
    minRangeChars: 1000,
    minChars: 100,
    maxChars: 400,
    minReductionPercent: 10,
    tiersEnabled: false,
  });
  candidate.parameters.tools.reference.enabled = false;
  candidate.parameters.tools.simplify.enabled = false;
  candidate.parameters.tools.distill.enabled = false;
  candidate.parameters.trigger.minBenefitTokens = 1;
  if (mode === "automatic") {
    if (initial.inputBudget === null || initial.inputBudget <= 6000)
      throw new Error("NCTX automatic fixture requires a real main-model input budget above 6000");
    const start = Math.min(3000, Math.floor(initial.inputBudget / 2));
    Object.assign(candidate.parameters.trigger, {
      start: { kind: "tokens", value: start },
      target: { kind: "tokens", value: Math.floor(start / 3) },
      opportunisticPercent: 0,
      capacityPercent: 95,
      waitForUsageSample: false,
      estimateHoldRounds: 0,
      growthMode: "constant",
      growthTokens: 50000,
      checkIntervalRounds: 1000,
      periodicCheckRounds: 0,
      modelDecides: false,
    });
  }
  candidate.parameters.maintenance.stream = "always";
  candidate.parameters.maintenance.model = "follow-current";
  candidate.parameters.prompts.howToCompressRules =
    replay.marker +
    ": case-local synthetic replay. Summarize only complete offered ranges and preserve the stated fixture facts.";
  const seed =
    replay.sourceMarker +
    ":\n" +
    FACTS.repeat(64) +
    '\nReply with exactly "upstream-e2e-ok" and no other text.';
  expect(seed.length).toBeGreaterThan(16000);

  await withNativeContextCleanup(
    async () => {
      await openNativeContextDetails("parameters");
      await chooseNativeContextOption("scope", 0);
      // 原因：共享 suite 已有历史，提前开低阈值 auto 会在本场来源尚不存在时触发维护。
      // 先以 manual 完成真实来源，随后开启 auto，验证下一主请求的安全点而不依赖前场成功。
      await saveNativeContextConfiguration({ ...candidate, mode: "manual" });
      // 原因：capture 索引从零开始，排他过滤需要 count - 1，避免漏掉首个维护尝试。
      const firstIndex = (await getUpstreamRequestRecordCount()) - 1;
      const seeded = await sendNativeContextPrompt(
        replay.sourceMarker,
        replay.fixturePrefix + "summary-source-main",
        4000,
        seed,
      );
      const requestMatch = { includes: [replay.marker + ":", "Use only complete offered ranges"] };
      if (mode === "automatic")
        expect(
          await getUpstreamRequestEvidence(requestMatch, { afterIndex: firstIndex }),
        ).toHaveLength(0);
      let enabled = seeded.status;
      if (mode === "automatic") {
        await openNativeContextDetails("parameters");
        await chooseNativeContextOption("scope", 0);
        await saveNativeContextConfiguration(candidate);
        enabled = await getNativeContextStatus(target);
        expect(enabled.policy.mode).toBe("auto");
        expect(enabled.policy.parameters).toEqual(candidate.parameters);
        expect(
          await getUpstreamRequestEvidence(requestMatch, { afterIndex: firstIndex }),
        ).toHaveLength(0);
      }
      const afterSeedIndex = (await getUpstreamRequestRecordCount()) - 1;
      const ready = await sendNativeContextPrompt(
        replay.readyMarker,
        replay.fixturePrefix + "maintenance-ready-main",
        4200,
      );
      const before = mode === "manual" ? ready.status : enabled;
      const afterIndex =
        mode === "manual" ? (await getUpstreamRequestRecordCount()) - 1 : afterSeedIndex;
      if (mode === "manual") {
        await openNativeContextDetails("overview");
        await nativeContextElement("compress-now").waitForEnabled();
        await nativeContextElement("compress-now").click();
      }
      const completed = await waitForNativeSummary(target, before, mode);
      const requests = await getUpstreamRequestEvidence(requestMatch, { afterIndex });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.fixtureId).toBe(replay.fixturePrefix + "maintenance-summary");
      expect(requests[0]!.status).toBe("complete");
      expect(requests[0]!.statusCode).toBe(200);
      const offered = nativeContextCompressToolSchema.parse(
        JSON.parse(nativeContextSummaryReplayVariable(requests[0]!.requestJson, mode)),
      );
      const operation = completed.lastOperation!;
      expect(operation.trigger).toBe(mode);
      expect(operation.policyVersion).toBe(before.policy.policyVersion);
      expect(operation.generation).toBe(before.generation);
      expect(operation.blockIds.length).toBeGreaterThan(0);
      expect(completed.effectiveBlocks).toBeGreaterThan(before.effectiveBlocks);
      expect(operation.beforeEstimate).not.toBeNull();
      expect(operation.afterEstimate).not.toBeNull();
      expect(operation.afterEstimate!).toBeLessThan(operation.beforeEstimate!);
      if (mode === "automatic") {
        const secondWire = JSON.stringify(ready.request);
        expect(secondWire).toContain(NATIVE_CONTEXT_REPLAY_SUMMARY);
        expect(secondWire).not.toContain(replay.sourceMarker);
        expect(ready.observation.operationIds).toContain(operation.operationId);
        expect(ready.observation.actualInputTokens).toBe(4200);
        expect(ready.observation.inputBudget).toBe(initial.inputBudget);
        expect(ready.observation.startTokens).toBe(candidate.parameters.trigger.start.value);
        expect(ready.observation.targetTokens).toBe(candidate.parameters.trigger.target.value);
      }

      const observations = await listNativeContextObservations(target, completed, {
        purpose: "maintenance",
        operationId: operation.operationId,
        limit: 200,
      });
      expect(observations.items).toHaveLength(1);
      const maintenance = observations.items[0]!;
      expect(maintenance.purpose).toBe("maintenance");
      expect(maintenance.status).toBe("completed");
      expect(maintenance.actualInputTokens).toBe(4800);
      expect(maintenance.outputTokens).toBe(110);
      expect(maintenance.model).toEqual(operation.model);
      expect(maintenance.policyVersion).toBe(operation.policyVersion);
      expect(operation.observationIds).toContain(maintenance.id);

      const detail = await readNativeContextRecord(target, completed, operation.operationId, {
        sourceLimit: 100,
        summaryLimitChars: 1000,
      });
      expect(detail.summary).toBe(NATIVE_CONTEXT_REPLAY_SUMMARY);
      expect(detail.summaryTotalChars).toBe(NATIVE_CONTEXT_REPLAY_SUMMARY.length);
      expect(detail.nextSummaryOffset).toBeNull();
      expect(detail.sources.some((source) => source.ref === offered.ranges[0]!.startRef)).toBe(
        true,
      );
      expect(detail.sources.some((source) => source.ref === offered.ranges[0]!.endRef)).toBe(true);
      let sourceRef: string | undefined;
      for (const source of detail.sources.filter((source) => source.kind === "text")) {
        const page = await readNativeContextSource(target, completed, source.ref);
        if (!page.text.includes(replay.sourceMarker)) continue;
        expect(page.originalAvailable).toBe(true);
        expect(page.text).toContain("immutable original image artifacts");
        expect(page.ref).toBe(source.ref);
        expect(page.revision).toBe(completed.revision);
        sourceRef = source.ref;
        break;
      }
      if (!sourceRef) throw new Error("NCTX completed summary has no recoverable synthetic source");

      await openNativeContextDetails("records");
      await nativeContextElement(`record-${operation.operationId}`).waitForDisplayed();
      await nativeContextElement(`record-${operation.operationId}`).click();
      await nativeContextElement("record-detail").waitForDisplayed();
      await nativeContextElement(`source-${sourceRef}`).click();
      const beforeRead = await getUpstreamRequestRecordCount();
      await nativeContextElement("read-source").click();
      await nativeContextElement("original-text").waitForDisplayed();
      expect(await nativeContextElement("original-text").getValue()).toContain(replay.sourceMarker);
      await nativeContextElement("quote-source").click();
      await closeNativeContextDetails();
      await browser.waitUntil(
        async () => {
          const text = await getV4ComposerText();
          return Boolean(text?.includes(replay.sourceMarker) && text.includes(sourceRef!));
        },
        { timeout: 20000, timeoutMsg: "NCTX source quote did not reach the target Composer draft" },
      );
      expect((await nativeContextCurrentTarget()).sessionId).toBe(target.sessionId);
      expect((await getNativeContextStatus(target)).revision).toBe(completed.revision);
      expect(await getUpstreamRequestRecordCount()).toBe(beforeRead);
      await setV4ComposerText(draft);

      const following = await sendNativeContextPrompt(
        replay.afterMarker,
        replay.fixturePrefix + "after-summary-main",
        4500,
      );
      const wire = JSON.stringify(following.request);
      expect(wire).toContain(NATIVE_CONTEXT_REPLAY_SUMMARY);
      expect(wire).not.toContain(replay.sourceMarker);
      expect(following.observation.operationIds).toContain(operation.operationId);
      expect(following.observation.actualInputTokens).toBe(4500);
      expect(following.observation.afterEstimate!).toBeLessThan(
        following.observation.beforeEstimate!,
      );
      expect(await getUpstreamRequestEvidence(requestMatch, { afterIndex })).toHaveLength(1);
    },
    async () => {
      await runNativeContextCleanup(
        async () => {
          await openNativeContextDetails("parameters");
          await chooseNativeContextOption("scope", 0);
          await saveNativeContextConfiguration(original);
        },
        async () => {
          await closeNativeContextDetails();
          await setV4ComposerText(draft);
        },
      );
    },
  );
}
