import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { WorkspaceCheckpointArtifact } from "@zcode/contracts";
import { createNodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { restoreWorkspaceCheckpointArtifact } from "../src/runtime/methods/workspace-checkpoints.js";
import { emitFileMutationCheckpoint } from "../src/runtime/methods/tools.js";
import * as workspaceFork from "../src/runtime/methods/workspace-fork.js";
import { PermissionService } from "../src/permission/service.js";
import { ToolExecutorImpl } from "../src/tool/executor.js";
import { writeToolEntry } from "../src/tool/handlers/write.js";
import { ToolRegistryImpl } from "../src/tool/registry.js";

function checkpoint(
  root: string | undefined,
  path: string,
  beforeContent: string | null,
): WorkspaceCheckpointArtifact {
  return {
    ...(root ? { workspaceRoot: root } : {}),
    files: [
      { path, beforeContent, existedBefore: beforeContent !== null, afterContent: "changed" },
    ],
  } as WorkspaceCheckpointArtifact;
}

it("restores legacy checkpoints at the identity root and combines fork files by each recorded absolute target", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-checkpoint-cwd-"));
  try {
    const a = join(root, "2026-10-13", "aaaaaaaa");
    const b = join(root, "2026-10-13", "bbbbbbbb");
    for (const cwd of [root, a, b]) {
      await mkdir(join(cwd, "docs"), { recursive: true });
      await writeFile(join(cwd, "docs", "report.md"), "changed");
    }
    await writeFile(join(a, "new.txt"), "new");
    const runtime = {
      workspaceRoot: a,
      workspaceScopeRoot: root,
      fileSystemPort: createNodeFileSystemAdapter(),
    } as unknown as AgentRuntimeInternal;
    const trace = { traceId: "test", spanId: "test" };
    await restoreWorkspaceCheckpointArtifact.call(
      runtime,
      checkpoint(undefined, "docs/report.md", "legacy"),
      trace,
    );
    assert.equal(await readFile(join(root, "docs", "report.md"), "utf8"), "legacy");
    assert.equal(await readFile(join(a, "docs", "report.md"), "utf8"), "changed");
    await workspaceFork.restoreWorkspaceCheckpointArtifacts(
      runtime,
      [
        checkpoint(a, "docs/report.md", "first-a"),
        checkpoint(b, "docs/report.md", "first-b"),
        checkpoint(a, join(a, "docs", "report.md"), "later-a"),
        checkpoint(a, "new.txt", null),
      ],
      trace,
    );
    assert.equal(await readFile(join(a, "docs", "report.md"), "utf8"), "first-a");
    assert.equal(await readFile(join(b, "docs", "report.md"), "utf8"), "first-b");
    await assert.rejects(readFile(join(a, "new.txt")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("captures the Write cwd before runtime drift and restores only that checkpoint target", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-checkpoint-emitter-cwd-"));
  try {
    const nested = join(root, "nested");
    const artifacts: WorkspaceCheckpointArtifact[] = [];
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "a.txt"), "root-existing");
    let liveCwd = nested;
    const fileSystemPort = createNodeFileSystemAdapter();
    const toolFileSystemPort = Object.create(fileSystemPort) as typeof fileSystemPort;
    toolFileSystemPort.writeTextFile = async (...args) => {
      const written = await fileSystemPort.writeTextFile(...args);
      // 模拟其它工具在本次写入完成后改变 live cwd；checkpoint 必须保留 handler 捕获的根。
      liveCwd = root;
      return written;
    };
    const registry = new ToolRegistryImpl();
    registry.register(writeToolEntry);
    const executor = new ToolExecutorImpl({
      registry,
      permissionService: new PermissionService(),
      sessionId: "sess_checkpoint_cwd",
      mode: "yolo",
      getWorkingDirectory: () => liveCwd,
      workspaceRoot: root,
      fileSystemPort: toolFileSystemPort,
      emitEvent: async () => undefined,
    });
    const result = await executor.execute({
      id: "tool_checkpoint_cwd",
      name: "Write",
      input: { file_path: "a.txt", content: "nested-created" },
    });
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.workingDirectory, nested);
    assert.equal(liveCwd, root);
    const runtime = {
      sessionId: "sess_checkpoint_cwd",
      workspaceRoot: root,
      workingDirectory: root,
      currentTurnFileChanges: new Map(),
      fileSystemPort,
      artifactStore: {
        writeToolResultArtifact: async (input: { content: string }) => {
          artifacts.push(JSON.parse(input.content) as WorkspaceCheckpointArtifact);
          return { uri: "artifact://checkpoint-cwd" };
        },
      },
      createEvent: (type: string, payload: unknown) => ({ type, payload }),
      appendEvent: async () => undefined,
    } as unknown as AgentRuntimeInternal;

    await emitFileMutationCheckpoint.call(runtime, {
      events: [],
      messageId: "msg_checkpoint_cwd",
      result,
      traceContext: { traceId: "trace_checkpoint_cwd", spanId: "span_checkpoint_cwd" },
    });

    assert.equal(artifacts[0]?.workspaceRoot, nested);
    await restoreWorkspaceCheckpointArtifact.call(runtime, artifacts[0]!, {
      traceId: "trace_checkpoint_restore",
      spanId: "span_checkpoint_restore",
    });
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "root-existing");
    await assert.rejects(readFile(join(nested, "a.txt")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
