import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSessionDataFiles } from "../src/storage/session-data-files/index.js";
import {
  createProjectTestFixture,
  createProjectTestSymlink,
} from "../../../../../scripts/ci/project-test-sandbox.mjs";

async function setup() {
  const root = await createProjectTestFixture("session-data-files");
  const cli = join(root, "cli");
  const files = createNodeSessionDataFiles({
    cliStorageRoot: cli,
    memoryRoot: ({ workspacePath }) =>
      join(cli, "memories", "projects", `${basename(workspacePath)}-hash`, "memory"),
  });
  const write = async (path: string, bytes: number) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "x".repeat(bytes));
  };
  return { root, cli, files, write };
}

describe("node session data files", () => {
  it("measures and removes every per-session location and leaves other sessions alone", async () => {
    const { cli, files, write } = await setup();
    await write(join(cli, "artifacts", "sess_a", "out.txt"), 100);
    await write(join(cli, "exec", "sess_a", "bash.log"), 20);
    await write(join(cli, "agents", "sess_a", "agent_1", "transcript.jsonl"), 3);
    await write(join(cli, "sessions", "sess_a", "workflows", "w.js"), 4);
    await write(join(cli, "debug", "model-io-sess_a.jsonl"), 5);
    await write(join(cli, "rollout", "model-io-sess_a.jsonl"), 6);
    await write(join(cli, "artifacts", "sess_b", "keep.txt"), 7);

    expect(await files.measureSession("sess_a")).toBe(138);
    expect(await files.removeSession("sess_a")).toBe(138);
    expect(await files.measureSession("sess_a")).toBe(0);
    expect(await readdir(join(cli, "artifacts"))).toEqual(["sess_b"]);
    expect(await files.measureSession("sess_b")).toBe(7);
    // 已删除的会话再次删除返回 0，不报错。
    expect(await files.removeSession("sess_a")).toBe(0);
  });

  it("removes the whole memory folder of a directory", async () => {
    const { cli, files, write } = await setup();
    await write(join(cli, "memories", "projects", "demo-hash", "memory", "MEMORY.md"), 9);
    await write(join(cli, "memories", "projects", "other-hash", "memory", "MEMORY.md"), 1);
    expect(await files.measureMemory({ workspacePath: "/work/demo" })).toBe(9);
    expect(await files.removeMemory({ workspacePath: "/work/demo" })).toBe(9);
    expect(await readdir(join(cli, "memories", "projects"))).toEqual(["other-hash"]);
  });

  it("rejects session ids that would escape the storage root", async () => {
    const { files } = await setup();
    for (const id of ["../db", "a/b", "a\\b", "", "..", "."]) {
      await expect(files.removeSession(id)).rejects.toThrow("session-data.invalid-session-id");
    }
  });

  it("does not follow a symlinked session folder out of the storage root", async () => {
    const { root, cli, files, write } = await setup();
    const outside = join(root, "outside");
    await write(join(outside, "precious.txt"), 50);
    await mkdir(join(cli, "artifacts"), { recursive: true });
    await createProjectTestSymlink(outside, join(cli, "artifacts", "sess_link"), "dir");
    expect(await files.measureSession("sess_link")).toBe(0);
    await files.removeSession("sess_link");
    expect((await stat(join(outside, "precious.txt"))).size).toBe(50);
  });

  it("rejects a linked session parent before removing any member of the batch", async () => {
    const { root, cli, files, write } = await setup();
    const outside = join(root, "outside");
    await write(join(outside, "sess_a", "precious.txt"), 50);
    await write(join(cli, "exec", "sess_a", "keep.txt"), 7);
    await createProjectTestSymlink(outside, join(cli, "artifacts"), "dir");

    await expect(files.measureSession("sess_a")).rejects.toThrow(
      "session-data.storage-link-rejected",
    );
    await expect(files.removeSession("sess_a")).rejects.toThrow(
      "session-data.storage-link-rejected",
    );
    expect((await stat(join(outside, "sess_a", "precious.txt"))).size).toBe(50);
    expect((await stat(join(cli, "exec", "sess_a", "keep.txt"))).size).toBe(7);
  });

  it("rejects a linked memory ancestor without touching the project folder", async () => {
    const { root, cli, files, write } = await setup();
    const outside = join(root, "outside");
    await write(join(outside, "projects", "demo-hash", "memory", "MEMORY.md"), 9);
    await mkdir(cli, { recursive: true });
    await createProjectTestSymlink(outside, join(cli, "memories"), "dir");

    await expect(files.measureMemory({ workspacePath: "/work/demo" })).rejects.toThrow(
      "session-data.storage-link-rejected",
    );
    await expect(files.removeMemory({ workspacePath: "/work/demo" })).rejects.toThrow(
      "session-data.storage-link-rejected",
    );
    expect((await stat(join(outside, "projects", "demo-hash", "memory", "MEMORY.md"))).size).toBe(
      9,
    );
  });

  it("rejects a linked CLI root", async () => {
    const { root, cli, files, write } = await setup();
    const outside = join(root, "outside");
    await write(join(outside, "debug", "model-io-sess_a.jsonl"), 11);
    await createProjectTestSymlink(outside, cli, "dir");

    await expect(files.removeSession("sess_a")).rejects.toThrow(
      "session-data.storage-link-rejected",
    );
    expect((await stat(join(outside, "debug", "model-io-sess_a.jsonl"))).size).toBe(11);
  });
});
