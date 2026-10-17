import assert from "node:assert/strict";
import { it } from "node:test";
import { ContextBuilder } from "../src/context/builder.js";
import type { ContextBuilderConfig } from "../src/context/types.js";

const REMOVED_NOTICE_FRAGMENTS = [
  "IMPORTANT: Assist with authorized security testing",
  "Refuse requests for destructive techniques",
  "Dual-use security tools (C2 frameworks, credential testing, exploit development)",
] as const;
const OUTPUT_STYLE_PROMPT = "Explain the result in concise paragraphs.";
const WORKFLOW_PERSONA = "Review the implementation and report concrete findings.";

const BASE_CONFIG: ContextBuilderConfig = {
  workingDirectory: "/workspace/example",
  currentDate: "2026-10-18",
  envInfo: {
    cwd: "/workspace/example",
    platform: "win32",
    shell: "pwsh",
    osVersion: "Windows",
    nodeVersion: "24.14.0",
    isGitRepository: false,
  },
};

function buildSystemPrompt(overrides: Partial<ContextBuilderConfig> = {}): string {
  const result = new ContextBuilder({ ...BASE_CONFIG, ...overrides }).build();
  return result.systemMessages.map((message) => message.content).join("\n");
}

function assertNoBuiltinNotice(prompt: string): void {
  for (const fragment of REMOVED_NOTICE_FRAGMENTS) {
    assert.ok(!prompt.includes(fragment), `Unexpected built-in notice: ${fragment}`);
  }
  assert.ok(prompt.includes("# Harness"));
  assert.ok(prompt.includes("Tools run behind a user-selected permission mode"));
}

for (const presentationSurface of ["terminal", "zcode_desktop"] as const) {
  it(`${presentationSurface} default system messages omit the built-in notice`, () => {
    const prompt = buildSystemPrompt({ presentationSurface });
    assertNoBuiltinNotice(prompt);
    assert.ok(prompt.includes("You are an interactive ZCode agent"));
  });

  for (const keepCodingInstructions of [false, true]) {
    it(`${presentationSurface} output style omits the notice with keepCodingInstructions=${keepCodingInstructions}`, () => {
      const prompt = buildSystemPrompt({
        presentationSurface,
        outputStyle: { name: "Concise", prompt: OUTPUT_STYLE_PROMPT, keepCodingInstructions },
      });
      assertNoBuiltinNotice(prompt);
      assert.ok(prompt.includes(OUTPUT_STYLE_PROMPT));
    });
  }
}

for (const workflowActor of [{}, { name: "Reviewer", persona: WORKFLOW_PERSONA }]) {
  it(`${workflowActor.name ?? "anonymous"} workflow system messages omit the built-in notice`, () => {
    const prompt = buildSystemPrompt({ workflowActor });
    assertNoBuiltinNotice(prompt);
    assert.ok(prompt.includes("You are a subagent inside a dynamic workflow run"));
    assert.ok(prompt.includes("# Working inside a workflow"));
    if (workflowActor.name) assert.ok(prompt.includes(workflowActor.name));
    if (workflowActor.persona) assert.ok(prompt.includes(workflowActor.persona));
  });
}

it("preserves caller-provided custom system prompts without filtering their text", () => {
  const customSystemPrompt = `Caller instructions: ${REMOVED_NOTICE_FRAGMENTS[0]}.`;
  const prompt = buildSystemPrompt({ customSystemPrompt });
  assert.ok(prompt.includes(customSystemPrompt));
  assert.ok(!prompt.includes("You are an interactive ZCode agent"));
});

it("preserves caller-provided workflow personas without filtering their text", () => {
  const persona = `Reviewer instructions: ${REMOVED_NOTICE_FRAGMENTS[0]}.`;
  const prompt = buildSystemPrompt({ workflowActor: { persona } });
  assert.ok(prompt.includes(persona));
  assert.ok(prompt.includes("# Working inside a workflow"));
});
