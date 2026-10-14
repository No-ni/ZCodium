import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createSessionId } from "@zcode/contracts";
import * as execution from "../src/app/conversation-session-workspace-execution.js";
import { ensureConversationSessionDirForBareResume } from "../src/app/conversation-session-workspace.js";

test("subagent resume rebuilds persisted nested cwd and rejects links before executing", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-subagent-prepare-"));
  const outside = join(root, "..", `${basename(root)}-outside`);
  try {
    const parent = join(root, "2026-10-14", "12345678");
    const child = join(parent, "nested", "deeper");
    await mkdir(parent, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "marker"), "keep");
    const input = {
      conversationRoot: root,
      workspacePath: root,
      workingDirectory: parent,
      sessionId: createSessionId("subagent_fixture"),
      resumeFromStore: true,
      store: { getSession: async () => ({ directory: root, path: child }) },
    };
    await execution.prepareConversationSubagentSession(input);
    assert.ok((await stat(child)).isDirectory());
    await execution.prepareConversationSubagentSession({
      ...input,
      store: { getSession: async () => null },
    });
    await assert.rejects(
      execution.prepareConversationSubagentSession({
        ...input,
        store: { getSession: async () => ({ directory: root, path: root }) },
      }),
      { name: "ConversationSessionWorkspaceUnavailableError" },
    );
    await rm(join(parent, "nested"), { recursive: true });
    await symlink(outside, join(parent, "nested"), "dir");
    await assert.rejects(execution.prepareConversationSubagentSession(input), {
      name: "ConversationSessionWorkspaceUnavailableError",
    });
    await assert.rejects(
      execution.prepareConversationSubagentSession({
        ...input,
        resumeFromStore: false,
        workingDirectory: child,
      }),
      { name: "ConversationSessionWorkspaceUnavailableError" },
    );
    await execution.prepareConversationSubagentSession({
      ...input,
      resumeFromStore: false,
      workingDirectory: outside,
    });
    await execution.prepareConversationSubagentSession({
      ...input,
      store: { getSession: async () => ({ directory: root, path: outside }) },
    });
    await assert.rejects(
      execution.prepareConversationSubagentSession({
        ...input,
        resumeFromStore: false,
        workingDirectory: root,
      }),
      { name: "ConversationSessionWorkspaceUnavailableError" },
    );
    await assert.rejects(stat(join(outside, "deeper")), { code: "ENOENT" });
    assert.equal(await readFile(join(outside, "marker"), "utf8"), "keep");
    for (const scope of [{ workspacePath: outside }, { workspaceIdentity: "remote:fixture" }]) {
      await execution.prepareConversationSubagentSession({ ...input, ...scope });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("bare child resume prepares its persisted cwd without a Host marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-bare-child-prepare-"));
  try {
    const parent = join(root, "2026-10-14", "12345678");
    const child = join(parent, "nested", "deeper");
    const outside = join(root, "outside");
    await mkdir(parent, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "marker"), "keep");
    const input = {
      conversationRoot: undefined,
      workspacePath: outside,
      workingDirectory: parent,
      sessionId: createSessionId("bare_subagent_fixture"),
      resumeFromStore: true,
      store: { getSession: async () => ({ directory: root, path: child }) },
    };
    await execution.prepareConversationSubagentSession(input);
    assert.ok((await stat(child)).isDirectory());
    await execution.prepareConversationSubagentSession({ ...input, workspacePath: child });
    await rm(join(parent, "nested"), { recursive: true });
    for (const scope of [
      { resumeFromStore: false },
      { workspaceIdentity: "remote:fixture" },
      { conversationRoot: outside },
      { store: { getSession: async () => null } },
      {
        store: {
          getSession: async () => ({ directory: root, path: child, workspaceID: "remote:fixture" }),
        },
      },
      { store: { getSession: async () => ({ directory: root, path: root }) } },
      {
        store: {
          getSession: async () => ({ directory: root, path: join(root, "project-nested") }),
        },
      },
      { store: { getSession: async () => ({ directory: root, path: join(root, "..", "other") }) } },
    ]) {
      await execution.prepareConversationSubagentSession({ ...input, ...scope });
      await assert.rejects(stat(child), { code: "ENOENT" });
    }
    await writeFile(join(parent, "nested"), "keep file");
    await assert.rejects(execution.prepareConversationSubagentSession(input), {
      name: "ConversationSessionWorkspaceUnavailableError",
    });
    assert.equal(await readFile(join(parent, "nested"), "utf8"), "keep file");
    await rm(join(parent, "nested"));
    await symlink(outside, join(parent, "nested"), "dir");
    await assert.rejects(execution.prepareConversationSubagentSession(input), {
      name: "ConversationSessionWorkspaceUnavailableError",
    });
    await assert.rejects(stat(join(outside, "deeper")), { code: "ENOENT" });
    assert.equal(await readFile(join(outside, "marker"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bare main and child resume leave ordinary project cwd missing or linked", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-project-resume-cwd-"));
  try {
    const projectCwd = join(root, "nested", "deeper");
    const outside = join(root, "outside");
    await mkdir(outside);
    const sessionId = createSessionId("project_child_fixture");
    const store = {
      getSession: async () => ({ directory: root, path: projectCwd }),
    };
    const prepareMain = () =>
      ensureConversationSessionDirForBareResume({
        sessionId,
        store: store as Parameters<typeof ensureConversationSessionDirForBareResume>[0]["store"],
      });
    const prepareChild = () =>
      execution.prepareConversationSubagentSession({
        conversationRoot: undefined,
        workspacePath: root,
        workingDirectory: root,
        sessionId,
        resumeFromStore: true,
        store,
      });
    await prepareMain();
    await prepareChild();
    await assert.rejects(stat(projectCwd), { code: "ENOENT" });
    await symlink(outside, join(root, "nested"), "dir");
    await prepareMain();
    await prepareChild();
    await assert.rejects(stat(join(outside, "deeper")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
