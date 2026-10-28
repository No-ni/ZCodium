import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { transform } from "esbuild";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import QRCode from "qrcode";

const root = resolve(import.meta.dirname, "../..");
const providers = ["astrbot", "weixin", "feishu", "lark", "telegram"];
const qrDataUrl = await QRCode.toDataURL("http://127.0.0.1/fixture-link", {
  margin: 1,
  width: 320,
});
const mocks = {
  "@/logger.js": "logger",
  "@/BotsDialog.js": "bots-dialog",
  "@/hooks/useWebRemoteControl.js": "remote-hook",
  "@/hooks/useSettingService.js": "settings-hook",
};
const cacheDir = await mkdtemp(join(tmpdir(), "zcodium-remote-dialog-"));
let vite;
const server = createServer(async (request, response) => {
  if (request.url?.startsWith("/__fixture")) {
    response.setHeader("Content-Type", "text/html");
    response.end(
      await vite.transformIndexHtml(
        "/__fixture",
        '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/web-remote-control-dialog-smoke.jsx"></script>',
      ),
    );
    return;
  }
  vite.middlewares(request, response, () => {
    response.statusCode = 404;
    response.end("not found");
  });
});
vite = await createViteServer({
  configFile: false,
  cacheDir,
  root: resolve(import.meta.dirname, "fixtures"),
  appType: "custom",
  plugins: [
    {
      name: "remote-dialog-fixture-ports",
      enforce: "pre",
      resolveId(source) {
        const name =
          mocks[source] ??
          Object.entries(mocks).find(([key]) => source.endsWith(key.slice(1)))?.[1];
        return name ? `\0remote-fixture:${name}.jsx` : null;
      },
      async transform(code, id) {
        if (!id.startsWith("\0remote-fixture:")) return null;
        return (await transform(code, { loader: "jsx", jsx: "automatic", format: "esm" })).code;
      },
      load(id) {
        const modules = {
          logger: "export const logger={info(){},warn(){},error(){}};",
          "bots-dialog": `import React from 'react';import {Dialog,DialogContent,DialogTitle} from '@/components/ui/dialog.js';export function BotsDialog({open,entryProvider,onOpenChange,workspacePath,workspaceIdentity}){return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent showCloseButton={false}><DialogTitle>Fixture Bot configuration</DialogTitle><div data-testid="bots-dialog" data-entry-provider={entryProvider??''} data-workspace={workspacePath+':'+workspaceIdentity}><button onClick={()=>onOpenChange(false)}>Close fixture bots</button></div></DialogContent></Dialog>}`,
          "settings-hook": `import {useCallback,useState} from 'react';export function useSettings(){const [settings,setSettings]=useState({webRemoteControlEndpointMode:'lan',webRemoteControlCustomEndpointUrl:''});const update=useCallback(async patch=>{setSettings(current=>({...current,...patch}));window.fixtureEvents.push(['settings-update',patch]);},[]);return {settings,update}}`,
          "remote-hook": `import {useEffect,useState} from 'react';export function useWebRemoteControl(options){window.remoteOptions=options;const [,render]=useState(0);useEffect(()=>{const update=()=>render(value=>value+1);window.addEventListener('fixture-state',update);return()=>window.removeEventListener('fixture-state',update)},[]);const state=window.fixtureRemoteState??{};return {qrDataUrl:state.qrDataUrl===null?null:${JSON.stringify(qrDataUrl)},qrUrl:state.qrUrl===null?null:'http://127.0.0.1/fixture-link',busy:window.fixtureBusy??false,status:state.status??'running',snapshot:state.failure?{failure:state.failure}:null,async copyLink(){window.fixtureEvents.push(['copy'])},async refreshPairing(){window.fixtureEvents.push(['refresh'])},async stop(){window.fixtureEvents.push(['stop'])}}}`,
        };
        return modules[id.slice("\0remote-fixture:".length).replace(/\.jsx$/, "")];
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "@": resolve(root, "packages/ui/src") }, dedupe: ["react", "react-dom"] },
  server: {
    middlewareMode: true,
    hmr: { server, host: "127.0.0.1" },
    watch: { ignored: ["**"] },
  },
  optimizeDeps: {
    noDiscovery: true,
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "class-variance-authority",
      "clsx",
      "lucide-react",
      "radix-ui",
      "tailwind-merge",
      "zod",
    ],
  },
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const closeFixture = async () => {
  await vite.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(cacheDir, { recursive: true, force: true });
};

if (process.argv.includes("--serve")) {
  console.log(JSON.stringify({ url: `${origin}/__fixture`, pid: process.pid }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void closeFixture());
} else {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel:
        !process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE && process.platform === "win32"
          ? "msedge"
          : undefined,
      executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
    });
    const page = await browser.newPage({ viewport: { width: 1200, height: 980 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (["data:", "blob:"].includes(url.protocol) || url.hostname === "127.0.0.1")
        return route.continue();
      errors.push(`unexpected external request: ${url}`);
      return route.abort("blockedbyclient");
    });
    await page.goto(`${origin}/__fixture`);
    await page.waitForFunction(() => typeof window.setFixtureLocale === "function");
    const dictionaries = await page.evaluate(() => window.fixtureDictionaries);
    const message = (locale, key) => dictionaries[locale][key];
    for (const theme of ["zai-light", "zai-dark"]) {
      for (const locale of ["en-US", "zh-CN"]) {
        for (const width of [1200, 768, 390, 320]) {
          await page.setViewportSize({ width, height: 980 });
          await page.evaluate(
            ({ theme, locale }) => {
              document.documentElement.className = `theme-${theme}`;
              window.setFixtureLocale(locale);
            },
            { theme, locale },
          );
          const dialog = page.getByRole("dialog");
          await dialog
            .getByRole("heading", { name: message(locale, "webRemoteControl.title"), exact: true })
            .waitFor();
          await dialog.evaluate(async (element) => {
            await Promise.all(
              element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
            );
          });
          const qr = page.getByRole("region", {
            name: message(locale, "webRemoteControl.mobileQr.title"),
            exact: true,
          });
          const bots = page.getByRole("region", {
            name: message(locale, "webRemoteControl.botChannel.title"),
            exact: true,
          });
          const [dialogBox, qrBox, botsBox] = await Promise.all([
            dialog.boundingBox(),
            qr.boundingBox(),
            bots.boundingBox(),
          ]);
          assert.ok(dialogBox && qrBox && botsBox);
          assert.ok(
            dialogBox.x >= 15 && dialogBox.x + dialogBox.width <= width - 15,
            `${width}px dialog retains margins`,
          );
          assert.equal(
            await dialog.evaluate((element) => element.scrollWidth > element.clientWidth),
            false,
            `${width}px no horizontal overflow`,
          );
          if (width >= 768)
            assert.ok(qrBox.x + qrBox.width <= botsBox.x, `${width}px shows two columns`);
          else assert.ok(qrBox.y + qrBox.height <= botsBox.y, `${width}px shows QR before Bots`);
          const imageBox = await qr.getByRole("img").boundingBox();
          assert.ok(imageBox && Math.abs(imageBox.width - imageBox.height) <= 1, "square QR image");
          assert.equal(
            await page
              .locator('[data-slot="dialog-overlay"]')
              .evaluate((element) => getComputedStyle(element).backdropFilter),
            "none",
            "retain fork non-blurred overlay",
          );
          assert.equal(
            await dialog.locator('[data-slot="scroll-area-viewport"]').count(),
            1,
            "retain body-only ScrollArea",
          );
        }
      }
    }
    await page.setViewportSize({ width: 768, height: 640 });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--ui-font-size", "18px");
      window.setFixtureLocale("en-US");
    });
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("heading", { name: message("en-US", "webRemoteControl.title"), exact: true })
      .waitFor();
    await dialog.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    const viewport = dialog.locator('[data-slot="scroll-area-viewport"]');
    const headerBox = await dialog.locator('[data-slot="dialog-header"]').boundingBox();
    const viewportBox = await viewport.boundingBox();
    assert.ok(headerBox.y + headerBox.height <= viewportBox.y + 1, "header outside scroll body");
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    assert.equal(
      await viewport.evaluate((element) => element.scrollTop > 0),
      true,
      "short window remains scrollable",
    );
    const close = dialog.getByRole("button", {
      name: message("en-US", "common.close"),
      exact: true,
    });
    assert.equal(await close.isVisible(), true, "close remains available while scrolling");
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 640 });
      for (const key of ["webRemoteControl.botChannel.manageBots", "webRemoteControl.stop"]) {
        const action = dialog.getByRole("button", {
          name: message("en-US", key),
          exact: true,
        });
        await action.scrollIntoViewIfNeeded();
        const bodyBox = await viewport.boundingBox();
        const actionBox = await action.boundingBox();
        assert.ok(bodyBox && actionBox);
        assert.ok(
          actionBox.y >= bodyBox.y - 1 &&
            actionBox.y + actionBox.height <= bodyBox.y + bodyBox.height + 1,
          `${width}px low window and large font can reach bottom actions`,
        );
        assert.equal(await close.isVisible(), true);
      }
    }
    await page.evaluate(() => document.documentElement.style.removeProperty("--ui-font-size"));
    await page.setViewportSize({ width: 1200, height: 980 });
    const qr = page.getByRole("region", {
      name: message("en-US", "webRemoteControl.mobileQr.title"),
      exact: true,
    });
    const button = (key) => qr.getByRole("button", { name: message("en-US", key), exact: true });
    const refreshCount = () =>
      page.evaluate(() => window.fixtureEvents.filter(([name]) => name === "refresh").length);
    await page.evaluate(() => window.setFixtureBusy(true));
    for (const key of [
      "webRemoteControl.copyLink",
      "webRemoteControl.refreshQr",
      "webRemoteControl.stop",
    ])
      assert.equal(await button(key).isDisabled(), true);
    await page.evaluate(() => {
      window.setFixtureBusy(false);
      window.setFixtureState({ status: "idle", qrUrl: null });
    });
    assert.equal(await button("webRemoteControl.stop").isDisabled(), true);
    assert.equal(await button("webRemoteControl.copyLink").isDisabled(), true);
    await page.evaluate(() => window.setFixtureState({ failure: { reason: "sessionExpired" } }));
    await qr
      .getByText(message("en-US", "webRemoteControl.failure.sessionExpired"), { exact: true })
      .waitFor();
    await page.evaluate(() => window.setFixtureState({}));
    await button("webRemoteControl.copyLink").click();
    await button("webRemoteControl.refreshQr").click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: message("en-US", "common.cancel"), exact: true })
      .click();
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
    assert.equal(await refreshCount(), 0);
    await button("webRemoteControl.refreshQr").click();
    const confirmRefresh = page.getByRole("alertdialog").getByRole("button", {
      name: message("en-US", "webRemoteControl.refreshQr"),
      exact: true,
    });
    await page.evaluate(() => window.setFixtureBusy(true));
    assert.equal(
      await confirmRefresh.isDisabled(),
      true,
      "busy blocks an already-open confirmation",
    );
    assert.equal(await refreshCount(), 0);
    await page.evaluate(() => window.setFixtureBusy(false));
    assert.equal(await confirmRefresh.isEnabled(), true, "confirmation resumes when Host is idle");
    await confirmRefresh.click();
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
    assert.equal(await refreshCount(), 1);
    await button("webRemoteControl.stop").click();
    const endpoint = qr.getByRole("textbox", {
      name: message("en-US", "webRemoteControl.endpoint.urlLabel"),
      exact: true,
    });
    await endpoint.fill("wss://local.example/ws");
    await qr
      .getByRole("button", {
        name: message("en-US", "webRemoteControl.endpoint.save"),
        exact: true,
      })
      .click();
    assert.equal(
      await page.evaluate(() =>
        window.fixtureEvents.some(
          ([name, patch]) =>
            name === "settings-update" &&
            patch.webRemoteControlCustomEndpointUrl === "wss://local.example/ws",
        ),
      ),
      true,
    );
    for (const provider of providers) {
      const bots = page.getByRole("region", {
        name: message("en-US", "webRemoteControl.botChannel.title"),
        exact: true,
      });
      await bots
        .getByRole("button", {
          name: new RegExp(
            `^${message("en-US", `webRemoteControl.botChannel.${provider}.title`)}\\b`,
            "i",
          ),
        })
        .click();
      const configuration = page.getByTestId("bots-dialog");
      await configuration.waitFor();
      assert.equal(await configuration.getAttribute("data-entry-provider"), provider);
      assert.equal(
        await configuration.getAttribute("data-workspace"),
        "/fixture/workspace:fixture-identity",
      );
      await page
        .getByRole("heading", { name: message("en-US", "webRemoteControl.title"), exact: true })
        .waitFor({ state: "detached" });
      await page
        .locator('[data-slot="dialog-overlay"][data-state="closed"]')
        .waitFor({ state: "detached" });
      assert.equal(
        await page.locator('[data-slot="dialog-overlay"]').count(),
        1,
        "no stacked remote and configuration overlays",
      );
      await configuration.getByRole("button", { name: "Close fixture bots" }).click();
      await page.getByRole("button", { name: "Open remote control", exact: true }).click();
    }
    await page
      .getByRole("button", {
        name: message("en-US", "webRemoteControl.botChannel.manageBots"),
        exact: true,
      })
      .click();
    assert.equal(await page.getByTestId("bots-dialog").getAttribute("data-entry-provider"), "");
    await page
      .getByTestId("bots-dialog")
      .getByRole("button", { name: "Close fixture bots" })
      .click();
    await page.getByRole("button", { name: "Open remote control", exact: true }).click();
    assert.equal(
      await page
        .locator('[data-slot="scroll-area-viewport"]')
        .evaluate((element) => element.scrollTop),
      0,
      "reopening resets scroll",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: message("en-US", "common.close"), exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.deepEqual(
      await page.evaluate(() => {
        const { workspacePath, workspaceIdentity, remoteSessionId } = window.remoteOptions;
        return { workspacePath, workspaceIdentity, remoteSessionId };
      }),
      {
        workspacePath: "/fixture/workspace",
        workspaceIdentity: "fixture-identity",
        remoteSessionId: "fixture-session",
      },
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS remote dialog: two-column layout, square QR, themes/locales, fork scrolling/overlay fixes, controls and identity routing",
    );
  } finally {
    await browser?.close();
    await closeFixture();
  }
}
