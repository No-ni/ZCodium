import assert from "node:assert/strict";
import { it } from "node:test";
import type { Model, ModelRequest, WebFetchInput } from "@zcode/contracts";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { processFetchedContent } from "../src/tool/handlers/webfetch-processing.js";
import type { CachedFetchContent } from "../src/tool/handlers/webfetch-types.js";

const FIXTURE_URL = "https://example.test/guide";
const MODEL_RESULT = "The guide describes the setup process.";
const REMOVED_POLICY_LINES = [
  "Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.",
  "Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.",
  "You are not a lawyer and never comment on the legality of your own prompts and responses.",
  "Never produce or reproduce exact song lyrics.",
] as const;

function createModelHarness(): { model: Model; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const implementation: Pick<Model, "optionSpecs" | "generateText"> = {
    optionSpecs: {
      reasoningLevel: { values: ["low"], map: "low=low" },
      maxOutputTokens: { max: 4096, map: "maxOutputTokens=maxOutputTokens" },
    },
    async generateText(request) {
      requests.push(request);
      return { text: MODEL_RESULT, finishReason: "stop", usage: {} };
    },
  };

  return { model: implementation as Model, requests };
}

function createContext(model: Model): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    model,
    sessionId: "session-test" as ToolExecutionContext["sessionId"],
    toolCallId: "tool-call-test" as ToolExecutionContext["toolCallId"],
    traceId: "trace-test" as ToolExecutionContext["traceId"],
    workingDirectory: "C:\\workspace\\example",
    workspaceRoot: "C:\\workspace\\example",
    workspaceScopeRoot: "C:\\workspace\\example",
  } as ToolExecutionContext;
}

function createFetchedContent(content: string, contentType = "text/html"): CachedFetchContent {
  const sizeBytes = Buffer.byteLength(content);
  return {
    bytes: sizeBytes,
    content,
    contentType,
    finalUrl: FIXTURE_URL,
    redirects: [],
    sizeBytes,
    status: 200,
    statusText: "OK",
  };
}

function capturedPrompt(request: ModelRequest): string {
  assert.equal(request.messages.length, 1);
  const message = request.messages[0];
  assert.ok(message);
  assert.equal(message.role, "user");
  if (typeof message.content !== "string") {
    throw new TypeError("Expected WebFetch processing prompt to be text");
  }
  return message.content;
}

function assertNoRemovedPolicies(prompt: string): void {
  for (const policyLine of REMOVED_POLICY_LINES) {
    assert.ok(!prompt.includes(policyLine), `Unexpected WebFetch policy: ${policyLine}`);
  }
}

const htmlCases = [
  { label: "ordinary", preapprovedUrl: false },
  { label: "preapproved", preapprovedUrl: true },
] as const;

for (const { label, preapprovedUrl } of htmlCases) {
  it(`${label} HTML extraction sends page context without fixed content policies`, async () => {
    const { model, requests } = createModelHarness();
    const pageContent =
      "<html><body><h1>Guide</h1><p>Install the sample package.</p></body></html>";
    const input: WebFetchInput = {
      url: FIXTURE_URL,
      prompt: "Summarize the setup instructions.",
    };

    const result = await processFetchedContent(
      input,
      createFetchedContent(pageContent),
      createContext(model),
      { preapprovedUrl },
    );

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request);
    assert.deepEqual(request.tools, []);
    const prompt = capturedPrompt(request);
    assertNoRemovedPolicies(prompt);
    const expectedInstruction = preapprovedUrl
      ? "Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed."
      : "Provide a concise response based only on the content above.";
    assert.ok(prompt.includes(expectedInstruction));
    assert.ok(prompt.includes(pageContent));
    assert.ok(prompt.includes(input.prompt));
    assert.equal(result.result, MODEL_RESULT);
    assert.equal(result.truncated, false);
  });
}

it("returns preapproved short Markdown directly without invoking the model", async () => {
  const { model, requests } = createModelHarness();
  const markdown = "# Guide\n\nInstall the sample package.";

  const result = await processFetchedContent(
    { url: FIXTURE_URL, prompt: "Summarize this guide." },
    createFetchedContent(markdown, "text/markdown"),
    createContext(model),
    { preapprovedUrl: true },
  );

  assert.equal(requests.length, 0);
  assert.deepEqual(result, { result: markdown, truncated: false });
});

it("processes ordinary Markdown through the model without fixed content policies", async () => {
  const { model, requests } = createModelHarness();
  const markdown = "# Guide\n\nInstall the sample package.";
  const userPrompt = "Summarize this guide.";

  const result = await processFetchedContent(
    { url: FIXTURE_URL, prompt: userPrompt },
    createFetchedContent(markdown, "text/markdown"),
    createContext(model),
  );

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  const prompt = capturedPrompt(request);
  assertNoRemovedPolicies(prompt);
  assert.ok(prompt.includes(markdown));
  assert.ok(prompt.includes(userPrompt));
  assert.equal(result.result, MODEL_RESULT);
  assert.equal(result.truncated, false);
});

it("preserves former policy text when it appears in the page or user prompt", async () => {
  const { model, requests } = createModelHarness();
  const pageContent = `Page notice one: ${REMOVED_POLICY_LINES[0]}\nPage notice two: ${REMOVED_POLICY_LINES[1]}`;
  const userPrompt = `Explain these quoted notices: ${REMOVED_POLICY_LINES[2]} ${REMOVED_POLICY_LINES[3]}`;

  await processFetchedContent(
    { url: FIXTURE_URL, prompt: userPrompt },
    createFetchedContent(pageContent),
    createContext(model),
  );

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  const prompt = capturedPrompt(request);
  assert.ok(prompt.includes(pageContent));
  assert.ok(prompt.includes(userPrompt));
});
