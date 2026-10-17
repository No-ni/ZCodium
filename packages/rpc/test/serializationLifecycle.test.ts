import { describe, expect, it } from "vitest";
import { BufferReader, BufferWriter, deserialize, serialize } from "../src/serialization.js";

describe("RPC encoding fails locally before producing unreadable JSON", () => {
  it.each([
    { label: "function", value: () => {} },
    { label: "symbol", value: Symbol("fixture") },
    {
      label: "undefined from toJSON",
      value: {
        toJSON() {
          return undefined;
        },
      },
    },
  ])("rejects $label before writing an Object payload", ({ value }) => {
    const writer = new BufferWriter();
    expect(() => serialize(writer, value)).toThrow(TypeError);
    expect(writer.buffer.byteLength).toBe(0);
  });

  it("retains valid undefined, JSON, array and binary encodings", () => {
    const values = [
      undefined,
      null,
      false,
      1.5,
      { nested: [1, "value"] },
      [undefined, "value"],
      new Uint8Array([1, 2]),
    ];
    const writer = new BufferWriter();
    for (const value of values) serialize(writer, value);
    const reader = new BufferReader(writer.buffer);
    for (const value of values) expect(deserialize(reader)).toEqual(value);
  });
});
