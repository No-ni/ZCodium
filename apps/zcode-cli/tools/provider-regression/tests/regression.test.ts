import { describe, expect, it } from "vitest";
import { getCurrentModelInvocationContext } from "@zcode/contracts";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runRegression } from "#public";
import { fixture, chatResponse, architectureAnswer } from "#test/fixture";

describe("provider regression", () => {
  it("新档位自动展开，媒体用例按 property 选择", async () => {
    const f = await fixture();
    try {
      const path = join(f.dir, "builtin.json");
      const data = JSON.parse(await readFile(path, "utf8"));
      data.config.modelConfigRules.modelRules[0].config.optionSpecs.reasoningLevel.values.push(
        "max",
      );
      await writeFile(path, JSON.stringify(data));
      await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["*"] }));
      const r = await runRegression({ ...f.options, dryRun: true });
      expect(r.rows.filter((x) => x.caseId === "REASON-001")).toHaveLength(9);
      expect(r.rows.find((x) => x.caseId === "IMAGE-001")?.status).toBe("skipped");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it.each(["323", "17 × 19 = 323", "两项工具结果已收到", ""])(
    "工具闭环验证传输，不评判最终文风：%s",
    async (answer) => {
      // 预算包含真实插件资产准备，不绕过产品会话初始化。
      const f = await fixture("openai-chat-completions", 10000);
      const bodies: any[] = [];
      const sessions: unknown[] = [];
      try {
        await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["TOOL-001"] }));
        const r = await runRegression({
          ...f.options,
          transport: async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            bodies.push(body);
            sessions.push(getCurrentModelInvocationContext()?.metadata?.sessionId);
            expect(new Headers(init?.headers).get("x-session-id")).toBeNull();
            const count = bodies.length;
            const message =
              count < 3
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `call-${count}`,
                        type: "function",
                        function: {
                          name: "lookup_regression_value",
                          arguments: JSON.stringify({
                            query: { id: count === 1 ? "left" : "right" },
                          }),
                        },
                      },
                    ],
                  }
                : { role: "assistant", content: answer };
            expect(body.stream).toBe(true);
            const delta = {
              ...message,
              ...(message.tool_calls
                ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) }
                : {}),
            };
            return new Response(
              [
                { choices: [{ index: 0, delta, finish_reason: null }] },
                {
                  choices: [
                    { index: 0, delta: {}, finish_reason: count < 3 ? "tool_calls" : "stop" },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 20 },
                },
              ]
                .map(
                  (payload) =>
                    `data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: "model-a", ...payload })}\n\n`,
                )
                .join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        });
        expect(r.rows[0].status, r.rows[0].detail).toBe(answer ? "passed" : "failed");
        if (answer) expect(bodies).toHaveLength(3);
        else expect(bodies.length).toBeGreaterThanOrEqual(3);
        expect(sessions.every(Boolean)).toBe(true);
        expect(new Set(sessions).size).toBe(1);
        expect(
          bodies[2].messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id),
        ).toEqual(["call-1", "call-2"]);
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    },
  );
  it("超时传入实际请求，后续用例仍有结果", async () => {
    const f = await fixture();
    try {
      await writeFile(
        f.options.listFile,
        JSON.stringify({ ...f.list, timeoutMs: 100, repetitions: 1 }),
      );
      const r = await runRegression({
        ...f.options,
        transport: async (_url, init) =>
          new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) reject(new Error("aborted"));
            else
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
          }),
      });
      expect(r.rows).toHaveLength(2);
      expect(r.rows.every((x) => x.status === "failed" && x.detail.includes("超时"))).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("取消后停止发新请求，并保留未测项目", async () => {
    const f = await fixture();
    const abort = new AbortController();
    let calls = 0;
    try {
      const r = await runRegression({
        ...f.options,
        signal: abort.signal,
        transport: async () => {
          calls++;
          abort.abort();
          throw new Error("aborted");
        },
      });
      expect(calls).toBe(1);
      expect(r.rows.slice(1).every((x) => x.status === "untested")).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("Messages 路径保留可见思考长度，原始 usage 缺失不补零", async () => {
    const f = await fixture("anthropic-messages");
    try {
      await writeFile(f.options.listFile, JSON.stringify({ ...f.list, repetitions: 1 }));
      const r = await runRegression({
        ...f.options,
        transport: async () => {
          const events = [
            {
              type: "message_start",
              message: {
                id: "m1",
                type: "message",
                role: "assistant",
                model: "model-a",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "", signature: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "thinking" },
            },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text: architectureAnswer },
            },
            { type: "content_block_stop", index: 1 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 20 },
            },
            { type: "message_stop" },
          ];
          return new Response(
            events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      expect(
        r.rows.every(
          (x) => x.status === "passed" && x.reasoningTokens === null && x.reasoningCharacters === 8,
        ),
      ).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("Responses 路径读取原始思考 usage，不把文本长度当 token", async () => {
    const f = await fixture("openai-responses");
    try {
      await writeFile(f.options.listFile, JSON.stringify({ ...f.list, repetitions: 1 }));
      const r = await runRegression({
        ...f.options,
        transport: async () => {
          const events = [
            { type: "response.created", response: { id: "r1", created_at: 1, model: "model-a" } },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id: "m1" },
            },
            { type: "response.output_text.delta", item_id: "m1", delta: architectureAnswer },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: { type: "message", id: "m1" },
            },
            {
              type: "response.completed",
              response: {
                usage: {
                  input_tokens: 10,
                  output_tokens: 25,
                  output_tokens_details: { reasoning_tokens: 20 },
                },
              },
            },
          ];
          return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      expect(
        r.rows.every(
          (x) =>
            x.status === "passed" && x.reasoningTokens === 20 && x.reasoningCharacters === null,
        ),
      ).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("单个档位 Map 求值失败不会中断整轮", async () => {
    const f = await fixture();
    try {
      const path = join(f.dir, "builtin.json");
      const release = JSON.parse(await readFile(path, "utf8"));
      release.config.modelConfigRules.modelRules[0].config.optionSpecs.reasoningLevel.map =
        'reasoningLevel == "low" ? {"reasoning_effort": "low"} : {"invalid": 1 / 0}';
      await writeFile(path, JSON.stringify(release));
      const r = await runRegression({ ...f.options, transport: async () => chatResponse() });
      expect(r.rows).toHaveLength(6);
      expect(
        r.rows.filter((x) => x.reasoningLevel === "low").every((x) => x.status === "passed"),
      ).toBe(true);
      expect(
        r.rows.filter((x) => x.reasoningLevel === "high").every((x) => x.status === "failed"),
      ).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("响应回显包含 JSON 转义字符的 Key 也必须脱敏", async () => {
    const f = await fixture();
    const key = 'private-"-key';
    try {
      const cfg = JSON.parse(await readFile(f.options.providersFile, "utf8"));
      cfg.providerRules[0].config.access.apiKey = key;
      await writeFile(f.options.providersFile, JSON.stringify(cfg));
      const r = await runRegression({
        ...f.options,
        transport: async () =>
          new Response(
            (await chatResponse().text()).replace(
              JSON.stringify(architectureAnswer),
              JSON.stringify(key),
            ),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
      });
      expect(r.rows.every((x) => !x.answer.includes(key))).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
});
