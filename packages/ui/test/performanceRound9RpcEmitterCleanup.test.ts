import { afterEach, expect, it, vi } from "vitest";
import { BufferWriter, ChannelClient, Emitter, serialize, type VSBuffer } from "@zcode/rpc";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const input = new Emitter<VSBuffer>();
  const client = new ChannelClient({ onMessage: input.event, send() {} });
  const writer = new BufferWriter();
  serialize(writer, [200]);
  serialize(writer, undefined);
  input.fire(writer.buffer);
  const getEvent = Object.getOwnPropertyDescriptor(Emitter.prototype, "event")!.get!;
  const locals: Emitter<unknown>[] = [];
  const observe = vi
    .spyOn(Emitter.prototype, "event", "get")
    .mockImplementation(function (this: Emitter<unknown>) {
      locals.push(this);
      return getEvent.call(this);
    });
  const event = client.getChannel("fixture").listen("event");
  observe.mockRestore();
  return {
    client,
    input,
    event,
    localListeners: () => (locals.at(-1) as unknown as { listeners: Set<unknown> }).listeners.size,
  };
}

it("client dispose releases the local callbacks retained by a still-referenced Event", () => {
  const test = fixture();
  const handle = test.event(() => {});
  expect(test.localListeners()).toBe(1);
  test.client.dispose();
  const retainedListeners = test.localListeners();
  handle.dispose();
  test.input.dispose();
  expect(retainedListeners).toBe(0);
});

it.each([false, true])(
  "an inactive old Event releases new callbacks after client dispose (used: %s)",
  (used) => {
    const test = fixture();
    if (used) test.event(() => {}).dispose();
    test.client.dispose();
    const handle = test.event(() => {});
    const retainedListeners = test.localListeners();
    handle.dispose();
    test.input.dispose();
    expect(retainedListeners).toBe(0);
  },
);
