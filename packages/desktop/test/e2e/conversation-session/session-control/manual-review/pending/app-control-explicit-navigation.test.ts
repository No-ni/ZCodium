import "node:fs/promises";
import "node:path";
import "playwright-core";
import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import "#e2e/helpers/conversation-session-readonly-tool";
import "#e2e/helpers/mobile-pairing";
import "#e2e/helpers/upstream-capture";
import { type AppControlToolEvidence } from "#e2e/helpers/app-control-evidence";
import "#e2e/helpers/project-sidebar";
import "#e2e/helpers/web-remote-unread";
import { getV4PaneSnapshot, waitForV4Pane } from "#e2e/helpers/v4-conversation";

const CASE = "E2E_SCT03";
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR!;
const tools: AppControlToolEvidence = {};
interface NavigationHistorySnapshot {
  entries: Array<{
    kind: string;
    taskId?: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
  cursor: number;
}
const navigationHistory: Array<{
  phase: string;
  sessionId: string | null;
  history: NavigationHistorySnapshot;
}> = [];
const evidence: Record<string, unknown> = { tools, navigationHistory };

async function captureNavigationHistory(phase: string) {
  const history = await browser.execute(() => {
    const bridge = (
      window as Window & {
        __zcodeSessionStoreE2E?: { getState(): { taskNavHistory: NavigationHistorySnapshot } };
      }
    ).__zcodeSessionStoreE2E;
    if (!bridge) throw new Error("SCT03 session store E2E bridge is unavailable");
    return bridge.getState().taskNavHistory;
  });
  navigationHistory.push({ phase, sessionId: (await getV4PaneSnapshot()).sessionId, history });
  return history;
}

async function navigateHistory(direction: "back" | "forward", sessionId: string, phase: string) {
  const before = await captureNavigationHistory(`${phase}-before-${direction}`);
  const button = $(
    direction === "back"
      ? '[data-testid="desktop-top-nav-back"]'
      : 'button[aria-label="Go forward"]',
  );
  let after: NavigationHistorySnapshot;
  try {
    await button.waitForEnabled({ timeout: 10_000 });
    await button.click();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId,
      `${CASE} ${phase} ${direction} did not open ${sessionId}`,
      10_000,
    );
  } finally {
    // 旧列表缓存 miss 曾把仍存在的历史项删掉；失败现场也保留栈，不能靠侧栏重选绕过。
    after = await captureNavigationHistory(`${phase}-after-${direction}`);
  }
  expect(after.entries).toEqual(before.entries);
  expect(after.cursor).toBe(before.cursor + (direction === "back" ? -1 : 1));
  expect(after.entries[after.cursor]?.taskId).toBe(sessionId);
}

interface TaskMetaProbe {
  request?: number[];
  response?: number[];
  start(request: number[], prefixes: number[][], originalPrefixes: number[][]): void;
  release(response?: number[]): Promise<void>;
  restore(): void;
}
declare global {
  interface Window {
    __sct03TaskMetaProbe?: TaskMetaProbe;
  }
}

/** 沿真实 Window Host RPC 暂挂一次 meta 返回；不伪造成功结果，也不改 store。 */
async function holdTaskMeta(taskId: string) {
  await browser.execute(
    (channel, targetId) => {
      const original = MessagePort.prototype.postMessage;
      let port:
        | (Pick<MessagePort, "addEventListener" | "removeEventListener" | "dispatchEvent"> & {
            send: MessagePort["postMessage"];
          })
        | undefined;
      let receive: ((event: MessageEvent) => void) | undefined;
      let started = false;
      const probe: TaskMetaProbe = {
        start(request, prefixes, originalPrefixes) {
          if (!port || !probe.request) throw new Error("SCT03 missing held meta request");
          receive = (event) => {
            if (!(event.data instanceof Uint8Array)) return;
            const index = prefixes.findIndex((prefix) =>
              prefix.every((byte, offset) => event.data[offset] === byte),
            );
            if (index < 0) return;
            // MessagePort 的 capture listener 不先于已注册 listener；用独立请求 ID 隔离回执，
            // 只还原响应头，真实 Host body 原样保留，release 前不完成产品请求。
            probe.response = [
              ...originalPrefixes[index]!,
              ...event.data.slice(prefixes[index]!.length),
            ];
            port!.removeEventListener("message", receive!);
          };
          port.addEventListener("message", receive);
          started = true;
          port.send(Uint8Array.from(request));
        },
        async release(response) {
          if (!port || !probe.response) throw new Error("SCT03 missing real meta response");
          const data = Uint8Array.from(response ?? probe.response);
          delete probe.response;
          port.dispatchEvent(new MessageEvent("message", { data }));
          // 等响应的 promise 微任务和随后 UI 绘制，不用固定延时猜测迟到结果已消费。
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        },
        restore() {
          MessagePort.prototype.postMessage = original;
          if (receive) port?.removeEventListener("message", receive);
          if (probe.response)
            port?.dispatchEvent(
              new MessageEvent("message", {
                data: Uint8Array.from(probe.response),
              }),
            );
          else if (!started && probe.request) port?.send(Uint8Array.from(probe.request));
          delete window.__sct03TaskMetaProbe;
        },
      };
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        if (!probe.request && message instanceof Uint8Array) {
          const text = new TextDecoder().decode(message);
          if (text.includes(channel) && text.includes("getTaskMeta") && text.includes(targetId)) {
            port = {
              send: original.bind(this),
              addEventListener: this.addEventListener.bind(this),
              removeEventListener: this.removeEventListener.bind(this),
              dispatchEvent: this.dispatchEvent.bind(this),
            };
            probe.request = Array.from(message);
            return;
          }
        }
        Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
      };
      window.__sct03TaskMetaProbe = probe;
    },
    ServiceChannels.ZCodeTask,
    taskId,
  );
}

async function waitForRealTaskMeta(taskId: string, phase: string) {
  await browser.waitUntil(
    () => browser.execute(() => Boolean(window.__sct03TaskMetaProbe?.request)),
    {
      timeout: 10_000,
      timeoutMsg: "SCT03 navigation did not query Host getTaskMeta",
    },
  );
  const request = await browser.execute(() => window.__sct03TaskMetaProbe!.request!);
  const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(request)));
  const header = deserialize(reader) as [number, number, string, string];
  const args = deserialize(reader);
  expect(header).toEqual([100, expect.any(Number), ServiceChannels.ZCodeTask, "getTaskMeta"]);
  expect(args).toEqual([expect.objectContaining({ workspacePath: DEFAULT_WORKSPACE, taskId })]);
  const probeId = -9400 - header[1];
  const wireRequest = new BufferWriter();
  serialize(wireRequest, [100, probeId, header[2], header[3]]);
  serialize(wireRequest, args);
  const responsePrefixes = (id: number) =>
    [201, 202, 203].map((type) => {
      const writer = new BufferWriter();
      serialize(writer, [type, id]);
      return Array.from(writer.buffer.buffer);
    });
  await browser.execute(
    (request, prefixes, originalPrefixes) =>
      window.__sct03TaskMetaProbe!.start(request, prefixes, originalPrefixes),
    Array.from(wireRequest.buffer.buffer),
    responsePrefixes(probeId),
    responsePrefixes(header[1]),
  );
  await browser.waitUntil(
    () => browser.execute(() => Boolean(window.__sct03TaskMetaProbe?.response)),
    {
      timeout: 10_000,
      timeoutMsg: "SCT03 Host did not return the real task meta",
    },
  );
  const response = await browser.execute(() => window.__sct03TaskMetaProbe!.response!);
  const responseReader = new BufferReader(VSBuffer.wrap(Uint8Array.from(response)));
  const responseHeader = deserialize(responseReader);
  const meta = deserialize(responseReader);
  evidence[phase] = { header, probeId, args, responseHeader, meta };
  expect(responseHeader).toEqual([201, header[1]]);
  expect(meta).toEqual(expect.objectContaining({ taskId }));
  return header[1];
}
