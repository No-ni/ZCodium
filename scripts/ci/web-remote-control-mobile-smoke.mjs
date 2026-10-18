/* eslint-disable max-lines -- 多阶段真实 LAN、RPC 与浏览器回归需要串行控制同一配对和会话生命周期。 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, webkit } from "playwright-core";
import { tsImport } from "tsx/esm/api";
import { build as buildWeb } from "vite";
import { createMobileV4Fixture } from "./fixtures/mobile-v4-service.mjs";
import {
  captureMobile,
  createMobileMessages,
  longText,
  assertScrollable,
  swipeUp,
  scrollToLast,
} from "./fixtures/mobile-remote-layout.mjs";

const { ChannelServer, Emitter, ProxyChannel, VSBuffer } = await tsImport(
  "../../packages/rpc/src/index.ts",
  import.meta.url,
);
const { ServiceChannels, encodeWebRemoteControlRpcFrames, WebRemoteControlRpcAssembler } =
  await tsImport("../../packages/shared/src/index.ts", import.meta.url);

// 真实 mobile entry + 真实 LAN endpoint：浏览器自行计算 proof 并与 endpoint 完成握手。
const root = resolve(import.meta.dirname, "../..");
const cacheDir = resolve(root, "node_modules/.cache");
await mkdir(cacheDir, { recursive: true });
const temp = await mkdtemp(resolve(cacheDir, "mobile-remote-smoke-"));
const mobileDir = resolve(temp, "mobile");
const endpointBundle = resolve(temp, "endpoint.mjs");
const endpointSource = resolve(root, "packages/desktop/src/main/webRemoteControl/lanEndpoint.ts");
const originalMobileDir = process.env.ZCODE_WEB_REMOTE_MOBILE_DIR;
const evidenceDir = process.env.ZCODE_MOBILE_EVIDENCE_DIR;
let browser;
let endpoint;
let host;
let webkitBrowser;
let resumes = 0;
let bootstrapRequests = 0;
const fixture = createMobileV4Fixture({
  messages: createMobileMessages(),
  Emitter,
  sessionId: "fixture-task",
  workspacePath: "/fixture",
});
const remoteWorkspace = {
  workspaceKey: "fixture-remote-workspace",
  workspacePath: "/fixture-remote",
  workspaceIdentity: "fixture-remote-identity",
  remoteSessionId: "fixture-remote-session",
  kind: "remote",
  label: "独立远端工作区",
};
const remoteFixture = createMobileV4Fixture({
  messages: [],
  Emitter,
  sessionId: "fixture-remote-task",
  ...remoteWorkspace,
});
const replacementRemoteWorkspace = {
  ...remoteWorkspace,
  remoteSessionId: "fixture-replacement-remote-session",
};
const replacementRemoteFixture = createMobileV4Fixture({
  messages: [],
  Emitter,
  sessionId: "fixture-remote-task",
  ...replacementRemoteWorkspace,
});
let activeRemoteWorkspace = remoteWorkspace;
let activeRemoteFixture = remoteFixture;
try {
  // 原 fixture 丢弃 CSS，漏掉 body 禁滚动和手机专用 utility 未生成的问题。
  // 使用产品 Vite 配置生成真实 mobile 入口（含 Tailwind），只把测试产物放临时目录。
  await buildWeb({
    root: resolve(root, "packages/web"),
    configFile: resolve(root, "packages/web/vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: mobileDir,
      emptyOutDir: true,
      sourcemap: false,
    },
  });
  await build({
    entryPoints: [endpointSource],
    outfile: endpointBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["ws"],
  });
  process.env.ZCODE_WEB_REMOTE_MOBILE_DIR = mobileDir;
  const { LanRemoteControlEndpoint } = await import(pathToFileURL(endpointBundle).href);
  const endpointEvents = [];
  endpoint = new LanRemoteControlEndpoint({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    deviceMid: "smoke-mid",
    deviceName: "fixture",
    appVersion: "smoke",
    maxPhysicalFrameBytes: 1024 * 1024,
    handleMobilePayload(deviceSid, payload) {
      endpointEvents.push(payload.zcode_type);
      if (payload.zcode_type === "bootstrap-request") {
        bootstrapRequests++;
        device.sendPayload({
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: {
            windowControlSessionId: "fixture-window",
            desktopAppVersion: "smoke",
            workspaces: [
              {
                workspaceKey: "fixture-workspace",
                workspacePath: "/fixture",
                workspaceIdentity: "fixture-identity",
                kind: "local",
                label: "Fixture workspace",
              },
            ],
            tasks: [
              {
                workspaceKey: "fixture-workspace",
                taskId: "fixture-task",
                title: "运行中的置顶任务",
                displayStatus: "running",
                pinned: true,
              },
              ...Array.from({ length: 160 }, (_, index) => ({
                workspaceKey: "fixture-workspace",
                taskId: `other-task-${index}`,
                title: `任务列表 ${index}`,
                displayStatus: "completed",
              })),
            ],
          },
        });
      }
      if (payload.zcode_type === "workspace-bridge-open") {
        host?.dispose();
        const isRemote = payload.workspaceKey === remoteWorkspace.workspaceKey;
        const targetFixture = isRemote ? activeRemoteFixture : fixture;
        const target = isRemote
          ? activeRemoteWorkspace
          : {
              workspaceKey: "fixture-workspace",
              workspacePath: "/fixture",
              workspaceIdentity: "fixture-identity",
              kind: "local",
            };
        targetFixture.suppressFrames(false);
        const incoming = new Emitter();
        let seq = 0;
        const streamId = payload.bridgeSessionId;
        const assembler = new WebRemoteControlRpcAssembler({ streamId });
        const agentScope = targetFixture.attach(streamId);
        const server = new ChannelServer(
          {
            onMessage: incoming.event,
            send(buffer) {
              const frames = encodeWebRemoteControlRpcFrames(
                { __zcodeBytes: Buffer.from(buffer.buffer).toString("base64url") },
                { streamId, seq: ++seq },
              );
              for (const frame of frames) device.sendPayload({ zcode_type: "rpc-frame", frame });
            },
          },
          "fixture",
          1000,
          true,
        );
        server.registerChannel(
          ServiceChannels.ZCodeTask,
          ProxyChannel.fromService({
            async resumeTask(params) {
              assert.equal(params.taskId, isRemote ? "fixture-remote-task" : "fixture-task");
              assert.equal(params.workspacePath, target.workspacePath);
              assert.equal(params.workspaceIdentity, target.workspaceIdentity);
              assert.equal(params.remoteSessionId, target.remoteSessionId);
              assert.equal(params.clientMode, undefined);
              resumes++;
              return {};
            },
          }),
        );
        server.registerChannel(
          ServiceChannels.ZCodeAgent,
          ProxyChannel.fromService(agentScope.service),
        );
        host = {
          sentCount() {
            return seq;
          },
          accept(frame) {
            for (const event of assembler.push(frame)) {
              if (event.kind !== "message") continue;
              incoming.fire(VSBuffer.wrap(Buffer.from(event.message.__zcodeBytes, "base64url")));
              device.sendPayload({
                zcode_type: "rpc-frame-ack",
                frame: { kind: "ack", streamId, seq: event.seq, ackSeq: event.seq },
              });
            }
          },
          dispose() {
            server.dispose();
            incoming.dispose();
            void agentScope.dispose();
          },
        };
        device.sendPayload({
          zcode_type: "workspace-bridge-ready",
          requestId: payload.requestId,
          bridgeSessionId: streamId,
          bridge: {
            bridgeSessionId: streamId,
            ...target,
            entryKind: "task",
          },
        });
        server.ready();
      }
      if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack")
        host?.accept(payload.frame);
    },
  });
  const secret = randomBytes(32).toString("base64url");
  const passHash = createHash("sha256").update(secret).digest("base64");
  let pairedCount = 0;
  const registration = endpoint.registerDevice(
    { mode: "register", passHash },
    {
      onStateChange(state) {
        if (state === "paired") pairedCount++;
      },
      onPayload() {},
      onRegisteredAuth() {},
      onError() {},
      onInvalidPersistedAuth() {},
      onMobileDisconnected() {},
    },
  );
  assert.equal(registration.ok, true);
  const device = registration.handle;
  const info = await endpoint.start();
  browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-proxy-server", "--host-resolver-rules=MAP mobile.fixture.test 127.0.0.1"],
  });
  const context = await browser.newContext({
    ...devicesForMobile(),
    ...(evidenceDir ? { recordVideo: { dir: resolve(evidenceDir, "videos") } } : {}),
  });
  await context.addInitScript(() => {
    window.__mobileWsCount = 0;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        window.__mobileWsCount++;
        super(...args);
      }
    };
  });
  const origin = `http://mobile.fixture.test:${info.port}`;
  const url = `${origin}/?sid=${encodeURIComponent(device.deviceSid)}&hash=${encodeURIComponent(passHash)}&mid=fixture&name=smoke&app_version=smoke`;
  const pageErrors = [];
  context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error)));
  const first = await context.newPage();
  await first.goto(url);
  assert.deepEqual(
    await first.evaluate(() => ({ secure: isSecureContext, subtle: Boolean(crypto.subtle) })),
    { secure: false, subtle: false },
  );
  try {
    await first.getByText("已连接到当前桌面窗口").waitFor({ timeout: 10000 });
  } catch (error) {
    console.error("mobile fixture failed", {
      body: await first.locator("body").innerText(),
      errors: pageErrors.map((error) => error.message),
      endpointEvents,
    });
    throw error;
  }
  await first.getByText("1 个工作区 · 161 个任务").waitFor();
  await captureMobile(first, "home", evidenceDir);
  await assertScrollable(first, "长任务首页必须拥有受视口约束的滚动区域");
  await swipeUp(first);
  assert.ok(await first.getByRole("main").evaluate((node) => node.scrollTop > 0), "触摸应滚动首页");
  await scrollToLast(first, "任务列表 159");
  await captureMobile(first, "home-scrolled", evidenceDir);
  assert.ok(
    endpointEvents.includes("bootstrap-request"),
    "real mobile client must request bootstrap",
  );

  const bad = await context.newPage();
  await bad.goto(
    url.replace(encodeURIComponent(passHash), encodeURIComponent(`${passHash.slice(0, -2)}xx`)),
  );
  await bad.getByText("连接已终止").first().waitFor();
  const badInitial = await bad.evaluate(() => window.__mobileWsCount);
  await bad.evaluate(() => {
    dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await bad.waitForTimeout(2300);
  assert.equal(
    await bad.evaluate(() => window.__mobileWsCount),
    badInitial,
    "terminal auth failure must not reconnect",
  );
  assert.equal(pairedCount, 1, "wrong hash must not pair");

  const second = await context.newPage();
  await second.goto(url);
  await second.getByText("已连接到当前桌面窗口").waitFor();
  const initialGate = fixture.gateInitial();
  await second.getByRole("button", { name: /运行中的置顶任务/ }).click();
  await withTimeout(initialGate.entered, 10000, "V4 initial snapshot gate was not reached");
  const composer = second.getByPlaceholder("发送消息");
  const sendButton = second.getByRole("button", { name: "发送", exact: true });
  await composer.fill("首帧前草稿");
  assert.equal(
    await sendButton.isDisabled(),
    true,
    "first load must disable send before the V4 snapshot",
  );
  assert.equal(await second.getByText("首帧前草稿", { exact: true }).count(), 0);
  fixture.appendAssistant("快照等待期间片段");
  initialGate.release();
  const gatedText = "进入前已生成的前缀快照等待期间片段";
  await second.getByText(gatedText, { exact: true }).waitFor();
  assert.equal(
    await composer.inputValue(),
    "首帧前草稿",
    "the draft must survive initial synchronization",
  );
  fixture.appendAssistant("持续生成片段");
  const generatedText = `${gatedText}持续生成片段`;
  await second.getByText(generatedText, { exact: true }).waitFor();
  await loadOlderUntil(second, "历史测试消息");
  await captureMobile(second, "conversation", evidenceDir);
  await assertV4MobileLayout(second, longText, generatedText);
  await captureMobile(second, "conversation-scrolled", evidenceDir);
  const initialResumes = resumes;
  device.sendPayload({
    zcode_type: "workspace-list-updated",
    result: {
      workspaces: [
        {
          workspaceKey: "fixture-workspace",
          workspacePath: "/fixture",
          workspaceIdentity: "fixture-identity",
          kind: "local",
        },
      ],
      tasks: [
        {
          workspaceKey: "fixture-workspace",
          taskId: "fixture-task",
          title: "任务状态已更新",
          displayStatus: "running",
          pinned: true,
        },
      ],
    },
  });
  assert.equal(resumes, initialResumes, "list updates must not restart conversation");
  await first.getByText("此配对仅支持一个手机页面，请关闭其他重复页面后重新扫码。").waitFor();
  const oldCount = await first.evaluate(() => window.__mobileWsCount);
  await first.evaluate(() => {
    dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await first.waitForTimeout(2300);
  assert.equal(
    await first.evaluate(() => window.__mobileWsCount),
    oldCount,
    "kicked page must not reclaim pairing",
  );

  const delayedText = "延迟 ACK 后的权威输入";
  const retainedDraft = "确认期间编辑并断线的草稿";
  const delayedAck = fixture.holdNextAck();
  fixture.suppressFrames(true);
  await composer.fill(delayedText);
  await sendButton.click();
  const delayedAcceptance = await withTimeout(
    delayedAck.accepted,
    10000,
    "delayed command was not admitted",
  );
  const delayedCommandId = delayedAcceptance.envelope.commandId;
  assert.equal(fixture.executionCount(delayedCommandId), 1, "sendText must be admitted once");
  await composer.fill(retainedDraft);
  delayedAck.release();
  await second.waitForFunction(
    () => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === "发送",
      );
      return button?.disabled === false;
    },
    undefined,
    { timeout: 10000 },
  );
  await second.waitForFunction(
    (expected) => document.querySelector("input")?.value === expected,
    retainedDraft,
  );
  fixture.suppressFrames(false);
  assert.equal(
    await second.getByText(delayedText, { exact: true }).count(),
    0,
    "suppressed V4 frames must not be mistaken for an authoritative row",
  );

  // 真实 socket 被 endpoint 终止后由 Chromium 客户端重连；原页面草稿留在当前目标。
  const bootstrapBeforeReconnect = bootstrapRequests;
  await reconnectChromium(second, context, endpoint, device);
  await second.getByText(delayedText, { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(
    await second.getByText(delayedText, { exact: true }).count(),
    1,
    "snapshot recovery must project the accepted input once",
  );
  assert.equal(
    await composer.inputValue(),
    retainedDraft,
    "disconnect must preserve the unsent draft",
  );
  assert.equal(fixture.executionCount(delayedCommandId), 1);
  await second.getByText(generatedText, { exact: true }).waitFor();
  assert.ok(bootstrapRequests > bootstrapBeforeReconnect, "reconnection must refresh bootstrap");
  assert.equal(
    await second.locator(".text-destructive").count(),
    0,
    "successful task entry and recovery must not leave red errors",
  );
  await assertViewScrollIsolationV4(second, generatedText, retainedDraft);

  const homeAckText = "返回首页期间确认的输入";
  const homeAck = fixture.holdNextAck();
  fixture.suppressFrames(true);
  await composer.fill(homeAckText);
  await sendButton.click();
  const homeAcceptance = await withTimeout(
    homeAck.accepted,
    10000,
    "home-ack command was not admitted",
  );
  const homeCommandId = homeAcceptance.envelope.commandId;
  assert.equal(fixture.executionCount(homeCommandId), 1);
  await second.getByRole("button", { name: "返回任务首页" }).click();
  homeAck.release();
  await second.getByRole("button", { name: /运行中的置顶任务|任务状态已更新/ }).click();
  await second.getByText(homeAckText, { exact: true }).waitFor({ timeout: 12000 });
  await second.waitForFunction(() => document.querySelector("input")?.value === "", undefined, {
    timeout: 12000,
  });
  assert.equal(
    await second.getByText(homeAckText, { exact: true }).count(),
    1,
    "re-entering after home ACK must not duplicate the row",
  );
  assert.equal(fixture.executionCount(homeCommandId), 1);
  fixture.suppressFrames(false);

  const lostAckText = "ACK 丢失后对账的输入";
  const lostAck = fixture.holdNextAck();
  fixture.suppressFrames(true);
  await composer.fill(lostAckText);
  await sendButton.click();
  const lostAcceptance = await withTimeout(
    lostAck.accepted,
    10000,
    "lost-ack command was not admitted",
  );
  const lostCommandId = lostAcceptance.envelope.commandId;
  assert.equal(fixture.executionCount(lostCommandId), 1);
  lostAck.release({ drop: true });
  const lostAckBootstrapCount = bootstrapRequests;
  await reconnectChromium(second, context, endpoint, device);
  await second.getByText(lostAckText, { exact: true }).waitFor({ timeout: 12000 });
  await second.waitForFunction(() => document.querySelector("input")?.value === "", undefined, {
    timeout: 12000,
  });
  assert.equal(
    await second.getByText(lostAckText, { exact: true }).count(),
    1,
    "reconnect snapshot must leave one authoritative row",
  );
  assert.equal(
    fixture.executionCount(lostCommandId),
    1,
    "lost ACK recovery must not resend the command",
  );
  assert.ok(bootstrapRequests > lostAckBootstrapCount, "lost-ACK reconnect must refresh bootstrap");
  assert.equal(
    await second.getByText(generatedText, { exact: true }).count(),
    1,
    "reconnect must retain the in-progress assistant row once",
  );
  await assertProjectionBeforeAck(second, device, fixture, evidenceDir);
  await assertQueryUnavailableRetry(second, fixture, evidenceDir);
  await assertWaitingRecovery(second, endpoint, device, fixture, evidenceDir);
  await assertCrossTargetDrafts(second, device, fixture, remoteFixture, evidenceDir);
  await assertRemoteSessionIsolation(second, device, fixture, remoteFixture, evidenceDir);
  assert.deepEqual(
    await first.evaluate(() => ({ secure: isSecureContext, subtle: Boolean(crypto.subtle) })),
    { secure: false, subtle: false },
  );
  assert.deepEqual(
    pageErrors.map((error) => error.message),
    [],
    "mobile pages must not emit uncaught browser errors",
  );
  console.log(
    "PASS Chromium mobile + production dual-entry Vite build + real CSS/LAN/Channel RPC: initial V4 prefix, streaming delta, paging, gated send, delayed/lost ACK, draft preservation, reconnect projection, pairing, layout; bad hash and duplicate page terminate",
  );
  await context.close();
  await runWebKitChecks({ endpoint, device, url, fixture, evidenceDir, pageErrors, generatedText });
  console.log("Rerun: node scripts/ci/web-remote-control-mobile-smoke.mjs");
} finally {
  try {
    await webkitBrowser?.close();
    await browser?.close();
    host?.dispose();
    fixture.dispose();
    remoteFixture.dispose();
    replacementRemoteFixture.dispose();
  } finally {
    try {
      await endpoint?.stop();
    } finally {
      try {
        await rm(temp, { recursive: true, force: true });
      } finally {
        if (originalMobileDir === undefined) delete process.env.ZCODE_WEB_REMOTE_MOBILE_DIR;
        else process.env.ZCODE_WEB_REMOTE_MOBILE_DIR = originalMobileDir;
      }
    }
  }
}

function devicesForMobile() {
  return {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  };
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadOlderUntil(page, expectedText) {
  const expected = page.getByText(expectedText, { exact: true });
  for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
    if (await expected.count()) return;
    const loadButton = page.getByRole("button", { name: "加载更早消息", exact: true });
    await loadButton.waitFor({ state: "visible", timeout: 10000 });
    const previousText = await page.getByRole("main").innerText();
    await loadButton.click();
    await page.waitForFunction(
      (previous) => {
        const main = document.querySelector("main");
        const isLoading = [...(main?.querySelectorAll("button") ?? [])].some(
          (button) => button.textContent?.trim() === "正在加载…",
        );
        return Boolean(main && !isLoading && main.innerText !== previous);
      },
      previousText,
      { timeout: 15000 },
    );
  }
  await expected.waitFor({ timeout: 10000 });
}

async function assertV4MobileLayout(page, wrappedText, tailText) {
  await assertScrollable(page, "V4 长会话必须能够在输入栏上方滚动");
  const textLayout = await page.getByText(wrappedText, { exact: true }).evaluate((node) => ({
    whiteSpace: getComputedStyle(node).whiteSpace,
    width: node.getBoundingClientRect().width,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  assert.equal(textLayout.whiteSpace, "pre-wrap", "消息必须保留换行");
  assert.ok(textLayout.scrollWidth <= textLayout.clientWidth + 1, "连续长文本应在气泡内换行");
  assert.ok(textLayout.width <= 390 * 0.85, "消息气泡必须约束在手机宽度内");
  await swipeUp(page);
  assert.ok(
    await page.getByRole("main").evaluate((node) => node.scrollTop > 0),
    "触摸应滚动 V4 会话",
  );
  await scrollToLast(page, tailText);
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await assertScrollable(page, "窄屏/横屏下 V4 会话仍可滚动");
    const layout = await page.evaluate(() => {
      const input = document.querySelector("input");
      const main = document.querySelector("main").getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      return {
        fontSize: Number.parseFloat(getComputedStyle(input).fontSize),
        inputBottom: inputRect.bottom,
        mainBottom: main.bottom,
        inputTop: inputRect.top,
        width: document.documentElement.scrollWidth,
      };
    });
    assert.ok(layout.fontSize >= 16, "手机输入不能触发 iOS 小字体自动缩放");
    assert.ok(layout.inputBottom <= viewport.height, "输入框必须位于当前视口内");
    assert.ok(layout.mainBottom <= layout.inputTop, "输入栏不能覆盖消息区域");
    assert.ok(layout.width <= viewport.width, "手机页面不能横向溢出");
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

async function reconnectChromium(page, context, endpoint, device) {
  const wsBefore = await page.evaluate(() => window.__mobileWsCount);
  const bootstrapBefore = bootstrapRequests;
  await page.evaluate(() => {
    // 延后本次随机退避，证明 online 事件本身建连，不能由原定时器自然触发蒙混通过。
    const nativeTimeout = window.setTimeout;
    window.__mobileReconnectHeld = false;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay >= 1000 && delay < 2000) {
        window.setTimeout = nativeTimeout;
        window.__mobileReconnectHeld = true;
        return nativeTimeout(callback, 60000, ...args);
      }
      return nativeTimeout(callback, delay, ...args);
    };
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  const mobile = endpoint.pairs.get(device.deviceSid)?.mobile;
  assert.ok(mobile, "paired mobile socket must exist before reconnect");
  mobile.terminate();
  await page.waitForFunction(
    () => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === "发送",
      );
      return button?.disabled === true;
    },
    undefined,
    { timeout: 10000 },
  );
  await page.getByText("正在重新连接").waitFor({ timeout: 10000 });
  await page.waitForFunction(() => window.__mobileReconnectHeld);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await cdp.detach();
  const wsAfterOnline = await page.evaluate(() => {
    dispatchEvent(new Event("online"));
    dispatchEvent(new Event("online"));
    return window.__mobileWsCount;
  });
  assert.equal(
    wsAfterOnline,
    wsBefore + 1,
    "online must cancel backoff and create exactly one socket",
  );
  await page.waitForFunction((count) => window.__mobileWsCount > count, wsBefore, {
    timeout: 15000,
  });
  await withTimeout(
    waitForCondition(() => bootstrapRequests > bootstrapBefore),
    20000,
    "Chromium did not refresh bootstrap after reconnect",
  );
}

async function assertViewScrollIsolationV4(page, tailText, expectedDraft) {
  await page.getByRole("button", { name: "返回任务首页" }).click();
  await page.getByRole("heading", { name: "ZCode 远程控制", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("main").evaluate((node) => node.scrollTop),
    0,
    "返回首页不能继承会话滚动位置",
  );
  await page.getByRole("button", { name: /运行中的置顶任务|任务状态已更新/ }).click();
  await page.getByText(tailText, { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("main").evaluate((node) => node.scrollTop),
    0,
    "重新进入会话不能继承首页滚动位置",
  );
  assert.equal(await page.getByPlaceholder("发送消息").inputValue(), expectedDraft);
}

async function runWebKitChecks({
  endpoint,
  device,
  url,
  fixture,
  evidenceDir,
  pageErrors,
  generatedText,
}) {
  try {
    webkitBrowser = await webkit.launch({
      headless: true,
      executablePath: process.env.ZCODE_TEST_WEBKIT_EXECUTABLE || undefined,
    });
  } catch (error) {
    // CI 以前缺少 WebKit 仍标绿，导致手机恢复与布局的第二引擎回归实际未执行。
    if (process.env.CI) throw error;
    console.warn(`SKIP WebKit checks: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const context = await webkitBrowser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    ...(evidenceDir ? { recordVideo: { dir: resolve(evidenceDir, "webkit-videos") } } : {}),
  });
  context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error)));
  await context.addInitScript(() => {
    window.__mobileWsCount = 0;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        window.__mobileWsCount++;
        super(...args);
      }
    };
  });
  fixture.suppressFrames(false);
  const webkitUrl = new URL(url);
  webkitUrl.hostname = "127.0.0.1";
  const page = await context.newPage();
  await page.goto(webkitUrl.href);
  await page.getByText("已连接到当前桌面窗口").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: /运行中的置顶任务/ }).click();
  await page.getByText(generatedText, { exact: true }).waitFor({ timeout: 15000 });
  await loadOlderUntil(page, "历史测试消息");
  await captureMobile(page, "webkit-conversation", evidenceDir);
  await assertScrollable(page, "WebKit V4 会话必须能够滚动");
  const layout = await page.evaluate(() => {
    const main = document.querySelector("main");
    const input = document.querySelector("input");
    return {
      scrollHeight: main.scrollHeight,
      clientHeight: main.clientHeight,
      overflowY: getComputedStyle(main).overflowY,
      inputFontSize: Number.parseFloat(getComputedStyle(input).fontSize),
      inputBottom: input.getBoundingClientRect().bottom,
    };
  });
  assert.ok(layout.scrollHeight > layout.clientHeight);
  assert.ok(["auto", "scroll"].includes(layout.overflowY));
  assert.ok(layout.inputFontSize >= 16);
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await assertScrollable(page, "WebKit 窄屏/横屏会话必须能够滚动");
    const bounds = await page.evaluate(() => {
      const main = document.querySelector("main").getBoundingClientRect();
      const input = document.querySelector("input").getBoundingClientRect();
      return {
        mainBottom: main.bottom,
        inputTop: input.top,
        inputBottom: input.bottom,
        width: document.documentElement.scrollWidth,
      };
    });
    assert.ok(bounds.mainBottom <= bounds.inputTop, "WebKit 输入栏不能覆盖消息区域");
    assert.ok(bounds.inputBottom <= viewport.height, "WebKit 输入框必须位于视口内");
    assert.ok(bounds.width <= viewport.width, "WebKit 页面不能横向溢出");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByPlaceholder("发送消息").fill("WebKit 断线草稿");
  const wsBefore = await page.evaluate(() => window.__mobileWsCount);
  const bootstrapBefore = bootstrapRequests;
  const mobile = endpoint.pairs.get(device.deviceSid)?.mobile;
  assert.ok(mobile, "WebKit paired mobile socket must exist before reconnect");
  mobile.terminate();
  fixture.appendAssistant("WebKit 断线期间新正文");
  await page.waitForFunction((count) => window.__mobileWsCount > count, wsBefore, {
    timeout: 20000,
  });
  await withTimeout(
    waitForCondition(() => bootstrapRequests > bootstrapBefore),
    20000,
    "WebKit did not complete bootstrap after reconnect",
  );
  await page.getByText(generatedText, { exact: true }).waitFor({ timeout: 15000 });
  // 同目标旧正文会保留在 connecting 视图，不能仅以旧文本存在证明恢复完成。
  await page.getByText("WebKit 断线期间新正文", { exact: true }).waitFor({ timeout: 15000 });
  await page.waitForFunction(
    () => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === "发送",
      );
      return button?.disabled === false;
    },
    undefined,
    { timeout: 15000 },
  );
  assert.equal(await page.getByPlaceholder("发送消息").inputValue(), "WebKit 断线草稿");
  await assertProjectionBeforeAck(page, device, fixture, evidenceDir, "webkit-");
  await assertQueryUnavailableRetry(page, fixture, evidenceDir, "webkit-");
  await assertWaitingRecovery(page, endpoint, device, fixture, evidenceDir, "webkit-");
  await assertCrossTargetDrafts(page, device, fixture, remoteFixture, evidenceDir, "webkit-");
  await assertRemoteSessionIsolation(page, device, fixture, remoteFixture, evidenceDir, "webkit-");
  assert.deepEqual(
    pageErrors.map((error) => error.message),
    [],
    "WebKit mobile page must not emit uncaught browser errors",
  );
  await captureMobile(page, "webkit-reconnected", evidenceDir);
  await context.close();
  console.log(
    "PASS WebKit mobile layout + non-CDP reconnect: narrow/landscape bounds, V4 snapshot and draft restoration",
  );
}

async function assertProjectionBeforeAck(page, device, fixture, evidenceDir, prefix = "") {
  const composer = page.getByPlaceholder("发送消息");
  const firstText = `${prefix}权威投影先于发送响应`;
  const secondText = `${prefix}后续输入等待独立确认`;
  const thirdDraft = `${prefix}后续确认期间的新草稿`;
  const attempts = fixture.sentCommandIds().length;
  fixture.suppressFrames(false);
  const firstAck = fixture.holdNextAck();
  await composer.fill(firstText);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const first = await withTimeout(firstAck.accepted, 10000, "first command not admitted");
  await page.getByText(firstText, { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector("input")?.value === "");
  await composer.fill(secondText);
  // 权威投影已经确认首条，ACK 仍被持有时也必须能提交下一条。
  const send = page.getByRole("button", { name: "发送", exact: true });
  assert.equal(await send.isEnabled(), true, "authoritative input must release its own send gate");
  fixture.omitProjectionForNextCommand();
  fixture.suppressFrames(true);
  const secondAck = fixture.holdNextAck();
  await send.click();
  const second = await withTimeout(secondAck.accepted, 10000, "second command not admitted");
  const repliesBefore = host.sentCount();
  firstAck.release();
  await waitForCondition(() => host.sentCount() > repliesBefore);
  // marker 与 ACK 经同一 socket 按序送达；看到 marker 才断言迟到 ACK 没解开第二条门禁。
  const marker = `${prefix}前一条响应已送达`;
  device.sendPayload({ zcode_type: "app-error", reason: marker });
  await page.getByText(marker, { exact: true }).waitFor();
  await composer.fill(thirdDraft);
  assert.equal(
    await page.getByRole("button", { name: "确认中", exact: true }).isDisabled(),
    true,
    "an earlier ACK must not release the newer submission's gate",
  );
  assert.equal(fixture.sentCommandIds().length, attempts + 2);
  secondAck.release();
  await page.getByRole("button", { name: "发送", exact: true }).waitFor();
  assert.equal(
    await composer.inputValue(),
    thirdDraft,
    "ACK must preserve the newer draft revision",
  );
  assert.equal(fixture.executionCount(first.envelope.commandId), 1);
  assert.equal(fixture.executionCount(second.envelope.commandId), 1);
  fixture.suppressFrames(false);
  await captureMobile(page, `${prefix}projection-before-ack-and-stale-gate`, evidenceDir);
  console.log(
    "PASS projection before ACK + late response: own gate released, newer submission protected",
  );
}

async function assertQueryUnavailableRetry(page, fixture, evidenceDir, evidencePrefix = "") {
  const text = "查询暂不可用后沿用原命令重试";
  const composer = page.getByPlaceholder("发送消息");
  const send = page.getByRole("button", { name: "发送", exact: true });
  const sentBefore = fixture.sentCommandIds().length;
  fixture.omitProjectionForNextCommand();
  fixture.suppressFrames(true);
  const hold = fixture.holdNextAck();
  await composer.fill(text);
  await send.click();
  const { envelope } = await withTimeout(hold.accepted, 10000, "uncertain command not admitted");
  const commandId = envelope.commandId;
  fixture.makeQueryUnavailable(commandId);
  hold.release({ reject: true });
  await withTimeout(
    waitForCondition(() => fixture.wasCommandQueried(commandId)),
    10000,
    "uncertain command was not queried",
  );
  // 查询已发生后等待 UI 恢复发送门禁；随后断言用户重试的真实上行 ID。
  await send.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === "发送",
    );
    return button?.disabled === false;
  });
  await page
    .getByText("发送结果待确认，草稿已保留。点击发送可使用原提交重试。", { exact: true })
    .waitFor({ timeout: 10000 });
  assert.equal(await page.getByText("消息未发送，草稿已保留", { exact: true }).count(), 0);
  assert.equal(await composer.inputValue(), text, "queryUnavailable must keep the draft");
  assert.equal(
    fixture.sentCommandIds().length,
    sentBefore + 1,
    "query failure must not auto-replay",
  );
  assert.equal(await page.getByText(text, { exact: true }).count(), 0, "no projection anchor");
  await captureMobile(page, `${evidencePrefix}query-unavailable-keeps-draft`, evidenceDir);
  await send.click();
  await page.waitForFunction(() => document.querySelector("input")?.value === "", undefined, {
    timeout: 10000,
  });
  assert.equal(
    fixture.sentCommandIds().at(-1),
    commandId,
    "retry must keep the original commandId",
  );
  assert.equal(fixture.executionCount(commandId), 1, "same-ID retry must not admit another input");
  assert.equal(fixture.sentCommandIds().length, sentBefore + 2, "manual retry sends exactly once");
  fixture.suppressFrames(false);
  await captureMobile(page, `${evidencePrefix}query-unavailable-retry-same-id`, evidenceDir);
  console.log(
    "PASS queryUnavailable: original commandId retained, manual retry duplicate, one fixture admission",
  );
}

async function assertWaitingRecovery(page, endpoint, device, fixture, evidenceDir, prefix = "") {
  const composer = page.getByPlaceholder("发送消息");
  const text = "桌面等待后沿用原提交重试";
  const sentBefore = fixture.sentCommandIds().length;
  fixture.omitProjectionForNextCommand();
  fixture.suppressFrames(true);
  const hold = fixture.holdNextAck();
  await composer.fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const { envelope } = await withTimeout(hold.accepted, 10000, "waiting command not admitted");
  fixture.makeQueryUnavailable(envelope.commandId);
  const mobile = endpoint.pairs.get(device.deviceSid)?.mobile;
  assert.ok(mobile, "paired mobile socket must exist before waiting injection");
  // LAN device 在进程内，没有独立 socket；注入 relay 控制帧验收手机 UI，真实断开由 relay WS 测试覆盖。
  mobile.send(JSON.stringify({ type: "pair_status_ack", pair_status: "waiting" }));
  await page.getByText("手机已连接，正在等待桌面端确认配对。", { exact: true }).waitFor();
  const send = page.getByRole("button", { name: "发送", exact: true });
  await send.waitFor({ state: "visible", timeout: 3000 });
  await page.getByText("连接已中断，请连接后重试", { exact: true }).waitFor({ timeout: 3000 });
  assert.equal(await page.getByText("mobile bridge invalidated", { exact: true }).count(), 0);
  assert.equal(await send.isDisabled(), true, "waiting must disable sending");
  assert.equal(await composer.inputValue(), text, "waiting must keep the unresolved draft");
  assert.equal(fixture.sentCommandIds().length, sentBefore + 1, "waiting must not replay data");
  await captureMobile(page, `${prefix}device-waiting-keeps-draft`, evidenceDir);
  hold.release({ reject: true });
  const bootstrapBefore = bootstrapRequests;
  const resumesBefore = resumes;
  mobile.send(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
  await page
    .getByText("发送结果待确认，草稿已保留。点击发送可使用原提交重试。", { exact: true })
    .waitFor({ timeout: 10000 });
  assert.ok(bootstrapRequests > bootstrapBefore, "matched must refresh bootstrap");
  assert.ok(resumes > resumesBefore, "matched must reopen the task attachment");
  assert.equal(await composer.inputValue(), text);
  assert.equal(await send.isEnabled(), true);
  assert.equal(fixture.sentCommandIds().length, sentBefore + 1, "matched must not auto-replay");
  await send.click();
  await page.waitForFunction(() => document.querySelector("input")?.value === "", undefined, {
    timeout: 10000,
  });
  assert.equal(fixture.sentCommandIds().at(-1), envelope.commandId);
  assert.equal(fixture.sentCommandIds().length, sentBefore + 2);
  assert.equal(fixture.executionCount(envelope.commandId), 1);
  fixture.suppressFrames(false);
  await captureMobile(page, `${prefix}device-matched-recovered`, evidenceDir);
  console.log(
    "PASS waiting/matched UI: pending RPC failed, draft retained, attachment restored, same-ID retry",
  );
}

async function assertCrossTargetDrafts(page, device, local, remote, evidenceDir, prefix = "") {
  const localTask = {
    workspaceKey: "fixture-workspace",
    taskId: "fixture-task",
    title: "运行中的置顶任务",
    displayStatus: "running",
    pinned: true,
  };
  const remoteTask = {
    workspaceKey: remoteWorkspace.workspaceKey,
    taskId: "fixture-remote-task",
    title: "远端隔离任务",
    displayStatus: "running",
  };
  device.sendPayload({
    zcode_type: "workspace-list-updated",
    result: {
      workspaces: [
        {
          workspaceKey: "fixture-workspace",
          workspacePath: "/fixture",
          workspaceIdentity: "fixture-identity",
          kind: "local",
        },
        remoteWorkspace,
      ],
      tasks: [localTask, remoteTask],
    },
  });
  const composer = page.getByPlaceholder("发送消息");
  const send = page.getByRole("button", { name: "发送", exact: true });
  const home = async () => {
    await page.getByRole("button", { name: "返回任务首页" }).click();
    await page.getByRole("heading", { name: "ZCode 远程控制", exact: true }).waitFor();
  };
  const open = async (remoteTarget) => {
    await page
      .getByRole("button", { name: remoteTarget ? /远端隔离任务/ : /运行中的置顶任务/ })
      .click();
    await page.getByText("生成中会话", { exact: true }).waitFor();
  };
  const localDraft = "本地任务的独立未提交草稿";
  const remoteDraft = "远端任务的独立未提交草稿";
  await composer.fill(localDraft);
  await home();
  await open(true);
  assert.equal(await composer.inputValue(), "", "remote task must not inherit the local draft");
  await composer.fill(remoteDraft);
  await home();
  await open(false);
  assert.equal(
    await composer.inputValue(),
    localDraft,
    "switching targets must preserve the local draft",
  );
  await home();
  await open(true);
  assert.equal(await composer.inputValue(), remoteDraft, "each target must retain its own draft");
  await home();
  await open(false);

  local.omitProjectionForNextCommand();
  local.suppressFrames(true);
  const held = local.holdNextAck();
  await send.click();
  const { envelope } = await withTimeout(held.accepted, 10000, "cross-target command not admitted");
  local.makeQueryUnavailable(envelope.commandId);
  held.release({ reject: true });
  await page
    .getByText("发送结果待确认，草稿已保留。点击发送可使用原提交重试。", { exact: true })
    .waitFor();
  await home();
  await open(true);
  assert.equal(await composer.inputValue(), remoteDraft);
  await send.click();
  await page.waitForFunction(() => document.querySelector("input")?.value === "");
  assert.equal(remote.executionCount(remote.sentCommandIds().at(-1)), 1);
  await assertQueryUnavailableRetry(page, remote, evidenceDir, `${prefix}remote-`);
  await home();
  await open(false);
  assert.equal(
    await composer.inputValue(),
    localDraft,
    "other target ACK must not clear the unresolved draft",
  );
  await page
    .getByText("发送结果待确认，草稿已保留。点击发送可使用原提交重试。", { exact: true })
    .waitFor();
  const attempts = local.sentCommandIds().length;
  await send.click();
  await page.waitForFunction(() => document.querySelector("input")?.value === "");
  assert.equal(
    local.sentCommandIds().at(-1),
    envelope.commandId,
    "returning to a target must retain its original commandId",
  );
  assert.equal(local.sentCommandIds().length, attempts + 1);
  assert.equal(local.executionCount(envelope.commandId), 1);
  await captureMobile(page, `${prefix}cross-target-pending-restored`, evidenceDir);
  console.log(
    "PASS cross-target drafts + pending: local/remote isolation, original ID retained after other target sends",
  );
}

async function assertRemoteSessionIsolation(page, device, local, remote, evidenceDir, prefix = "") {
  const composer = page.getByPlaceholder("发送消息");
  const oldText = `${prefix}旧远端 session 的未决提交`;
  const freshDraft = `${prefix}新远端 session 的独立草稿`;
  const home = async () => {
    await page.getByRole("button", { name: "返回任务首页" }).click();
    await page.getByRole("heading", { name: "ZCode 远程控制", exact: true }).waitFor();
  };
  const updateTargets = () =>
    device.sendPayload({
      zcode_type: "workspace-list-updated",
      result: {
        workspaces: [
          {
            workspaceKey: "fixture-workspace",
            workspacePath: "/fixture",
            workspaceIdentity: "fixture-identity",
            kind: "local",
          },
          activeRemoteWorkspace,
        ],
        tasks: [
          {
            workspaceKey: "fixture-workspace",
            taskId: "fixture-task",
            title: "运行中的置顶任务",
            displayStatus: "running",
            pinned: true,
          },
          {
            workspaceKey: remoteWorkspace.workspaceKey,
            taskId: "fixture-remote-task",
            title: "远端隔离任务",
            displayStatus: "running",
          },
        ],
      },
    });
  await home();
  await page.getByRole("button", { name: /远端隔离任务/ }).click();
  await page.getByText("生成中会话", { exact: true }).waitFor();
  remote.omitProjectionForNextCommand();
  remote.suppressFrames(true);
  const oldAck = remote.holdNextAck();
  await composer.fill(oldText);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const old = await withTimeout(oldAck.accepted, 10000, "old remote command not admitted");
  const subscriptionsBefore = replacementRemoteFixture.subscriptionCount();
  const replacementAttempts = replacementRemoteFixture.sentCommandIds().length;
  activeRemoteWorkspace = replacementRemoteWorkspace;
  activeRemoteFixture = replacementRemoteFixture;
  updateTargets();
  await waitForCondition(() => replacementRemoteFixture.subscriptionCount() > subscriptionsBefore);
  await page.waitForFunction(() => document.querySelector("input")?.value === "");
  await page.getByText("正在同步会话…", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(
    replacementRemoteFixture.wasCommandQueried(old.envelope.commandId),
    false,
    "a replacement remote session must not query the old target's pending command",
  );
  assert.equal(
    replacementRemoteFixture.sentCommandIds().length,
    replacementAttempts,
    "session replacement must not replay a pending submission",
  );
  replacementRemoteFixture.omitProjectionForNextCommand();
  replacementRemoteFixture.suppressFrames(true);
  const freshAck = replacementRemoteFixture.holdNextAck();
  await composer.fill(oldText);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const fresh = await withTimeout(
    freshAck.accepted,
    10000,
    "replacement remote command not admitted",
  );
  assert.notEqual(
    fresh.envelope.commandId,
    old.envelope.commandId,
    "a new remote target must use its own submission identity",
  );
  await composer.fill(freshDraft);
  oldAck.release();
  freshAck.release();
  await page.getByRole("button", { name: "发送", exact: true }).waitFor();
  assert.equal(
    await composer.inputValue(),
    freshDraft,
    "old target completion must not clear the new target's draft",
  );
  assert.equal(replacementRemoteFixture.wasCommandQueried(old.envelope.commandId), false);
  assert.equal(remote.executionCount(old.envelope.commandId), 1);
  assert.equal(replacementRemoteFixture.executionCount(fresh.envelope.commandId), 1);
  await captureMobile(page, `${prefix}remote-session-replacement-isolated`, evidenceDir);
  await home();
  await page.getByRole("button", { name: /运行中的置顶任务/ }).click();
  await page.getByText("生成中会话", { exact: true }).waitFor();
  activeRemoteWorkspace = remoteWorkspace;
  activeRemoteFixture = remote;
  replacementRemoteFixture.suppressFrames(false);
  remote.suppressFrames(false);
  local.suppressFrames(false);
  updateTargets();
  console.log(
    "PASS remote session replacement: old draft/ID/query isolated, no replay, new draft retained",
  );
}

async function waitForCondition(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 19000) throw new Error("condition timed out");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}
