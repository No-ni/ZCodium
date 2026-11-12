import {
  type NativeContextConfiguration,
  type NativeContextStatus,
} from "@zcode/shared/native-context-compression";
import { TID_V4_STOP } from "@zcode/shared/test-ids";
import { resolveSeededReplayBaseUrl } from "../custom-openai-provider-store.js";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "../conversation-session-network.js";
import { releaseControlledReplay } from "../controlled-replay.js";
import { getV4ComposerText, setV4ComposerText } from "../v4-conversation.js";
import { runNativeContextCleanup, withNativeContextCleanup } from "./cleanup.js";
import { sendNativeContextPrompt } from "./images.js";
import { nativeContextOfferedSourceRef } from "./maintenance-source.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  nativeContextCurrentTarget,
  readNativeContextRecord,
  readNativeContextSource,
} from "./queries.js";
import {
  chooseNativeContextOption,
  closeNativeContextDetails,
  nativeContextElement,
  openNativeContextDetails,
  saveNativeContextConfiguration,
} from "./ui.js";

export type NativeContextInterruption = "stop" | "mode" | "parameters";
const facts =
  "Keep immutable original context, exact image refs, complete tool exchanges, the chosen model and all paid maintenance usage. No file changes were requested.\n";

async function held(fixtureId: string) {
  const base = await resolveSeededReplayBaseUrl();
  if (!base) throw new Error("NCTX interruption requires the existing replay server");
  const response = await fetch(`${base}/__e2e__/gates`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("NCTX interruption gate read failed");
  return ((await response.json()) as string[]).includes(fixtureId);
}

/** 每场只使用现有 Composer/参数命令；SSE 门确认请求确实开始之后才执行中断。 */
export async function assertNativeContextMaintenanceInterruption(kind: NativeContextInterruption) {
  const target = await nativeContextCurrentTarget();
  const initial = await getNativeContextStatus(target);
  const original: NativeContextConfiguration = {
    schemaVersion: 1,
    mode: initial.policy.mode,
    parameters: structuredClone(initial.policy.parameters),
  };
  const candidate = structuredClone(original);
  const marker = `E2E_NCTX_INTERRUPT_${kind.toUpperCase()}`;
  const fixture = `native-interrupt-${kind}-maintenance`;
  const draft = (await getV4ComposerText()) ?? "";
  candidate.mode = "auto";
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
  Object.assign(candidate.parameters.trigger, {
    start: { kind: "percent", value: 90 },
    target: { kind: "percent", value: 70 },
    opportunisticPercent: 0,
    periodicCheckRounds: 0,
    modelDecides: false,
  });
  candidate.parameters.maintenance.stream = "always";
  candidate.parameters.maintenance.model = "follow-current";
  candidate.parameters.prompts.howToCompressRules = `${marker}: controlled synthetic maintenance interruption.`;

  let before: NativeContextStatus | undefined;
  let afterIndex = -1;
  return await withNativeContextCleanup(
    async () => {
      await openNativeContextDetails("parameters");
      await chooseNativeContextOption("scope", 0);
      await saveNativeContextConfiguration(candidate);
      await sendNativeContextPrompt(
        `${marker}_SOURCE`,
        `native-interrupt-${kind}-source`,
        4000,
        `${marker}_SOURCE:\n${facts.repeat(128)}\nReply with exactly "upstream-e2e-ok".`,
      );
      const ready = await sendNativeContextPrompt(
        `${marker}_READY`,
        `native-interrupt-${kind}-ready`,
        4200,
      );
      before = ready.status;
      afterIndex = (await getUpstreamRequestRecordCount()) - 1;
      await setV4ComposerText("");
      await openNativeContextDetails("overview");
      await nativeContextElement("compress-now").waitForEnabled();
      await nativeContextElement("compress-now").click();
      await browser.waitUntil(() => held(fixture), {
        timeout: 20000,
        timeoutMsg: "NCTX interrupted maintenance did not reach a real SSE gate",
      });
      const running = await getNativeContextStatus(target);
      expect(running.phase).toBe("compressing");
      expect(running.lastOperation?.status).toBe("running");
      const operationId = running.lastOperation!.operationId;
      const frozenModel = running.lastOperation!.model;
      expect(operationId).not.toBe(before.lastOperation?.operationId);
      expect(running.lastOperation!.policyVersion).toBe(before.policy.policyVersion);
      const started = await getUpstreamRequestEvidence(
        { includes: [marker, "Use only complete offered ranges"] },
        { afterIndex },
      );
      expect(started).toHaveLength(1);
      expect(started[0]!.fixtureId).toBe(fixture);
      const sourceRef = nativeContextOfferedSourceRef(started[0]!.requestJson, `${marker}_SOURCE`);
      const originalPage = await readNativeContextSource(target, running, sourceRef);
      expect(originalPage.ref).toBe(sourceRef);
      expect(originalPage.originalAvailable).toBe(true);
      expect(originalPage.nextOffset).toBeNull();
      expect(originalPage.text).toContain(`${marker}_SOURCE`);
      expect(originalPage.revision).toBe(running.revision);
      expect(originalPage.generation).toBe(running.generation);
      expect(originalPage.historyVersion).toBe(running.historyVersion);

      if (kind === "stop") {
        await closeNativeContextDetails();
        const stop = $(`[data-testid="${TID_V4_STOP}"]`);
        await stop.waitForDisplayed();
        await stop.click();
      } else if (kind === "mode") {
        await closeNativeContextDetails();
        await nativeContextElement("entry").click();
        await nativeContextElement("auto-switch").waitForEnabled();
        expect(await nativeContextElement("auto-switch").getAttribute("aria-checked")).toBe("true");
        await nativeContextElement("auto-switch").click();
      } else {
        const changed = structuredClone(candidate);
        changed.parameters.summary.maxChars = 401;
        await openNativeContextDetails("parameters");
        await saveNativeContextConfiguration(changed);
      }

      let completed = running;
      await browser.waitUntil(
        async () => {
          completed = await getNativeContextStatus(target);
          return (
            completed.phase === "idle" &&
            completed.lastOperation?.operationId === operationId &&
            completed.lastOperation.status === (kind === "stop" ? "cancelled" : "obsolete")
          );
        },
        {
          timeout: 20000,
          timeoutMsg: "NCTX interrupted maintenance did not converge to its terminal record",
        },
      );
      expect(completed.lastOperation!.reason).toBe(
        kind === "stop" ? "cancelled" : "policy-changed",
      );
      expect(completed.lastOperation!.model).toEqual(frozenModel);
      // 首次 running 同步了已经落盘的 assistant；执行边界不能与上一发送前的 history hash 混用。
      for (const field of [
        "historyVersion",
        "policyVersion",
        "generation",
        "segmentId",
        "anchorMessageId",
        "anchorRequestSeq",
      ] as const)
        expect(completed.lastOperation![field]).toEqual(running.lastOperation![field]);
      expect(completed.effectiveBlocks).toBe(running.effectiveBlocks);
      expect(completed.historyVersion).toBe(running.historyVersion);
      expect(completed.currentSegmentId).toBe(running.currentSegmentId);
      expect(completed.lastOperation!.blockIds).toEqual([]);
      if (kind === "mode") expect(completed.policy.mode).toBe("manual");
      if (kind === "parameters") expect(completed.policy.parameters.summary.maxChars).toBe(401);

      const observations = await listNativeContextObservations(target, completed, {
        purpose: "maintenance",
        operationId,
        limit: 200,
      });
      expect(observations.items).toHaveLength(1);
      const observation = observations.items[0]!;
      expect(observation.status).toBe("cancelled");
      expect(observation.actualInputTokens).toBe(4800);
      expect(observation.model).toEqual(frozenModel);
      expect(observation.policyVersion).toBe(running.lastOperation!.policyVersion);
      expect(completed.lastOperation!.observationIds).toContain(observation.id);
      const detail = await readNativeContextRecord(target, completed, operationId);
      expect(detail.summary).toBe("");
      expect(detail.historyVersion).toBe(running.lastOperation!.historyVersion);
      expect(detail.anchorMessageId).toBe(running.lastOperation!.anchorMessageId);
      expect(detail.anchorRequestSeq).toBe(running.lastOperation!.anchorRequestSeq);
      const page = await readNativeContextSource(target, completed, sourceRef);
      expect(page.originalAvailable).toBe(true);
      expect(page.ref).toBe(originalPage.ref);
      expect(page.nextOffset).toBeNull();
      expect(page.text).toBe(originalPage.text);
      expect(page.revision).toBe(completed.revision);
      expect(page.generation).toBe(originalPage.generation);
      expect(page.historyVersion).toBe(originalPage.historyVersion);
      const requests = await getUpstreamRequestEvidence(
        { includes: [marker, "Use only complete offered ranges"] },
        { afterIndex },
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]!.fixtureId).toBe(fixture);
      expect(requests[0]!.statusCode).toBe(200);
      expect(await held(fixture)).toBe(false);
      return { kind, operation: completed.lastOperation, observation };
    },
    async () => {
      await runNativeContextCleanup(
        async () => {
          if (await held(fixture)) await releaseControlledReplay(fixture);
        },
        async () => {
          await closeNativeContextDetails();
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
