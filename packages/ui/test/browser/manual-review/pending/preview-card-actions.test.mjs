import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import sharp from "sharp";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/preview-card-actions.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/preview-card-actions-browser");
let server, browser, origin, cacheDir;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  cacheDir = await mkdtemp(join(tmpdir(), "zcodium-preview-card-vite-"));
  server = await createServer({
    root,
    cacheDir,
    configFile: false,
    plugins: [
      {
        name: "preview-card-actions-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    // HMR 关闭时不能靠重载恢复换代的依赖；只预打包此夹具使用的依赖。
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "lucide-react",
        "radix-ui",
        "class-variance-authority",
        "clsx",
        "tailwind-merge",
        "motion/react",
        "dayjs",
        "zod",
        "@pierre/diffs",
        "@pierre/diffs/react",
        "@zcode/ui > shiki",
        "@zcode/ui > zustand",
        "zustand/react/shallow",
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: null,
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

const FILE_CARD_TITLE = "项目 简介.docx";
const WEB_CARD_TITLE = "APC Local Preview";

async function readPixel(path, x, y) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return Array.from(data.subarray(offset, offset + 3));
}

async function openFixture(theme = "zai-dark") {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  // 首次访问要冷编译整条 ui 依赖链，放宽默认超时避免误报。
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const pageFailure = new Promise((_, reject) => page.once("pageerror", reject));
  const fileCard = page.locator(`[data-preview-card-title="${FILE_CARD_TITLE}"]`);
  const webCard = page.locator(`[data-preview-card-title="${WEB_CARD_TITLE}"]`);
  try {
    await Promise.race([
      (async () => {
        await page.goto(`${origin}fixture?theme=${theme}&locale=zh-CN`);
        await fileCard.waitFor();
        await webCard.waitFor();
      })(),
      pageFailure,
    ]);
  } catch (error) {
    await page.close();
    throw error;
  }
  const readEvents = () => page.getByTestId("preview-events").locator("li").allTextContents();
  return { page, errors, fileCard, webCard, readEvents };
}

test("PCA01 file card body click previews exactly once", async () => {
  const { page, errors, fileCard, readEvents } = await openFixture();
  try {
    // 点卡片左上空白/图标区：命中元素是铺满卡片的透明按钮，一次点击必须只产生一次预览。
    await fileCard.click({ position: { x: 16, y: 28 } });
    assert.deepEqual(await readEvents(), [`codeViewer:${FILE_CARD_TITLE}`]);
    assert.equal(
      await fileCard
        .getByRole("button", { name: `打开 ${FILE_CARD_TITLE}`, exact: true })
        .getAttribute("disabled"),
      null,
    );
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("PCA02 file card Open button previews exactly once", async () => {
  const { page, errors, fileCard, readEvents } = await openFixture();
  try {
    await fileCard.getByRole("button", { name: "打开", exact: true }).click();
    assert.deepEqual(await readEvents(), [`codeViewer:${FILE_CARD_TITLE}`]);
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("PCA03 file card dropdown click only expands the menu", async () => {
  const { page, errors, fileCard, readEvents } = await openFixture();
  try {
    await fileCard.getByRole("button", { name: "选择打开方式" }).click();
    const menu = page.locator('[data-slot="dropdown-menu-content"][data-state="open"]');
    await menu.waitFor();
    assert.match(await menu.innerText(), /另存为|Save as/);
    assert.deepEqual(await readEvents(), []);
    await page.screenshot({ path: join(artifacts, "file-card-dropdown.png") });
    await page.keyboard.press("Escape");
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("PCA04 website card body click and Open button each preview exactly once", async () => {
  const { page, errors, webCard, readEvents } = await openFixture();
  try {
    await webCard.click({ position: { x: 16, y: 28 } });
    assert.deepEqual(await readEvents(), ["browserUrl:http://127.0.0.1:41789/assistant-preview"]);
    await webCard.getByRole("button", { name: "打开", exact: true }).click();
    assert.deepEqual(await readEvents(), [
      "browserUrl:http://127.0.0.1:41789/assistant-preview",
      "browserUrl:http://127.0.0.1:41789/assistant-preview",
    ]);
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("PCA05 website card dropdown click only expands the menu", async () => {
  const { page, errors, webCard, readEvents } = await openFixture();
  try {
    await webCard.getByRole("button", { name: "选择打开方式" }).click();
    const menu = page.locator('[data-slot="dropdown-menu-content"][data-state="open"]');
    await menu.waitFor();
    assert.match(await menu.innerText(), /在浏览器中打开|Open in browser/);
    assert.deepEqual(await readEvents(), []);
    await page.screenshot({ path: join(artifacts, "web-card-dropdown.png") });
    await page.keyboard.press("Escape");
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("PCA06 overlay button supports keyboard Enter activation", async () => {
  const { page, errors, fileCard, readEvents } = await openFixture();
  try {
    const overlay = fileCard.getByRole("button", { name: `打开 ${FILE_CARD_TITLE}`, exact: true });
    await overlay.focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await readEvents(), [`codeViewer:${FILE_CARD_TITLE}`]);
    await overlay.focus();
    await page.keyboard.press("Space");
    assert.deepEqual(await readEvents(), [
      `codeViewer:${FILE_CARD_TITLE}`,
      `codeViewer:${FILE_CARD_TITLE}`,
    ]);
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("PCA07 preview card hover matches summary header across themes", async () => {
  for (const theme of ["light", "dark", "zai-light", "zai-dark"]) {
    const { page, errors, fileCard, readEvents } = await openFixture(theme);
    try {
      const overlay = fileCard.locator(':scope > [aria-hidden="true"]');
      const header = page
        .getByTestId("hover-summary")
        .locator('[data-slot="collapsible"] > div')
        .first();
      const cardBox = await fileCard.boundingBox();
      const headerBox = await header.boundingBox();
      const point = (box) => ({ x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + 6) });
      const cardPoint = point(cardBox);
      const headerPoint = point(headerBox);
      const beforePath = join(artifacts, `hover-${theme}-before.png`);
      const cardPath = join(artifacts, `hover-${theme}-after.png`);
      const headerPath = join(artifacts, `hover-${theme}-summary.png`);
      const beforeBackground = await fileCard.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      await page.screenshot({ path: beforePath, animations: "disabled" });
      assert.equal(await overlay.evaluate((element) => getComputedStyle(element).opacity), "0");
      await fileCard.hover();
      // 修复回归：等待实际过渡完成，不能把 hover 首帧的 opacity=0 当作最终颜色。
      await page.waitForFunction((title) => {
        const card = document.querySelector(`[data-preview-card-title="${title}"]`);
        return getComputedStyle(card.firstElementChild).opacity === "1";
      }, FILE_CARD_TITLE);
      await page.screenshot({ path: cardPath, animations: "disabled" });
      assert.equal(
        await fileCard.evaluate((element) => getComputedStyle(element).backgroundColor),
        beforeBackground,
        `${theme}: card base must remain unchanged`,
      );
      await header.hover();
      await page.screenshot({ path: headerPath, animations: "disabled" });
      const beforePixel = await readPixel(beforePath, cardPoint.x, cardPoint.y);
      const cardPixel = await readPixel(cardPath, cardPoint.x, cardPoint.y);
      const headerPixel = await readPixel(headerPath, headerPoint.x, headerPoint.y);
      assert.deepEqual(cardPixel, headerPixel, `${theme}: rendered hover must match summary`);
      assert.notDeepEqual(
        cardPixel,
        beforePixel,
        `${theme}: hover must visibly change the surface`,
      );
      if (theme === "dark" || theme === "zai-dark") {
        assert.ok(
          cardPixel.every((channel, index) => channel > beforePixel[index]),
          `${theme}: hover must brighten the card`,
        );
      }
      console.log(
        `${theme}: base=${beforePixel.join(",")} hover=${cardPixel.join(",")} summary=${headerPixel.join(",")}`,
      );
      await fileCard.click({ position: { x: 16, y: 28 } });
      assert.deepEqual(await readEvents(), [`codeViewer:${FILE_CARD_TITLE}`]);
    } finally {
      await page.close();
    }
    assert.deepEqual(errors, []);
  }
});
