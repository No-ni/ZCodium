import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { NativeContextObservation } from "@zcode/shared/native-context-compression";
import type { NativeContextLedgerManifest } from "./ledger-fixture-contract.js";
import {
  assertNativeContextLargeLedgerSelectedSvg,
  assertNativeContextLargeLedgerSvg,
  readNativeContextLargeLedgerSvg,
} from "./ledger-chart.js";

const element = (page: Page, id: string) => page.getByTestId("native-context-" + id);
const choose = async (page: Page, id: string, index: number) => {
  await element(page, id).click();
  await page.getByRole("option").nth(index).click();
};

async function waitForMainCount(page: Page, count: number) {
  await page.waitForFunction(
    (expected) => {
      const chart = document.querySelector('[data-testid="native-context-input-chart"]');
      return Number(chart?.getAttribute("data-request-count")) === expected;
    },
    count,
    { timeout: 20000 },
  );
}

async function selectOriginal(page: Page, original: NativeContextObservation) {
  await element(page, "trend-request").click();
  const option = page
    .getByRole("option")
    .filter({ hasText: new RegExp(`^#${original.requestSeq}\\s*·`) });
  assert.equal(await option.count(), 1);
  await option.scrollIntoViewIfNeeded();
  await option.click();
  await page.waitForFunction(
    (id) =>
      document
        .querySelector('[data-testid="native-context-request-details"]')
        ?.getAttribute("data-observation-id") === id,
    original.id,
    { timeout: 10000 },
  );
  for (const [key, expected] of Object.entries({
    beforeEstimate: original.beforeEstimate,
    afterEstimate: original.afterEstimate,
    actualInput: original.actualInputTokens,
    cacheRead: original.cacheReadTokens,
    cacheCreate: original.cacheCreateTokens,
  })) {
    const text = await element(page, "request-metric-" + key)
      .locator("p.font-mono")
      .innerText();
    assert.equal(
      expected === null ? text : Number(text.replace(/[,，\s]/gu, "")),
      expected === null ? "—" : expected,
    );
  }
  for (const chart of ["input-chart", "cache-chart", "image-chart"])
    assert.equal(
      await element(page, chart).getAttribute("data-selected-observation-id"),
      original.id,
    );
}

/** 传入已配对、已打开该任务的现有手机 Page；调用者负责返回短任务，不创建任何连接/浏览器。 */
export async function assertNativeContextLargeLedgerMobile(
  page: Page,
  manifest: NativeContextLedgerManifest,
) {
  if (!(await element(page, "details").isVisible())) {
    await element(page, "entry").click();
    await element(page, "open-trends").click();
  }
  await element(page, "tab-trends").click();
  await choose(page, "trend-segment", 0);
  await choose(page, "trend-range", 2);
  await waitForMainCount(page, 200);
  for (let loaded = 200; loaded < manifest.counts.main; ) {
    const expected = Math.min(loaded + 200, manifest.counts.main);
    await element(page, "trends-load-more").click();
    await waitForMainCount(page, expected);
    loaded = expected;
  }
  assert.equal(await element(page, "trends-load-more").count(), 0);
  for (const chart of ["input-chart", "cache-chart", "image-chart"])
    assert.equal(
      Number(await element(page, chart).getAttribute("data-request-count")),
      manifest.counts.main,
    );
  assert.equal(Number(await element(page, "trends").getAttribute("data-maintenance-count")), 30);
  await choose(page, "cache-unit", 0);
  const input = await page.evaluate(readNativeContextLargeLedgerSvg, {
    chartId: "input-chart",
    series: "after",
  });
  const cache = await page.evaluate(readNativeContextLargeLedgerSvg, {
    chartId: "cache-chart",
    series: "hit",
  });
  const svg = assertNativeContextLargeLedgerSvg(manifest, input, cache);
  await selectOriginal(page, manifest.sentinels.selected);
  assertNativeContextLargeLedgerSelectedSvg(
    manifest,
    await page.evaluate(readNativeContextLargeLedgerSvg, {
      chartId: "input-chart",
      series: "after",
    }),
  );
  for (const key of ["zero", "unknown", "increase", "event"] as const)
    await selectOriginal(page, manifest.sentinels[key]);
  await page.keyboard.press("Escape");
  await element(page, "details").waitFor({ state: "hidden" });
  return svg;
}
