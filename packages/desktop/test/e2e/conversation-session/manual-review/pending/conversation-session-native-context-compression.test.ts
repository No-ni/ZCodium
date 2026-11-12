import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createRecommendedNativeContextConfiguration,
  nativeContextCacheHitPercent,
} from "@zcode/shared/native-context-compression";
import { getUpstreamRequestRecordCount } from "#e2e/helpers/conversation-session-network";
import {
  ensureReadonlyToolFixtureFile,
  E2E_READONLY_TOOL_FILE_PATH,
} from "#e2e/helpers/conversation-session-readonly-tool";
import { installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";
import { prepareV4ConversationE2E, selectV4TaskById } from "#e2e/helpers/v4-conversation";
import {
  assertNativeContextOldFork,
  assertNativeContextLatestFork,
} from "#e2e/helpers/native-context-compression/branches";
import {
  runNativeContextCleanup,
  withNativeContextCleanup,
} from "#e2e/helpers/native-context-compression/cleanup";
import { assertNativeContextDefaultsForFutureTask } from "#e2e/helpers/native-context-compression/defaults";
import {
  assertNativeContextTestPath,
  prepareNativeContextEvidenceDirectory,
} from "#e2e/helpers/native-context-compression/environment";
import { createNativeContextPngFixture } from "#e2e/helpers/native-context-compression/fixture";
import { createNativeContextReadonlyHistory } from "#e2e/helpers/native-context-compression/history";
import { assertNativeContextCompactCurrentSegment } from "#e2e/helpers/native-context-compression/compact-trend";
import { assertNativeContextMaintenance } from "#e2e/helpers/native-context-compression/maintenance";
import { assertNativeContextMaintenanceInterruption } from "#e2e/helpers/native-context-compression/maintenance-interruption";
import {
  inspectNativeContextImageRecord,
  nativeContextWireImages,
  sendNativeContextImage,
  sendNativeContextPrompt,
  type NativeContextImageEvidence,
} from "#e2e/helpers/native-context-compression/images";
import {
  createNativeContextMobileBrowser,
  type NativeContextMobileBrowser,
} from "#e2e/helpers/native-context-compression/mobile";
import { assertNativeContextMobileRecovery } from "#e2e/helpers/native-context-compression/mobile-recovery";
import { assertNativeContextReadImage } from "#e2e/helpers/native-context-compression/read-image";
import {
  assertNativeContextImageOmission,
  NATIVE_CONTEXT_IMAGE_OMISSION_REPLAY,
} from "#e2e/helpers/native-context-compression/image-omission";
import {
  assertNativeContextImageFailureFollowup,
  assertNativeContextReadImageCapacity,
  assertNativeContextReadImageUnsupported,
  type NativeContextImageNegativeEvidence,
} from "#e2e/helpers/native-context-compression/image-negative";
import { NativeContextImageFollowupError } from "#e2e/helpers/native-context-compression/image-negative-followup";
import { assertNativeContextParameterLayout } from "#e2e/helpers/native-context-compression/parameter-layout";
import { assertNativeContextLargeLedgerProduct } from "#e2e/helpers/native-context-compression/ledger";
import { assertNativeContextLargeLedgerMobile } from "#e2e/helpers/native-context-compression/ledger-mobile";
import { seedNativeContextLargeLedgerForE2E } from "#e2e/helpers/native-context-compression/ledger-seed";
import type { NativeContextLedgerManifest } from "#e2e/helpers/native-context-compression/ledger-fixture-contract";
import {
  assertNativeContextSettingsLayout,
  assertNativeContextMobileSettingsLayout,
} from "#e2e/helpers/native-context-compression/settings-layout";
import { assertNativeContextMobileSystemLocale } from "#e2e/helpers/native-context-compression/mobile-system-locale";
import {
  assertNativeContextExport,
  assertNativeContextJsonValidationAndDrafts,
  assertNativeContextParameterRegistry,
  assertNativeContextTaskAndDefaultDraftIsolation,
} from "#e2e/helpers/native-context-compression/parameters";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  nativeContextCurrentTarget,
  type NativeContextTestTarget,
} from "#e2e/helpers/native-context-compression/queries";
import {
  assertNativeContextBoundedReads,
  assertNativeContextForeignRef,
  assertNativeContextStaleView,
  recoverNativeContextFromColdRestart,
} from "#e2e/helpers/native-context-compression/recovery";
import {
  assertNativeContextTrendInteractions,
  assertNativeContextTrendLayout,
} from "#e2e/helpers/native-context-compression/trends";
import {
  closeNativeContextDetails,
  chooseNativeContextOption,
  nativeContextElement,
  openNativeContextDetails,
  saveNativeContextConfiguration,
} from "#e2e/helpers/native-context-compression/ui";

const MARKERS = {
  history: "E2E_NCTX_HISTORY",
  opaque: "E2E_NCTX_IMAGE_OPAQUE",
  duplicate: "E2E_NCTX_IMAGE_DUPLICATE",
  transparent: "E2E_NCTX_IMAGE_TRANSPARENT",
  zero: "E2E_NCTX_ZERO",
  unknownCache: "E2E_NCTX_UNKNOWN_CACHE",
  cacheAfterUnknown: "E2E_NCTX_CACHE_AFTER_UNKNOWN",
  defaultNewTask: "E2E_NCTX_DEFAULT_NEW_TASK",
  mobile: "E2E_NCTX_MOBILE_SHARE",
  restart: "E2E_NCTX_AFTER_RESTART",
} as const;

/** pending/manual-review：共享一套进程和真实产品链路，不伪造人工转正或真模型质量证据。 */
describe("原生上下文压缩共享环境 E2E", function () {
  this.timeout(180000);
  let evidenceDirectory = "";
  let environmentPrepared = false;
  let target: NativeContextTestTarget;
  let futureTask: NativeContextTestTarget;
  let readonlyRowId: string;
  let readonlyRequestSeq: number;
  let opaqueEvidence: NativeContextImageEvidence;
  let duplicateEvidence: NativeContextImageEvidence;
  let mobile: NativeContextMobileBrowser | undefined;
  let largeLedger: NativeContextLedgerManifest | undefined;
  let coldRecovered = false;
  let transparentCompleted = false;
  let readImageCompleted = false;
  let blockedBy: string | null = null;
  const opaque = createNativeContextPngFixture();
  const transparent = createNativeContextPngFixture(640, 400, true);
  const cases: Array<{
    name: string;
    state: string;
    errorName: string | null;
    blockedBy: string | null;
  }> = [];
  const prerequisite = (value: unknown, name: string) => {
    if (value !== undefined && value !== null) return;
    blockedBy = name;
    throw new Error(`NCTX blocked by prerequisite: ${name}`);
  };
  const writeEvidence = async (filename: string, value: unknown) => {
    await writeFile(
      await assertNativeContextTestPath(join(evidenceDirectory, filename)),
      JSON.stringify(value, null, 2),
    );
  };
  const imageFailureWithFollowup = async (
    kind: "unsupported" | "capacity",
    action: () => Promise<NativeContextImageNegativeEvidence>,
  ) => {
    const negative = await action();
    await writeEvidence(`image-negative-${kind}.json`, negative);
    try {
      await writeEvidence(
        `image-negative-${kind}-followup.json`,
        await assertNativeContextImageFailureFollowup(negative),
      );
    } catch (error) {
      if (error instanceof NativeContextImageFollowupError)
        await writeEvidence(`image-negative-${kind}-followup.json`, error.evidence);
      throw error;
    }
  };

  before(async () => {
    evidenceDirectory = await prepareNativeContextEvidenceDirectory();
    await assertNativeContextTestPath(E2E_READONLY_TOOL_FILE_PATH);
    await ensureReadonlyToolFixtureFile();
    await prepareV4ConversationE2E();
    environmentPrepared = true;
    await installHandoffRpcProbe();
  });

  afterEach(async function () {
    const test = this.currentTest;
    cases.push({
      name: test?.title ?? "unknown",
      state: test?.state ?? "unknown",
      errorName: test?.err?.name ?? null,
      blockedBy,
    });
    blockedBy = null;
    if (!evidenceDirectory) return;
    await withNativeContextCleanup(
      async () => {
        await writeFile(
          await assertNativeContextTestPath(join(evidenceDirectory, "case-results.json")),
          JSON.stringify({ humanReviewed: false, promoted: false, cases }, null, 2),
        );
      },
      async () => {
        if (environmentPrepared) await closeNativeContextDetails();
      },
    );
  });

  after(async () => {
    await runNativeContextCleanup(
      async () => {
        await mobile?.close();
        mobile = undefined;
      },
      async () => {
        await browser.electron.restoreAllMocks();
      },
      async () => {
        if (environmentPrepared)
          await browser.execute(() => window.__remoteProjectHandoffRpc?.restore());
      },
    );
    // 保留本次隔离证据，不删除用户数据或通过再次初始化掩盖恢复失败。
  });

  it("NCTX-03 空草稿：入口可达、未知用量、无摘要范围与零模型请求", async () => {
    const before = await getUpstreamRequestRecordCount();
    await nativeContextElement("entry").waitForDisplayed();
    await nativeContextElement("entry").click();
    await nativeContextElement("popover").waitForDisplayed();
    expect(await nativeContextElement("popover").getText()).toContain("—");
    expect(await nativeContextElement("auto-switch").getAttribute("aria-checked")).toBe("true");
    expect(await nativeContextElement("compress-now").isEnabled()).toBe(false);
    await nativeContextElement("recent-trend-popover").waitForDisplayed();
    expect(await getUpstreamRequestRecordCount()).toBe(before);
  });

  it("NCTX-01/06 真实Read历史：新任务auto，CLI请求与完成用量冻结", async () => {
    const history = await createNativeContextReadonlyHistory(MARKERS.history);
    target = history.target;
    readonlyRequestSeq = history.requestSeq;
    readonlyRowId = history.rowId;
  });

  it("NCTX-23/24 90项普通表单、JSON和同一个strict参数schema一致", async () => {
    prerequisite(target, "NCTX-01/06 admitted Read history");
    await assertNativeContextParameterRegistry();
  });

  it("NCTX-27/60 非法JSON、依赖、NaN与跨页签/Escape独立草稿", async () => {
    prerequisite(target, "NCTX-01/06 admitted Read history");
    await assertNativeContextJsonValidationAndDrafts();
  });

  for (const [scope, index] of [
    ["task", 0],
    ["defaults", 1],
  ] as const) {
    it(`NCTX-21/23/57/60 ${scope}参数：四种宽度的真实鼠标/键盘与底栏可达`, async () => {
      prerequisite(target, "NCTX-01/06 admitted Read history");
      await openNativeContextDetails("parameters");
      await chooseNativeContextOption("scope", index);
      await nativeContextElement(`parameters-${scope}`).waitForDisplayed();
      await withNativeContextCleanup(
        async () => {
          for (const width of [1024, 736, 390, 320])
            await assertNativeContextParameterLayout(width, scope);
        },
        async () => {
          await chooseNativeContextOption("scope", 0);
        },
      );
    });
  }

  it("NCTX-20/23 默认/任务保存隔离与新任务真实捕获完整默认", async () => {
    prerequisite(target, "NCTX-01/06 admitted Read history");
    await assertNativeContextTaskAndDefaultDraftIsolation();
    futureTask = await assertNativeContextDefaultsForFutureTask(MARKERS.defaultNewTask);
    expect((await nativeContextCurrentTarget()).sessionId).toBe(target.sessionId);
  });

  it("NCTX-24/60 原生配置导出与取消：工作树落点、完整配置不带policyVersion", async () => {
    prerequisite(target, "NCTX-01/06 admitted Read history");
    await assertNativeContextExport(evidenceDirectory);
  });

  it("NCTX-21/23/56 常规设置默认入口、四种宽度及浅深主题/中英文可达", async function () {
    this.timeout(300000);
    prerequisite(target, "NCTX-01/06 admitted Read history");
    await closeNativeContextDetails();
    await assertNativeContextSettingsLayout(evidenceDirectory);
    expect((await nativeContextCurrentTarget()).sessionId).toBe(target.sessionId);
  });

  it("NCTX-04/06/11/16/49 真实手动维护：offered范围、独立用量、原文引用与下一主请求摘要", async () => {
    prerequisite(target, "NCTX-01/06 admitted Read history");
    await assertNativeContextMaintenance();
  });

  it("NCTX-04/06/11/16 真实自动摘要：第二轮安全点付费维护、原文对账与后续主请求生效", async () => {
    prerequisite(target, "NCTX-01/06 admitted Read history");
    await assertNativeContextMaintenance("automatic");
  });

  for (const kind of ["stop", "mode", "parameters"] as const) {
    it(`NCTX-07/25 真实维护在途${kind}：候选作废、原执行费用保留与原文可读`, async () => {
      prerequisite(target, "NCTX-01/06 admitted Read history");
      const result = await assertNativeContextMaintenanceInterruption(kind);
      await writeFile(
        await assertNativeContextTestPath(
          join(evidenceDirectory, `maintenance-interruption-${kind}.json`),
        ),
        JSON.stringify(result, null, 2),
      );
    });
  }

  it("NCTX-28/31 opaque PNG真实发送降采样，原图分块和只读预览可恢复", async () => {
    prerequisite(target, "NCTX-01/06 admitted Read history");
    const configuration = createRecommendedNativeContextConfiguration();
    Object.assign(configuration.parameters.images, {
      maxEdge: 320,
      minEdge: 128,
      keepRecentUserTurns: 100,
      foldWithHistory: false,
      omitSeen: false,
      pngMode: "preserve",
      alphaMode: "preserve",
    });
    await saveNativeContextConfiguration(configuration);
    expect(opaque.bytes.length).toBeGreaterThan(512 * 1024);
    opaqueEvidence = await sendNativeContextImage(
      MARKERS.opaque,
      "native-opaque-main",
      opaque,
      1,
      2600,
    );
    await inspectNativeContextImageRecord(opaqueEvidence, opaque);
  });

  it("NCTX-29/41 同bytes两张真实上传：独立canonical part/ref，发送字节逐图对账", async () => {
    prerequisite(opaqueEvidence, "NCTX-28/31 completed opaque upload");
    duplicateEvidence = await sendNativeContextImage(
      MARKERS.duplicate,
      "native-duplicate-main",
      opaque,
      2,
      2700,
    );
    expect(new Set([...opaqueEvidence.originalRefs, ...duplicateEvidence.originalRefs]).size).toBe(
      3,
    );
  });

  it("NCTX-32 透明PNG副本解码后仍有真实alpha，原图未被副本覆盖", async () => {
    prerequisite(opaqueEvidence, "NCTX-28/31 completed opaque upload");
    const evidence = await sendNativeContextImage(
      MARKERS.transparent,
      "native-transparent-main",
      transparent,
      1,
      2800,
    );
    expect(evidence.originalSha256).not.toBe(opaqueEvidence.originalSha256);
    await inspectNativeContextImageRecord(evidence, transparent);
    transparentCompleted = true;
  });

  it("NCTX-10/19/55 原图和记录有界分页、跨任务ref拒绝、真实策略修改使旧页失效", async () => {
    prerequisite(duplicateEvidence, "NCTX-29/41 completed duplicate upload");
    prerequisite(futureTask, "NCTX-20/23 future task defaults");
    await assertNativeContextBoundedReads(target, duplicateEvidence);
    await assertNativeContextForeignRef(futureTask, opaqueEvidence);
    await assertNativeContextStaleView(target, opaqueEvidence);
  });

  it("NCTX-46/47/48 API真零与缺缓存字段保持区别，缓存零分母不显示0%", async () => {
    prerequisite(target, "NCTX-01/06 admitted Read history");
    const zero = await sendNativeContextPrompt(MARKERS.zero, "native-zero-main", 0);
    expect(zero.observation.actualInputTokens).toBe(0);
    expect(zero.observation.cacheReadTokens).toBe(0);
    expect(nativeContextCacheHitPercent(zero.observation)).toBeNull();
    const unknown = await sendNativeContextPrompt(
      MARKERS.unknownCache,
      "native-unknown-cache-main",
      3100,
    );
    expect(unknown.observation.cacheReadTokens).toBeNull();
    expect(unknown.observation.cacheCreateTokens).toBeNull();
    expect(unknown.observation.visionTokens).toBeNull();
    expect(nativeContextCacheHitPercent(unknown.observation)).toBeNull();
    const resumed = await sendNativeContextPrompt(
      MARKERS.cacheAfterUnknown,
      "native-cache-after-unknown-main",
      3200,
    );
    expect(resumed.observation.cacheReadTokens).toBe(0);
    expect(resumed.observation.cacheCreateTokens).toBe(0);
    expect(nativeContextCacheHitPercent(resumed.observation)).toBe(0);
  });

  it("NCTX-12/36/44/53 稳定old/latest fork：边界裁掉未来、策略和原图持有本地化", async () => {
    prerequisite(duplicateEvidence, "NCTX-29/41 completed duplicate upload");
    await assertNativeContextOldFork(opaqueEvidence, readonlyRowId, readonlyRequestSeq);
    await assertNativeContextLatestFork(duplicateEvidence);
  });

  it("NCTX-45/56/57 三图联动、系列、范围、键盘、记录返回和桌面窄宽布局", async () => {
    prerequisite(target, "NCTX-01/06 admitted Read history");
    await assertNativeContextTrendInteractions();
    for (const width of [1024, 736, 390, 320])
      await assertNativeContextTrendLayout(width, evidenceDirectory);
  });

  it("NCTX-58 桌面3000条合成账本：有界分页、真实SVG极值/缺口与原始点详情", async function () {
    this.timeout(300000);
    prerequisite(target, "NCTX-01/06 admitted Read history");
    const status = await getNativeContextStatus(target);
    prerequisite(status.lastObservation, "NCTX completed main model identity");
    largeLedger = await seedNativeContextLargeLedgerForE2E({
      model: status.lastObservation!.model,
      version: "e2e-native-ledger-v1",
    });
    await withNativeContextCleanup(
      async () => {
        const result = await assertNativeContextLargeLedgerProduct(largeLedger!);
        await writeFile(
          await assertNativeContextTestPath(join(evidenceDirectory, "large-ledger-desktop.json")),
          JSON.stringify({ synthetic: true, ...result }, null, 2),
        );
      },
      async () => {
        await closeNativeContextDetails();
        await selectV4TaskById(target.sessionId);
      },
    );
  });

  it("NCTX-18/26/55 手机同Host/CLI：在途请求真实reload与tab隐藏/恢复", async () => {
    prerequisite(target, "NCTX-01/06 admitted Read history");
    await closeNativeContextDetails();
    const sharedMobile = await createNativeContextMobileBrowser(evidenceDirectory);
    mobile = sharedMobile;
    await assertNativeContextMobileRecovery(
      sharedMobile,
      target,
      MARKERS.mobile,
      evidenceDirectory,
    );
  });

  it("NCTX-21/23/56 手机复用页面：常规设置默认入口、参数底栏、主题与语言", async function () {
    this.timeout(300000);
    prerequisite(mobile, "NCTX-18 existing paired mobile Page");
    await mobile!.openTask(target.sessionId);
    await assertNativeContextMobileSettingsLayout(mobile!.page, evidenceDirectory);
    await assertNativeContextMobileSystemLocale(mobile!.page, evidenceDirectory);
  });

  it("NCTX-58 手机复用页面：3000条账本分页、真实SVG极值/缺口与原始点详情", async function () {
    this.timeout(300000);
    prerequisite(mobile, "NCTX-18 existing paired mobile Page");
    prerequisite(largeLedger, "NCTX-58 seeded immutable large ledger fixture");
    await withNativeContextCleanup(
      async () => {
        await mobile!.openTask(largeLedger!.sessionId);
        const result = await assertNativeContextLargeLedgerMobile(mobile!.page, largeLedger!);
        await writeFile(
          await assertNativeContextTestPath(join(evidenceDirectory, "large-ledger-mobile.json")),
          JSON.stringify({ synthetic: true, ...result }, null, 2),
        );
      },
      async () => {
        await mobile!.page.keyboard.press("Escape");
        await mobile!.openTask(target.sessionId);
      },
    );
  });

  it("NCTX-28/38/44 关闭auto后原图只读仍可用；唯一一次冷重启恢复策略/数字/原图", async () => {
    prerequisite(opaqueEvidence, "NCTX-28/31 completed opaque upload");
    const status = await getNativeContextStatus(target);
    await saveNativeContextConfiguration({
      schemaVersion: 1,
      mode: "manual",
      parameters: status.policy.parameters,
    });
    const before = await getUpstreamRequestRecordCount();
    await inspectNativeContextImageRecord(opaqueEvidence, opaque);
    expect(await getUpstreamRequestRecordCount()).toBe(before);
    await mobile?.close();
    mobile = undefined;
    expect((await recoverNativeContextFromColdRestart(opaqueEvidence)).policy.mode).toBe("manual");
    coldRecovered = true;
  });

  it("NCTX-38/44 冷恢复后首个真实主请求保留manual策略和既有图片发送副本", async () => {
    prerequisite(duplicateEvidence, "NCTX-29/41 completed duplicate upload");
    prerequisite(coldRecovered || undefined, "NCTX-38/44 cold recovery");
    prerequisite(transparentCompleted || undefined, "NCTX-32 transparent upload");
    const previous = await getNativeContextStatus(target);
    const result = await sendNativeContextPrompt(
      MARKERS.restart,
      "native-after-restart-main",
      3500,
    );
    expect(result.status.policy).toEqual(previous.policy);
    const images = nativeContextWireImages(result.request);
    expect(images).toHaveLength(4);
    expect(images.every((image) => image.bytes.length < opaque.bytes.length)).toBe(true);
    const observations = await listNativeContextObservations(target, result.status, { limit: 200 });
    expect(observations.items.some((item) => item.id === opaqueEvidence.observation.id)).toBe(true);
  });

  it("NCTX-30/42 模型真实回取原PNG：同callId、原字节一次发送与独立主用量", async () => {
    prerequisite(opaqueEvidence, "NCTX-28/31 completed opaque upload");
    const before = await getNativeContextStatus(target);
    const configuration = {
      schemaVersion: 1 as const,
      mode: before.policy.mode,
      parameters: before.policy.parameters,
    };
    await withNativeContextCleanup(
      async () => {
        await saveNativeContextConfiguration({
          ...configuration,
          mode: "auto",
        });
        const evidence = await assertNativeContextReadImage(opaqueEvidence, opaque, MARKERS.opaque);
        readImageCompleted = true;
        await writeFile(
          await assertNativeContextTestPath(join(evidenceDirectory, "read-image-result.json")),
          JSON.stringify(evidence, null, 2),
        );
      },
      async () => {
        await saveNativeContextConfiguration(configuration);
      },
    );
  });

  it("NCTX-34/40/41/43 成功图片证明、省略保护、manual保持与改码后重送", async function () {
    this.timeout(300000);
    prerequisite(duplicateEvidence, "NCTX-29/41 completed duplicate upload");
    prerequisite(transparentCompleted || undefined, "NCTX-32 completed transparent upload");
    prerequisite(coldRecovered || undefined, "NCTX-38/44 cold recovery");
    prerequisite(readImageCompleted || undefined, "NCTX-30/42 original model roundtrip");
    const replay = NATIVE_CONTEXT_IMAGE_OMISSION_REPLAY;
    await writeEvidence(
      "image-omission.json",
      await assertNativeContextImageOmission({
        target,
        sources: [
          {
            marker: MARKERS.opaque,
            count: 1,
            sha256: opaque.sha256,
            refs: opaqueEvidence.originalRefs,
          },
          {
            marker: MARKERS.duplicate,
            count: 2,
            sha256: opaque.sha256,
            refs: duplicateEvidence.originalRefs,
          },
          { marker: MARKERS.transparent, count: 1, sha256: transparent.sha256 },
        ],
        newImage: opaque,
        markers: {
          prime: replay.prime.marker,
          omit: replay.omit.marker,
          manual: replay.manual.marker,
          disabled: replay.disabled.marker,
          reencoded: replay.reencoded.marker,
        },
      }),
    );
  });

  it("NCTX-33 非vision原图回取：同Provider明确反馈且恢复模型后新消息可用", async function () {
    this.timeout(300000);
    prerequisite(opaqueEvidence, "NCTX-28/31 completed opaque upload");
    await imageFailureWithFollowup("unsupported", () =>
      assertNativeContextReadImageUnsupported(opaqueEvidence, opaque),
    );
  });

  it("NCTX-15/45/48 深度整理后当前历史段为空，旧主曲线和维护事件不串段", async () => {
    prerequisite(target, "NCTX-01/06 admitted Read history");
    // 真实 compact 改写当前历史；先完成冷恢复及四张既有图片发送的验收。
    await assertNativeContextCompactCurrentSegment();
  });

  it("NCTX-33 原图超过真实硬预算：同Provider拒绝且新消息继续可用", async function () {
    this.timeout(300000);
    prerequisite(futureTask, "NCTX-20/23 existing future task");
    await withNativeContextCleanup(
      async () => {
        await closeNativeContextDetails();
        await selectV4TaskById(futureTask.sessionId);
        await imageFailureWithFollowup("capacity", () => assertNativeContextReadImageCapacity());
      },
      async () => {
        await closeNativeContextDetails();
        await selectV4TaskById(target.sessionId);
      },
    );
  });
});
