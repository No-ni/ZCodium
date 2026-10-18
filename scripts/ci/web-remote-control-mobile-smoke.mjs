import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { tsImport } from "tsx/esm/api";
import { build as buildWeb } from "vite";
import {
  captureMobile,
  createMobileMessages,
  longText,
  assertScrollable,
  swipeUp,
  scrollToLast,
  assertMobileConversationLayout,
  assertViewScrollIsolation,
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
const taskEvents = new Emitter();
let taskActive = false;
let resumes = 0;
let bootstrapRequests = 0;
let prompt;
const messages = createMobileMessages();
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
      rollupOptions: { input: resolve(root, "packages/web/mobile.html") },
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
        const incoming = new Emitter();
        let seq = 0;
        const streamId = payload.bridgeSessionId;
        const assembler = new WebRemoteControlRpcAssembler({ streamId });
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
              assert.equal(params.taskId, "fixture-task");
              assert.equal(params.workspacePath, "/fixture");
              assert.equal(params.clientMode, undefined);
              taskActive = true;
              resumes++;
              return {};
            },
            onDynamicTaskEvent(params) {
              assert.equal(taskActive, true, "cold task must resume before subscription");
              assert.equal(params.deliveryKind, "replayable");
              return taskEvents.event;
            },
            async sendPrompt(params) {
              prompt = params;
            },
          }),
        );
        server.registerChannel(
          ServiceChannels.ZCodeSession,
          ProxyChannel.fromService({
            async readSessionMessages() {
              assert.equal(taskActive, true, "cold task must resume before reading");
              return messages;
            },
          }),
        );
        host = {
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
          },
        };
        device.sendPayload({
          zcode_type: "workspace-bridge-ready",
          requestId: payload.requestId,
          bridgeSessionId: streamId,
          bridge: {
            bridgeSessionId: streamId,
            workspaceKey: "fixture-workspace",
            workspacePath: "/fixture",
            kind: "local",
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
  await second.getByRole("button", { name: /运行中的置顶任务/ }).click();
  await second.getByText("历史测试消息", { exact: true }).waitFor();
  await captureMobile(second, "conversation", evidenceDir);
  await assertMobileConversationLayout(second, longText);
  await captureMobile(second, "conversation-scrolled", evidenceDir);
  const initialResumes = resumes;
  device.sendPayload({
    zcode_type: "workspace-list-updated",
    result: {
      workspaces: [{ workspaceKey: "fixture-workspace", workspacePath: "/fixture", kind: "local" }],
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
  await second.getByPlaceholder("发送消息").fill("手机测试输入");
  taskEvents.fire({
    type: "agent_message_chunk",
    taskId: "fixture-task",
    traceId: "fixture-trace",
    messageId: "fixture-assistant",
    content: "实时测试输出",
  });
  await second.getByText("实时测试输出", { exact: true }).waitFor();
  assert.equal(resumes, initialResumes, "list updates must not restart conversation");
  await second.getByRole("button", { name: "发送", exact: true }).click();
  await second.getByText("手机测试输入", { exact: true }).waitFor();
  await second.waitForFunction(() => document.querySelector("input").value === "");
  assert.equal(prompt?.content, "手机测试输入");
  assert.equal(prompt?.clientMode, "web-remote-replayable");
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

  // 仅对活动页面模拟暂时离线：真实 socket 被浏览器断开，恢复网络后应由客户端自动重连。
  const cdp = await context.newCDPSession(second);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  // CDP 的 offline 标志不会在所有 Chromium 版本主动关闭既有 WS；在 endpoint 上终止真实 socket，
  // 模拟传输中断，再由真实 MobileRemoteControlClient 执行退避重连。
  const bootstrapBeforeReconnect = bootstrapRequests;
  messages[0].parts[0].text = "重连后的权威历史";
  endpoint.pairs.get(device.deviceSid).mobile.terminate();
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  // 先等新 socket，再等配对；否则旧页面尚未处理 close 时残留的「已连接」会造成竞态。
  await second.waitForFunction(() => window.__mobileWsCount >= 2, undefined, { timeout: 12000 });
  // task Shell 已配对时隐藏连接横幅；以重读到的新权威历史确认恢复完成。
  await second.getByText("重连后的权威历史", { exact: true }).waitFor({ timeout: 12000 });
  assert.ok(bootstrapRequests > bootstrapBeforeReconnect, "reconnection must refresh bootstrap");
  assert.equal(
    await second.locator(".text-destructive").count(),
    0,
    "successful task entry and recovery must not leave red errors",
  );
  await assertViewScrollIsolation(second);
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
    "PASS Chromium mobile + real CSS + LAN + Channel RPC: touch scrolling, long messages, narrow/landscape layout, pairing, cold history, live delta, prompt, offline recovery; bad hash and duplicate page terminate",
  );
  console.log("Rerun: node scripts/ci/web-remote-control-mobile-smoke.mjs");
} finally {
  try {
    await browser?.close();
    host?.dispose();
    taskEvents.dispose();
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
