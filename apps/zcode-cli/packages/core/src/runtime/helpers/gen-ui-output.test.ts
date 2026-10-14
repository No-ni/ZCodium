import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGenUiService } from "../../../../../../../packages/services/src/gen-ui/node.js";
import { buildDesktopContextSection } from "../../context/sections/desktop.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { ensureGenUiOutputDirectory, resolveGenUiOutputDirectory } from "./gen-ui-output.js";

describe("Host-owned Gen UI output", () => {
  it("keeps actors with an external inherited cwd executable and authorizes only global output", async () => {
    const root = await mkdtemp(join(tmpdir(), "gen-ui-external-actor-"));
    const workspacePath = join(root, "conversation");
    const executionWorkspacePath = join(root, "external");
    const outputRoot = join(root, "user-data", "visualizations");
    const runtime = {
      config: {
        genUiOutputRoot: outputRoot,
        presentationSurface: "zcode_desktop",
        workspacePath,
        conversationWorkspaceRoot: workspacePath,
      },
      workspaceScopeRoot: workspacePath,
      workspaceRoot: executionWorkspacePath,
      sessionId: "actor",
      rootTraceContext: { traceId: "trace" },
      fileSystemPort: {
        createDirectory: ({ path }: { path: string }) => mkdir(path, { recursive: true }),
      },
    } as unknown as AgentRuntimeInternal;
    const service = createGenUiService({
      outputRoot,
      stateRoot: join(root, "state"),
      conversationOutput: {
        conversationWorkspaceRoot: workspacePath,
        resolveSessionWorkspacePath: async () => executionWorkspacePath,
      },
    });
    try {
      await mkdir(workspacePath);
      await mkdir(executionWorkspacePath);
      await ensureGenUiOutputDirectory(runtime);
      const directory = resolveGenUiOutputDirectory(runtime)!;
      expect(directory.startsWith(`${outputRoot}/`)).toBe(true);
      const path = join(directory, "chart.html");
      await writeFile(path, "<div>Actor</div>");
      expect(
        (await service.readDocument({ workspacePath, sessionId: "actor", path })).html,
      ).toContain("Actor");
      const externalFile = join(executionWorkspacePath, "chart.html");
      await writeFile(externalFile, "<div>Unauthorized</div>");
      await expect(
        service.readDocument({ workspacePath, sessionId: "actor", path: externalFile }),
      ).rejects.toThrow("session output");
      expect(await readdir(executionWorkspacePath)).toEqual(["chart.html"]);
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps conversation visualizations inside the initial session cwd and renders through the Host", async () => {
    const root = await mkdtemp(join(tmpdir(), "gen-ui-conversation-"));
    const workspacePath = join(root, "workspace", "default");
    const executionWorkspacePath = join(workspacePath, "2026-10-13", "a1b2c3d4");
    const outputRoot = join(root, "user-data", "visualizations");
    const runtime = {
      config: {
        genUiOutputRoot: outputRoot,
        presentationSurface: "zcode_desktop",
        workspacePath,
        conversationWorkspaceRoot: workspacePath,
      },
      workspaceScopeRoot: workspacePath,
      workspaceRoot: executionWorkspacePath,
      workingDirectory: executionWorkspacePath,
      sessionId: "session",
      rootTraceContext: { traceId: "trace" },
      fileSystemPort: {
        createDirectory: ({ path }: { path: string }) => mkdir(path, { recursive: true }),
      },
    } as unknown as AgentRuntimeInternal;
    const service = createGenUiService({
      outputRoot,
      stateRoot: join(root, "state"),
      conversationOutput: {
        conversationWorkspaceRoot: workspacePath,
        resolveSessionWorkspacePath: async () => executionWorkspacePath,
      },
    });
    try {
      await ensureGenUiOutputDirectory(runtime);
      const directory = resolveGenUiOutputDirectory(runtime)!;
      expect(directory).toBe(join(executionWorkspacePath, "visualizations"));
      expect(buildDesktopContextSection(directory).content).toContain(JSON.stringify(directory));
      const path = join(directory, "pelican-bicycle.html");
      await writeFile(path, "<div>Pelican</div>");
      expect(
        (await service.readDocument({ workspacePath, sessionId: "session", path })).html,
      ).toContain("Pelican");
      runtime.workingDirectory = join(executionWorkspacePath, "nested");
      expect(resolveGenUiOutputDirectory(runtime)).toBe(directory);
      runtime.sessionId = "fork" as typeof runtime.sessionId;
      expect(resolveGenUiOutputDirectory(runtime)).toBe(directory);
      runtime.workspaceRoot = join(workspacePath, "2026-10-13", "abcd1234");
      expect(resolveGenUiOutputDirectory(runtime)).not.toBe(directory);
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([undefined, "ssh:executor:/workspace"])(
    "uses the same directory for runtime context and executor reads (%s)",
    async (workspaceIdentity) => {
      const root = await mkdtemp(join(tmpdir(), "gen-ui-context-"));
      const workspacePath = join(root, "repository");
      const outputRoot = join(root, "user-data", "visualizations");
      const service = createGenUiService({ outputRoot, stateRoot: join(root, "state") });
      await mkdir(workspacePath);
      const runtime = {
        config: {
          genUiOutputRoot: outputRoot,
          presentationSurface: "zcode_desktop",
          workspacePath,
          workspaceIdentity,
        },
        workspaceRoot: workspacePath,
        sessionId: "session",
        rootTraceContext: { traceId: "trace" },
        fileSystemPort: {
          createDirectory: ({ path }: { path: string }) => mkdir(path, { recursive: true }),
        },
      } as unknown as AgentRuntimeInternal;
      try {
        await ensureGenUiOutputDirectory(runtime);
        const directory = resolveGenUiOutputDirectory(runtime)!;
        expect(buildDesktopContextSection(directory).content).toContain(JSON.stringify(directory));
        const path = join(directory, "chart.html");
        await writeFile(path, "<div>Outside Git</div>");
        expect(
          (
            await service.readDocument({
              workspacePath,
              workspaceIdentity,
              sessionId: "session",
              path,
            })
          ).html,
        ).toBe("<div>Outside Git</div>");
        expect(await readdir(workspacePath)).toEqual([]);
        expect(resolveGenUiOutputDirectory(runtime)).toBe(directory);
        runtime.sessionId = "other" as typeof runtime.sessionId;
        expect(resolveGenUiOutputDirectory(runtime)).not.toBe(directory);
      } finally {
        service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("does not advertise a directory without a host root, and propagates creation failure", async () => {
    const runtime = { config: { presentationSurface: "zcode_desktop" } } as AgentRuntimeInternal;
    expect(resolveGenUiOutputDirectory(runtime)).toBeUndefined();
    expect(buildDesktopContextSection().content).not.toContain("host supports Gen UI");
    runtime.config.genUiOutputRoot = join(tmpdir(), "gen-ui-output");
    runtime.workspaceRoot = join(tmpdir(), "project");
    runtime.sessionId = "session" as typeof runtime.sessionId;
    runtime.fileSystemPort = {
      createDirectory: async () => {
        throw new Error("read-only volume");
      },
    } as unknown as AgentRuntimeInternal["fileSystemPort"];
    await expect(ensureGenUiOutputDirectory(runtime)).rejects.toThrow("read-only volume");
  });
});
