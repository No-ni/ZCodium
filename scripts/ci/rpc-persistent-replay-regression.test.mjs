import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { PersistentProtocol, ProtocolMessageType, Emitter, VSBuffer } = await tsImport(
  "../../packages/rpc/src/index.ts",
  import.meta.url,
);

function socket() {
  const data = new Emitter();
  const closed = new Emitter();
  const writes = [];
  return {
    data,
    writes,
    value: {
      onData: data.event,
      onClose: closed.event,
      onEnd: closed.event,
      write: (buffer) => writes.push(buffer),
      end() {},
      drain: async () => {},
      dispose() {
        data.dispose();
        closed.dispose();
      },
    },
  };
}
function frame(id, ack = 0, body = String(id)) {
  const payload = new TextEncoder().encode(body);
  const result = VSBuffer.alloc(13 + payload.byteLength);
  result.writeUInt8(ProtocolMessageType.Regular, 0);
  result.writeUInt32BE(id, 1);
  result.writeUInt32BE(ack, 5);
  result.writeUInt32BE(payload.byteLength, 9);
  result.set(payload, 13);
  return result;
}

test("重连重放不重复投递已接收的有序帧，ACK 不倒退", () => {
  const first = socket();
  const protocol = new PersistentProtocol(first.value);
  try {
    const received = [];
    protocol.onMessage((body) => received.push(body.toString()));
    first.data.fire(frame(1));
    first.data.fire(frame(2));
    const replacement = socket();
    protocol.replaceSocket(replacement.value);
    replacement.data.fire(VSBuffer.concat([frame(1), frame(2), frame(3)]));
    assert.deepEqual(received, ["1", "2", "3"]);
    replacement.data.fire(frame(1));
    protocol.send(VSBuffer.fromString("reply"));
    assert.equal(replacement.writes.at(-1).readUInt32BE(5), 3);
  } finally {
    protocol.dispose();
  }
});

test("被去重的重放帧仍处理对端 piggyback ACK 并释放发送缓存", () => {
  const source = socket();
  const protocol = new PersistentProtocol(source.value);
  try {
    const received = [];
    protocol.onMessage((body) => received.push(body.toString()));
    source.data.fire(frame(1));
    protocol.send(VSBuffer.fromString("outgoing"));
    assert.equal(protocol.unacknowledgedBytes, 8);
    source.data.fire(frame(1, 1));
    assert.equal(protocol.unacknowledgedBytes, 0);
    assert.deepEqual(received, ["1"]);
  } finally {
    protocol.dispose();
  }
});

test("非可靠 SocketProtocol 的零号帧继续独立投递且不覆盖有序 ACK", () => {
  const source = socket();
  const protocol = new PersistentProtocol(source.value);
  try {
    const received = [];
    protocol.onMessage((body) => received.push(body.toString()));
    source.data.fire(frame(1));
    source.data.fire(frame(0, 0, "first-zero"));
    source.data.fire(frame(0, 0, "second-zero"));
    protocol.send(VSBuffer.fromString("reply"));
    assert.deepEqual(received, ["1", "first-zero", "second-zero"]);
    assert.equal(source.writes.at(-1).readUInt32BE(5), 1);
  } finally {
    protocol.dispose();
  }
});
