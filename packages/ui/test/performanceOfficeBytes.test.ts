import { expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { readOfficePreview } from "@/hooks/readOfficePreview.js";

it("reads exact binary ranges without base64 and limits concurrency", async () => {
  const bytes = new Uint8Array(5 * 1024 * 1024 + 17).map((_, i) => i % 251);
  let inFlight = 0;
  let maxInFlight = 0;
  const service = {
    stat: vi.fn(async () => ({
      path: "test",
      type: "file" as const,
      size: bytes.length,
      mtimeMs: 1,
    })),
    readBinaryPreview: vi.fn(),
    readFileRange: vi.fn(async ({ offset, length }) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await Promise.resolve();
      inFlight--;
      return bytes.slice(offset, offset + length);
    }),
  };
  const result = await readOfficePreview(service, "test", () => false);
  expect(Buffer.compare(Buffer.from(result!), Buffer.from(bytes.buffer))).toBe(0);
  expect(maxInFlight).toBeLessThanOrEqual(4);
  expect(service.readBinaryPreview).not.toHaveBeenCalled();
});

it("rejects oversized, truncated and concurrently replaced files", async () => {
  const service = {
    stat: vi.fn(async () => ({ path: "test", type: "file" as const, size: 26 * 1024 * 1024 })),
    readBinaryPreview: vi.fn(),
    readFileRange: vi.fn(async () => new Uint8Array(0)),
  };
  await expect(readOfficePreview(service, "test", () => false)).rejects.toThrow("too large");
  expect(service.readFileRange).not.toHaveBeenCalled();
  service.stat.mockResolvedValue({ path: "test", type: "file", size: 4 });
  await expect(readOfficePreview(service, "test", () => false)).rejects.toThrow("changed");
});

it("does not send ranges after disposal", async () => {
  const service = {
    stat: vi.fn(async () => ({ path: "test", type: "file" as const, size: 4 })),
    readBinaryPreview: vi.fn(),
    readFileRange: vi.fn(),
  };
  expect(await readOfficePreview(service, "test", () => true)).toBeNull();
  expect(service.readFileRange).not.toHaveBeenCalled();
});
