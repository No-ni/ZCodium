import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";

const SAVE_METHOD = "savePersonalProviderOverlay";
interface SaveGate {
  held: { port: MessagePort; frame: Uint8Array } | null;
  reply: { port: MessagePort; frame: Uint8Array } | null;
  replyReceived: boolean;
  matches: number;
  release: (prefix?: number[], holdReply?: boolean) => void;
  reject: (bytes: number[]) => void;
  releaseReply: () => void;
  restore: () => void;
}
type GateWindow = Window & { __compressionSaveGate?: SaveGate };

/** 仅控制合成渠道的一次 RPC；释放后仍由真实 Host 服务写入。 */
export async function installSaveGate(providerId: string) {
  await browser.execute(
    (id, method) => {
      const target = window as GateWindow;
      target.__compressionSaveGate?.restore();
      const original = MessagePort.prototype.postMessage;
      const originalData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
      if (!originalData?.get) throw new Error("MessageEvent.data getter is unavailable");
      const withheldEvents = new WeakSet<MessageEvent>();
      let expectedReply: { port: MessagePort; prefix: number[]; holdReply: boolean } | null = null;
      const gate: SaveGate = {
        held: null,
        reply: null,
        replyReceived: false,
        matches: 0,
        release(prefix, holdReply = false) {
          const held = gate.held;
          gate.held = null;
          if (!held) return;
          if (prefix) expectedReply = { port: held.port, prefix, holdReply };
          original.call(held.port, held.frame);
        },
        reject(bytes) {
          const held = gate.held;
          if (!held) throw new Error("No pending compression save frame");
          gate.held = null;
          held.port.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(bytes) }));
        },
        releaseReply() {
          const reply = gate.reply;
          gate.reply = null;
          if (reply) reply.port.dispatchEvent(new MessageEvent("message", { data: reply.frame }));
        },
        restore() {
          MessagePort.prototype.postMessage = original;
          Object.defineProperty(MessageEvent.prototype, "data", originalData);
          expectedReply = null;
          gate.release();
          gate.releaseReply();
          delete target.__compressionSaveGate;
        },
      };
      Object.defineProperty(MessageEvent.prototype, "data", {
        ...originalData,
        get(this: MessageEvent): unknown {
          if (withheldEvents.has(this)) return undefined;
          const frame: unknown = originalData.get!.call(this);
          const expected = expectedReply;
          if (
            !expected ||
            this.target !== expected.port ||
            !(frame instanceof Uint8Array) ||
            !expected.prefix.every((byte, index) => frame[index] === byte)
          )
            return frame;
          gate.replyReceived = true;
          expectedReply = null;
          if (!expected.holdReply) return frame;
          // MessagePort 没有 DOM 传播树，后注册的 capture 不能抢在 RPC 前拦截。
          // 仅隐藏这条合成渠道回执的数据；RPC 忽略非二进制事件，其余 Host 事件保持原样。
          withheldEvents.add(this);
          gate.reply = { port: expected.port, frame: frame.slice() };
          return undefined;
        },
      });
      MessagePort.prototype.postMessage = function (this: MessagePort, ...args) {
        const message: unknown = args[0];
        if (message instanceof Uint8Array) {
          const text = new TextDecoder().decode(message);
          if (text.includes(method) && text.includes(id)) {
            gate.matches += 1;
            if (gate.matches === 1) {
              gate.held = { port: this, frame: message.slice() };
              return;
            }
          }
        }
        Reflect.apply(original, this, args);
      };
      target.__compressionSaveGate = gate;
    },
    providerId,
    SAVE_METHOD,
  );
}

export async function waitForHeldSave(expectedCompression = "brotli"): Promise<number> {
  await browser.waitUntil(
    () => browser.execute(() => Boolean((window as GateWindow).__compressionSaveGate?.held)),
    { timeout: 15_000, timeoutMsg: "Brotli save did not reach the controlled RPC gate" },
  );
  const bytes = await browser.execute(() =>
    Array.from((window as GateWindow).__compressionSaveGate!.held!.frame),
  );
  const reader = new BufferReader(VSBuffer.wrap(new Uint8Array(bytes)));
  const header = deserialize(reader) as [number, number, string, string];
  const args: unknown = deserialize(reader);
  expect(header[0]).toBe(100);
  expect(header[3]).toBe(SAVE_METHOD);
  expect(JSON.stringify(args)).toContain(expectedCompression);
  return header[1];
}

export async function releaseSave(
  requestId: number,
  options: { reject?: string; holdReply?: boolean } = {},
) {
  const writer = new BufferWriter();
  // 使用公开序列化接口生成回执头，不在浏览器手写 RPC 解码器。
  serialize(writer, [options.reject ? 202 : 201, requestId]);
  if (options.reject) {
    serialize(writer, { name: "Error", message: options.reject });
    await browser.execute(
      (bytes) => (window as GateWindow).__compressionSaveGate!.reject(bytes),
      Array.from(writer.buffer.buffer),
    );
    return;
  }
  await browser.execute(
    (prefix, holdReply) => (window as GateWindow).__compressionSaveGate!.release(prefix, holdReply),
    Array.from(writer.buffer.buffer),
    options.holdReply ?? false,
  );
}

export async function waitForSaveReply() {
  await browser.waitUntil(
    () =>
      browser.execute(() => (window as GateWindow).__compressionSaveGate?.replyReceived === true),
    { timeout: 15_000, timeoutMsg: "The authoritative save reply was not received" },
  );
}

export async function releaseSaveReply() {
  await browser.execute(() => (window as GateWindow).__compressionSaveGate!.releaseReply());
}

export async function readSaveCount() {
  return browser.execute(() => (window as GateWindow).__compressionSaveGate?.matches ?? 0);
}

export async function restoreSaveGate() {
  await browser.execute(() => (window as GateWindow).__compressionSaveGate?.restore());
}
