import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createStartupAnimationPreview } from "./startup-animation-preview.mjs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const preview = await createStartupAnimationPreview();
const browser = await chromium.launch({
  executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const overlay = page.locator("#zcodium-startup-overlay");
  const visit = (query = "") => page.goto(`${preview.url}/scene?manual=1&${query}`);
  await visit();
  await page.waitForFunction(() => Boolean(window.startupPreview));
  await page.evaluate(() => {
    window.originalStartupOverlay = document.getElementById("zcodium-startup-overlay");
    window.startupPreview.phase("database");
  });
  await page.getByTestId("database-startup-silent").waitFor({ state: "attached" });
  await page.evaluate(() => window.startupPreview.phase("workspace"));
  await page.getByTestId("root-startup-loading").waitFor();
  assert.equal(
    await page.evaluate(
      () => window.originalStartupOverlay === document.getElementById("zcodium-startup-overlay"),
    ),
    true,
    "HTML / database / workspace must retain the same animation node",
  );
  assert.equal(
    await overlay.locator("img").evaluate((img) => img.complete && img.naturalWidth > 0),
    true,
  );
  await page.evaluate(() => window.startupPreview.phase("ready"));
  await overlay.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByText("已创建预览任务", { exact: true }).waitFor();
  await page.evaluate(() => window.startupPreview.finish());
  assert.equal(await overlay.count(), 0, "repeated ready cannot replay startup");

  // 时间推进只发生在浏览器动画上，不更改产品业务就绪条件。
  await visit();
  await page.waitForFunction(() => Boolean(window.startupPreview));
  const motion = await overlay.evaluate((node) => {
    const animations = node.getAnimations({ subtree: true });
    const entrance = animations.find(
      (animation) => animation.animationName === "zcodium-startup-enter",
    );
    const breathing = animations.find(
      (animation) => animation.animationName === "zcodium-startup-breathe",
    );
    entrance.pause();
    entrance.currentTime = 140;
    const midScale = getComputedStyle(node.querySelector(".zcodium-startup-mark")).transform;
    entrance.currentTime = 720;
    breathing.pause();
    breathing.currentTime = 3900;
    return { midScale, opacity: Number(getComputedStyle(node.querySelector("img")).opacity) };
  });
  assert.notEqual(motion.midScale, "matrix(1, 0, 0, 1, 0, 0)");
  assert.ok(motion.opacity < 0.9 && motion.opacity > 0.4, "long startup breathes gently");
  await page.evaluate(() => {
    window.startupPreview.finish();
    const node = document.getElementById("zcodium-startup-overlay");
    node.getAnimations().forEach((animation) => animation.cancel());
  });
  await overlay.waitFor({ state: "detached" });

  for (const phase of ["migration", "failed", "directory-failed", "crashed"]) {
    await visit();
    await page.waitForFunction(() => Boolean(window.startupPreview));
    await page.evaluate((phase) => window.startupPreview.phase(phase), phase);
    await overlay.waitFor({ state: "detached" });
    if (phase === "migration") {
      await page.getByTestId("database-startup-status").waitFor();
      await page.getByRole("button", { name: "退出", exact: true }).click();
    } else if (phase !== "crashed") {
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await page.getByTestId("root-startup-loading").waitFor();
      assert.equal(await overlay.count(), 0, "retry does not replay the entrance");
    } else {
      await page.getByRole("alert").waitFor();
    }
  }
  for (const theme of ["dark", "light"]) {
    await page.setViewportSize({ width: theme === "light" ? 390 : 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
    await visit(`theme=${theme}`);
    await page.waitForFunction(() => Boolean(window.startupPreview));
    assert.equal(await overlay.evaluate((node) => node.getAnimations({ subtree: true }).length), 0);
    const size = await overlay.boundingBox();
    assert.equal(size.width, theme === "light" ? 390 : 1280);
    const background = await overlay.evaluate((node) => getComputedStyle(node).backgroundColor);
    assert.equal(background, theme === "light" ? "rgb(248, 248, 248)" : "rgb(22, 22, 22)");
    await page.evaluate(() => window.startupPreview.phase("ready"));
    await overlay.waitFor({ state: "detached" });
    await visit("theme=system");
    await page.waitForFunction(() => Boolean(window.startupPreview));
    assert.equal(
      await overlay.evaluate((node) => getComputedStyle(node).backgroundColor),
      background,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await visit("windowKind=update-status");
  assert.equal(await overlay.count(), 0, "update windows bypass startup entirely");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(preview.url);
  await page.locator("#scenario").selectOption("slow");
  if (process.env.ZCODE_TEST_SCREENSHOTS_DIR) {
    await page.frameLocator("#scene").getByTestId("root-startup-loading").waitFor();
    await mkdir(process.env.ZCODE_TEST_SCREENSHOTS_DIR, { recursive: true });
    await page.screenshot({
      path: resolve(process.env.ZCODE_TEST_SCREENSHOTS_DIR, "startup-preview.png"),
      fullPage: true,
    });
  }
  await page.locator("#reduced").check();
  await page
    .frameLocator("#scene")
    .getByTestId("database-startup-silent")
    .waitFor({ state: "attached" });
  assert.equal(
    await page
      .frameLocator("#scene")
      .locator("#zcodium-startup-overlay")
      .evaluate((node) => node.getAnimations({ subtree: true }).length),
    0,
  );
  assert.ok(
    errors.every((message) => message === "Preview render failure"),
    JSON.stringify(errors),
  );
  console.log(
    "Startup animation browser checks passed: continuous entry, breathing, ready, cancel, retry, progress/errors, themes, reduced motion, update window.",
  );
} finally {
  await browser.close();
  await preview.close();
}
