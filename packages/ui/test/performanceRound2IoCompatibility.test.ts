import { expect, it, vi } from "vitest";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { filterCommandCenterFileSearchResults } from "@/hooks/useCommandCenterFileSearch.js";
import { readOfficePreview } from "@/hooks/readOfficePreview.js";

vi.mock("@/hooks/useServices.js", () => ({ useServices: vi.fn() }));

it("filters old Host fuzzy-only, absolute-path-only and directory candidates with bounded work", () => {
  const entries: WorkspaceFileEntry[] = [
    { name: "abc.txt", path: "C:/repo/abc.txt", relativePath: "abc.txt", type: "file" },
    { name: "a-b-c.txt", path: "C:/repo/a-b-c.txt", relativePath: "a-b-c.txt", type: "file" },
    { name: "file.txt", path: "C:/abc/file.txt", relativePath: "file.txt", type: "file" },
    { name: "abc", path: "C:/repo/abc", relativePath: "abc", type: "directory" },
  ];
  expect(filterCommandCenterFileSearchResults(entries, "ABC txt")).toEqual([entries[0]]);
  expect(filterCommandCenterFileSearchResults(entries, " ")).toEqual([]);
  const bounded = new Proxy(
    Array.from({ length: 1000 }, () => entries[0]!),
    {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key) && Number(key) >= 80)
          throw new Error("read beyond the response cap");
        return Reflect.get(target, key, receiver);
      },
    },
  );
  expect(filterCommandCenterFileSearchResults(bounded, "abc")).toHaveLength(80);
});

it("does not schedule another Office batch or final stat after disposal during four reads", async () => {
  let disposed = false;
  const releases: Array<() => void> = [];
  const service = {
    stat: vi.fn(async () => ({
      path: "synthetic.docx",
      type: "file" as const,
      size: 10 * 1024 * 1024,
      mtimeMs: 1,
    })),
    readBinaryPreview: vi.fn(),
    readFileRange: vi.fn(
      ({ length }: { length: number }) =>
        new Promise<Uint8Array>((resolve) => {
          releases.push(() => resolve(new Uint8Array(length)));
        }),
    ),
  };
  const pending = readOfficePreview(service, "synthetic.docx", () => disposed);
  await Promise.resolve();
  expect(releases).toHaveLength(4);
  disposed = true;
  releases.forEach((release) => release());
  expect(await pending).toBeNull();
  expect(service.readFileRange).toHaveBeenCalledTimes(4);
  expect(service.stat).toHaveBeenCalledTimes(1);
});

it("rejects an Office file replaced with the same size during reading", async () => {
  const service = {
    stat: vi
      .fn()
      .mockResolvedValueOnce({ path: "synthetic.docx", type: "file", size: 4, mtimeMs: 1 })
      .mockResolvedValueOnce({ path: "synthetic.docx", type: "file", size: 4, mtimeMs: 2 }),
    readBinaryPreview: vi.fn(),
    readFileRange: vi.fn(async () => new Uint8Array(4)),
  };
  await expect(readOfficePreview(service, "synthetic.docx", () => false)).rejects.toThrow(
    "changed",
  );
});
