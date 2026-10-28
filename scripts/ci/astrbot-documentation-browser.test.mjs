import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright-core";

test(
  "AstrBot documentation button keeps the platform callback on desktop and mobile",
  { timeout: 60000 },
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const { outputFiles } = await build({
      stdin: {
        contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { AstrBotSettingsCard, ASTRBOT_PLUGIN_URL } from './packages/ui/src/BotsDialog/AstrBotSettingsCard.tsx';
        import { ZCodeIntlProvider } from './packages/ui/src/i18n/IntlProvider.tsx';
        import { TooltipProvider } from './packages/ui/src/components/ui/tooltip.tsx';
        const platform = { openExternal(url) { window.opened.push(url); } };
        window.opened = [];
        createRoot(document.getElementById('root')).render(
          <ZCodeIntlProvider initialLocale={new URLSearchParams(location.search).get('locale') || 'en-US'}>
            <TooltipProvider><AstrBotSettingsCard bot={{id:'fixture',provider:'astrbot',enabled:false}}
              runtime={undefined} bindCode={null} bindExpired={false} bindRemainingMs={0}
              bindCountdownProgress={0} onCreateBindCode={() => {}} onUnbind={() => {}}
              onCopyBindCommand={() => {}} onOpenPlugin={() => platform.openExternal(ASTRBOT_PLUGIN_URL)} />
            </TooltipProvider>
          </ZCodeIntlProvider>);`,
        resolveDir: root,
        loader: "jsx",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      loader: { ".svg": "dataurl", ".png": "dataurl" },
      alias: { "@": resolve(root, "packages/ui/src") },
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const server = createServer((request, response) => {
      response.setHeader(
        "Content-Type",
        request.url === "/fixture.js" ? "text/javascript" : "text/html",
      );
      response.end(
        request.url === "/fixture.js"
          ? outputFiles[0].contents
          : '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>',
      );
    });
    let browser;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({
        channel: process.platform === "win32" ? "msedge" : undefined,
        executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
        headless: true,
      });
      const page = await browser.newPage();
      const external = [];
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      for (const [locale, label, viewport] of [
        ["en-US", "Open bridge plugin", { width: 1280, height: 900 }],
        ["zh-CN", "打开桥接插件", { width: 390, height: 844 }],
      ]) {
        await page.setViewportSize(viewport);
        await page.goto(`${origin}/?locale=${locale}`);
        await page.getByRole("button", { name: label }).click();
        assert.deepEqual(await page.evaluate(() => window.opened), [
          "https://github.com/No-ni/ZCodium/blob/main/docs/astrbot-bridge.md",
        ]);
      }
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await new Promise((done) => server.close(done));
    }
  },
);
