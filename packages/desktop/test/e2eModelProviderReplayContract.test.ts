import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 官方账号控制面已随 docs/specs/official-3.17.1-integration.md 的审计边界退休：
// coding-plan-mock-env 的 shouldPrepareCodingPlanTeamMock 及其官方账户 spec matcher
// 用例整体删除，本文件只保留普通 Provider 的重启 transport 与非流式标题 fixture 契约。
interface ReplayFixtureFile {
  fixtures: Array<{
    id: string;
    match: { pathIncludes?: string };
    response: { body?: string; text?: unknown; headers?: Record<string, string> };
  }>;
}

function readReplayFixture(relativePath: string): ReplayFixtureFile {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as ReplayFixtureFile;
}

describe("model provider E2E replay contract", () => {
  it("covers both seeded OpenAI and startup Anthropic transports for restart cases", () => {
    const restart = readReplayFixture(
      "./e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-restart-recovery.json",
    );
    const baseFixtureIds = ["model-provider-restart-title", "model-provider-restart-r01"];

    for (const id of baseFixtureIds) {
      const openai = restart.fixtures.find((fixture) => fixture.id === id);
      const anthropic = restart.fixtures.find((fixture) => fixture.id === `${id}-anthropic`);
      expect(openai?.match.pathIncludes).toBe("/chat/completions");
      expect(openai?.response.body).toBeDefined();
      expect(anthropic?.match.pathIncludes).toBe("/messages");
      if (id.endsWith("title")) expect(anthropic?.response.body).toBeDefined();
      else expect(anthropic?.response.text).toBeDefined();
    }
  });
});

it.each([
  "conversation-session-pasted-image-path-projection",
  "conversation-session-model-provider-restart-recovery",
  "conversation-session-background-bash-output",
  "conversation-session-model-provider-turbo-recovery",
  "conversation-session-bash-direct-output",
  "conversation-session-model-provider-settings-transition",
])("%s 的非流式标题请求返回可解析 JSON", (name) => {
  const file = readReplayFixture(`./e2e/fixtures/upstream/conversation-session/${name}.json`);
  const titles = file.fixtures.filter((item) => item.id.includes("title"));
  // 标题在首发后独立请求，缺少 fixture 时主流程断言仍可能通过。
  expect(titles.length).toBeGreaterThan(0);
  for (const fixture of titles) {
    expect(fixture.response.headers?.["content-type"]).toContain("application/json");
    const body = JSON.parse(fixture.response.body!);
    const text =
      fixture.match.pathIncludes === "/messages"
        ? body.content[0].text
        : body.choices[0].message.content;
    expect(JSON.parse(text).title).toBeTruthy();
  }
});
