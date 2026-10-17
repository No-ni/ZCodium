import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const readAudit = vi.hoisted(() => ({
  paths: [] as string[],
  failures: new Set<string>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const instrumentedReadFile = new Proxy(actual.readFile, {
    apply(target, thisArg, args) {
      const path = String(args[0]);
      readAudit.paths.push(path);
      if (readAudit.failures.has(path)) {
        return Promise.reject(Object.assign(new Error("controlled read failure"), { code: "EIO" }));
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  return { ...actual, readFile: instrumentedReadFile };
});

let home: string;
let createSkillsService: typeof import("../../services/src/skills/skillsService.js").createSkillsService;
const createdWorkspaces: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspacePath = await mkdtemp(join(home, "workspace-"));
  createdWorkspaces.push(workspacePath);
  await mkdir(join(workspacePath, ".git"), { recursive: true });
  return workspacePath;
}

async function writeSkill(
  rootPath: string,
  directoryName: string,
  content: string,
): Promise<string> {
  const skillPath = join(rootPath, directoryName, "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, content, "utf8");
  return skillPath;
}

function readsOf(path: string): number {
  return readAudit.paths.filter((readPath) => readPath === path).length;
}

describe("skills service per-call user skill reads", () => {
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "zcodium-skills-service-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    ({ createSkillsService } = await import("../../services/src/skills/skillsService.js"));
  });

  beforeEach(async () => {
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    readAudit.paths.length = 0;
    readAudit.failures.clear();
    await Promise.all([
      rm(join(home, ".zcodium"), { recursive: true, force: true }),
      rm(join(home, ".agents"), { recursive: true, force: true }),
    ]);
  });

  afterEach(async () => {
    await Promise.all(
      createdWorkspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("reads each user ZCode skill once, keeps name priority, and ignores hidden content", async () => {
    const workspacePath = await createWorkspace();
    const userSkillsRoot = join(home, ".zcodium", "skills");
    const agentSkillsRoot = join(home, ".agents", "skills");
    const zcodeSkill = await writeSkill(
      userSkillsRoot,
      "zcode-shared",
      "---\nname: shared-name\n---\nZCode body\n",
    );
    const duplicateAgentSkill = await writeSkill(
      agentSkillsRoot,
      "agent-duplicate",
      "---\nname: shared-name\n---\nagent secret duplicate\n",
    );
    const uniqueAgentSkill = await writeSkill(
      agentSkillsRoot,
      "agent-unique",
      "---\nname: agent-unique\n---\nAgent body\n",
    );
    const fallbackSkill = await writeSkill(
      userSkillsRoot,
      "fallback-folder",
      "---\ndescription: [invalid\n---\nFallback body\n",
    );
    await writeSkill(
      agentSkillsRoot,
      ".private-hidden",
      "---\nname: hidden\n---\nsecret hidden body\n",
    );

    const result = await createSkillsService({ isDesktopRuntime: true }).list({ workspacePath });
    const skillsByName = new Map(result.skills.map((skill) => [skill.name, skill]));

    expect(readsOf(zcodeSkill)).toBe(1);
    expect(readsOf(fallbackSkill)).toBe(1);
    expect(readsOf(uniqueAgentSkill)).toBe(2);
    expect(readsOf(duplicateAgentSkill)).toBe(1);
    expect([...skillsByName.keys()]).toEqual(["agent-unique", "fallback-folder", "shared-name"]);
    expect(skillsByName.get("shared-name")?.body).toContain("ZCode body");
    expect(skillsByName.get("fallback-folder")?.body).toContain("Fallback body");
    expect(result.skills.some((skill) => skill.body.includes("secret"))).toBe(false);
  });

  it("re-reads changed content on the next call of the same service", async () => {
    const workspacePath = await createWorkspace();
    const skillPath = await writeSkill(
      join(home, ".zcodium", "skills"),
      "mutable-skill",
      "---\nname: mutable-skill\n---\nbefore update\n",
    );
    const service = createSkillsService({ isDesktopRuntime: true });

    const first = await service.list({ workspacePath });
    await writeFile(skillPath, "---\nname: mutable-skill\n---\nafter update\n", "utf8");
    const second = await service.list({ workspacePath });

    expect(first.skills[0]?.body).toContain("before update");
    expect(second.skills[0]?.body).toContain("after update");
    expect(readsOf(skillPath)).toBe(2);
  });

  it("keeps the skill read failure diagnostic and skips that summary", async () => {
    const workspacePath = await createWorkspace();
    const skillPath = await writeSkill(
      join(home, ".zcodium", "skills"),
      "unreadable-skill",
      "---\nname: unreadable-skill\n---\nprivate body\n",
    );
    readAudit.failures.add(skillPath);

    const result = await createSkillsService({ isDesktopRuntime: true }).list({ workspacePath });

    expect(readsOf(skillPath)).toBe(1);
    expect(result.skills.some((skill) => skill.path === skillPath)).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "skill_read_failed", path: skillPath }),
    );
    expect(JSON.stringify(result)).not.toContain("private body");
  });

  it("retains duplicate filtering when the user root is removed by nested-root filtering", async () => {
    const workspaceRoot = await createWorkspace();
    const nestedHome = join(workspaceRoot, ".zcodium", "skills");
    vi.stubEnv("HOME", nestedHome);
    vi.stubEnv("USERPROFILE", nestedHome);
    const removedUserRoot = join(nestedHome, ".zcodium", "skills");
    const agentSkillsRoot = join(nestedHome, ".agents", "skills");
    await writeSkill(removedUserRoot, "zcode-owner", "---\nname: shared-name\n---\nowner\n");
    await writeSkill(
      agentSkillsRoot,
      "agent-duplicate",
      "---\nname: shared-name\n---\nagent secret duplicate\n",
    );
    await writeSkill(
      join(removedUserRoot, "nested-workspace", ".zcodium", "skills"),
      "workspace-skill",
      "---\nname: workspace-skill\n---\nworkspace body\n",
    );
    const nestedWorkspace = join(removedUserRoot, "nested-workspace");
    await mkdir(join(nestedWorkspace, ".git"), { recursive: true });

    const result = await createSkillsService({ isDesktopRuntime: true }).list({
      workspacePath: nestedWorkspace,
    });

    expect(readsOf(join(removedUserRoot, "zcode-owner", "SKILL.md"))).toBe(1);
    expect(result.skills.map((skill) => skill.name)).toEqual(["workspace-skill"]);
    expect(result.skills.some((skill) => skill.body.includes("agent secret"))).toBe(false);
  });

  it.each([
    ["no frontmatter", "Shared body", "user-alias"],
    ["empty name", "---\nname: ''\n---\nShared body", "user-alias"],
    ["declared name", "---\nname: declared-name\n---\nShared body", "declared-name"],
  ])("preserves alias-specific fallback with %s", async (_label, content, coveredName) => {
    const workspacePath = await createWorkspace();
    const original = await writeSkill(
      join(workspacePath, ".zcodium", "skills"),
      "workspace-name",
      content,
    );
    const userRoot = join(home, ".zcodium", "skills");
    await mkdir(userRoot, { recursive: true });
    await symlink(dirname(original), join(userRoot, "user-alias"), "junction");
    const agentsRoot = join(home, ".agents", "skills");
    await writeSkill(
      agentsRoot,
      "covered-agent",
      `---\nname: ${coveredName}\n---\ncovered Agents body`,
    );
    await writeSkill(
      agentsRoot,
      "workspace-name-agent",
      "---\nname: workspace-name\n---\nindependent Agents body",
    );

    const result = await createSkillsService({ isDesktopRuntime: true }).list({ workspacePath });
    expect(result.skills.some((skill) => skill.body.includes("covered Agents body"))).toBe(false);
    expect(result.skills.some((skill) => skill.body.includes("independent Agents body"))).toBe(
      true,
    );
    expect(readsOf(original)).toBe(1);
    expect(readsOf(join(userRoot, "user-alias", "SKILL.md"))).toBe(0);
  });
});
