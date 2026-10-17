import { expect, it, vi } from "vitest";
import { fetchWorkspaceFileEntriesPacked } from "@/workspace-file-search/fetchWorkspaceFileEntries.js";
import { WORKSPACE_FILE_ENTRIES_CHUNK_SIZE as size } from "@zcode/shared/workspaceFileEntriesCodec";

it("stops a ten-block read after disposal during the first block", async () => {
  const controller = new AbortController();
  let release!: (chunk: string) => void;
  const service = {
    listWorkspaceFilesLength: vi.fn(async () => size * 10),
    listWorkspaceFilesRange: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    ),
  };
  const pending = fetchWorkspaceFileEntriesPacked(service, "/repo", "/rules", controller.signal);
  const settled = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await Promise.resolve();
  controller.abort();
  release("first");
  // 旧实现会继续发第二块；让后续块立即收口以得到完整失败证据。
  service.listWorkspaceFilesRange.mockImplementation(async () => "later");
  expect(await settled).toHaveProperty("error");
  expect(service.listWorkspaceFilesRange).toHaveBeenCalledTimes(1);
});

it("does not start a length request after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const service = {
    listWorkspaceFilesLength: vi.fn(async () => size),
    listWorkspaceFilesRange: vi.fn(async () => "chunk"),
  };
  await expect(
    fetchWorkspaceFileEntriesPacked(service, "/repo", undefined, controller.signal),
  ).rejects.toBe(controller.signal.reason);
  expect(service.listWorkspaceFilesLength).not.toHaveBeenCalled();
});

it("does not request blocks when cancelled while length is in flight", async () => {
  const controller = new AbortController();
  let release!: (length: number) => void;
  const service = {
    listWorkspaceFilesLength: vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    ),
    listWorkspaceFilesRange: vi.fn(async () => "chunk"),
  };
  const pending = fetchWorkspaceFileEntriesPacked(service, "/repo", undefined, controller.signal);
  controller.abort();
  release(size * 2);
  await expect(pending).rejects.toBe(controller.signal.reason);
  expect(service.listWorkspaceFilesRange).not.toHaveBeenCalled();
});

it("keeps ordered chunks, rule root and legacy no-signal callers", async () => {
  const service = {
    listWorkspaceFilesLength: vi.fn(async () => size + 1),
    listWorkspaceFilesRange: vi.fn(async ({ offset }: { offset: number }) =>
      offset === 0 ? "one" : "two",
    ),
  };
  expect(await fetchWorkspaceFileEntriesPacked(service, "/repo", "/rules")).toBe("onetwo");
  expect(service.listWorkspaceFilesLength).toHaveBeenCalledWith({
    rootPath: "/repo",
    ignoreRulesRoot: "/rules",
  });
  expect(service.listWorkspaceFilesRange.mock.calls).toEqual([
    [{ rootPath: "/repo", ignoreRulesRoot: "/rules", offset: 0, length: size }],
    [{ rootPath: "/repo", ignoreRulesRoot: "/rules", offset: size, length: size }],
  ]);
});

it("propagates actual IO failures", async () => {
  const failure = new Error("synthetic read failure");
  const service = {
    listWorkspaceFilesLength: vi.fn(async () => size),
    listWorkspaceFilesRange: vi.fn(async () => {
      throw failure;
    }),
  };
  await expect(
    fetchWorkspaceFileEntriesPacked(service, "/repo", undefined, new AbortController().signal),
  ).rejects.toBe(failure);
});
