import { describe, expect, it } from "vitest";
import { getCurrentModelInvocationContext } from "@zcode/contracts";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runRegression } from "#public";
import { renderReport } from "#regression/report";
import { readModelRequestBody } from "#regression/usage";
import { fixture, chatResponse, secret, architectureAnswer } from "#test/fixture";

describe("provider regression", () => {
  it("只解析模型请求，字节体与 Request 观测不消费原请求", async () => {
    const body = { model: "model-a", messages: [], max_tokens: 8192 };
    const json = JSON.stringify(body);
    const bytes = new TextEncoder().encode(json);
    const url = "https://provider.example.com/v1/messages";
    for (const input of [json, bytes, bytes.buffer]) {
      expect(await readModelRequestBody(url, { method: "POST", body: input })).toEqual(body);
    }
    const request = new Request(url, { method: "POST", body: json });
    expect(await readModelRequestBody(request)).toEqual(body);
    expect(await request.json()).toEqual(body);
    expect(
      await readModelRequestBody(url, { method: "POST", body: JSON.stringify({ apiKey: secret }) }),
    ).toBeUndefined();
    expect(await readModelRequestBody(url, { method: "GET" })).toBeUndefined();
    expect(
      await readModelRequestBody(url, {
        method: "POST",
        body: JSON.stringify({ model: "model-a" }),
      }),
    ).toBeUndefined();
    expect(
      await readModelRequestBody(url, {
        method: "POST",
        body: JSON.stringify({ model: "model-a", input: [] }),
      }),
    ).toEqual({ model: "model-a", input: [] });
  });

  it("省略 repetitions 时每个档位只运行一次", async () => {
    const f = await fixture();
    try {
      const { repetitions: _repetitions, ...list } = f.list;
      await writeFile(f.options.listFile, JSON.stringify(list));
      let calls = 0;
      const report = await runRegression({
        ...f.options,
        transport: async () => {
          calls++;
          return chatResponse();
        },
      });
      expect(calls).toBe(2);
      expect(report.rows.map((row) => [row.reasoningLevel, row.repetition])).toEqual([
        ["low", 1],
        ["high", 1],
      ]);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("并行实例有独立调用上下文，不向供应商追加会话归因头", async () => {
    const f = await fixture();
    const sessions: unknown[] = [];
    try {
      const providers = JSON.parse(await readFile(f.options.providersFile, "utf8"));
      providers.providerRules[0].config.api = {
        type: "openai-chat-completions",
        baseUrl: "https://opencode.ai/zen/go/v1",
      };
      await writeFile(f.options.providersFile, JSON.stringify(providers));
      await writeFile(
        f.options.listFile,
        JSON.stringify({ ...f.list, repetitions: 1, concurrency: { cases: 2 } }),
      );
      const report = await runRegression({
        ...f.options,
        transport: async (_url, init) => {
          const headers = new Headers(init?.headers);
          const session = getCurrentModelInvocationContext()?.metadata?.sessionId;
          sessions.push(session);
          expect(session).toBeTruthy();
          expect(headers.get("x-session-id")).toBeNull();
          expect(headers.get("x-opencode-session")).toBeNull();
          return chatResponse();
        },
      });
      expect(report.rows.every((row) => row.status === "passed")).toBe(true);
      expect(sessions).toHaveLength(2);
      expect(new Set(sessions).size).toBe(2);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("同题逐档重复，真实 Adapter 参数、缺失 usage 与中位数不混淆", async () => {
    const f = await fixture();
    const bodies: Record<string, unknown>[] = [];
    try {
      const transport: typeof fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return chatResponse(bodies.length === 1 ? 0 : undefined);
      };
      const report = await runRegression({ ...f.options, transport });
      expect(report.rows).toHaveLength(6);
      expect(
        report.rows.every((r) => r.status === "passed" && r.parameterCheck === "matched"),
      ).toBe(true);
      expect(new Set(bodies.map((b) => JSON.stringify(b.messages))).size).toBe(1);
      expect(bodies.map((b) => b.reasoning_effort)).toEqual([
        "low",
        "high",
        "low",
        "high",
        "low",
        "high",
      ]);
      expect(report.rows[0].reasoningTokens).toBe(0);
      expect(report.rows[1].reasoningTokens).toBeNull();
      expect(report.rows[0].reasoningCharacters).toBe(3);
      const saved = await readFile(join(f.dir, "report", report.runId!, "report.json"), "utf8");
      expect(saved).not.toContain(secret);
      expect(saved).not.toContain("思考😀");
      expect(renderReport(report)).toContain("中位数");
      expect(report.reasoningTask.id).toBe("task-platform-v1");
      expect(report.reasoningTask.prompt).toContain("跨地域");
      expect(report.reasoningTask.maxOutputTokens).toBe(1024);
      expect(report.rows[0].answer).toBe(architectureAnswer);
      expect(report.rows[0].detail).toContain("设计质量待人工评审");
      expect(renderReport(report)).toContain(
        architectureAnswer
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      );
      expect(JSON.stringify(bodies[0].messages)).toContain("外部接口");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("架构题只验证传输完成与非空回答，不评判内容或标题", async () => {
    const f = await fixture();
    try {
      for (const answer of ["80", architectureAnswer.replace("## 4. 故障推演", "缺失章节"), ""]) {
        const report = await runRegression({
          ...f.options,
          transport: async () =>
            new Response(
              (await chatResponse().text()).replace(
                JSON.stringify(architectureAnswer),
                JSON.stringify(answer),
              ),
              {
                headers: { "content-type": "text/event-stream" },
              },
            ),
        });
        expect(report.rows.every((r) => r.status === (answer ? "passed" : "failed"))).toBe(true);
      }
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it.each(["17 × 19 = 323", "已完成回答", ""])(
    "文本使用产品流式会话，不评判最终文风：%s",
    async (answer) => {
      // 真正的会话会播种本地资产；原 2s 预算在进入模型前耗尽。
      const f = await fixture("openai-chat-completions", 10000);
      try {
        await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["TEXT-001"] }));
        const report = await runRegression({
          ...f.options,
          transport: async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            if (body.stream)
              return new Response(
                (await chatResponse().text()).replace(
                  JSON.stringify(architectureAnswer),
                  JSON.stringify(answer),
                ),
                { headers: { "content-type": "text/event-stream" } },
              );
            return new Response(
              JSON.stringify({
                id: "text",
                object: "chat.completion",
                created: 1,
                model: "model-a",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: answer },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }),
              { headers: { "content-type": "application/json" } },
            );
          },
        });
        expect(report.rows[0].status).toBe(answer ? "passed" : "failed");
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    },
  );
  it.each(["当前口令是 blue-42。", "BLUE-420"])(
    "输入标记允许解释但不接受不同标记：%s",
    async (answer) => {
      // 真正的会话会播种本地资产；原 2s 预算在进入模型前耗尽。
      const f = await fixture("openai-chat-completions", 10000);
      try {
        await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["SYSTEM-001"] }));
        const report = await runRegression({
          ...f.options,
          transport: async () =>
            new Response(
              (await chatResponse().text()).replace(
                JSON.stringify(architectureAnswer),
                JSON.stringify(answer),
              ),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        expect(report.rows[0].status).toBe(answer === "BLUE-420" ? "review" : "passed");
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    },
  );
  it("失败继续下一项且报告移除错误回显的 Key", async () => {
    const f = await fixture();
    let calls = 0;
    try {
      const report = await runRegression({
        ...f.options,
        transport: async () => {
          if (++calls === 1) throw new Error(secret);
          return chatResponse();
        },
      });
      expect(calls).toBe(6);
      expect(report.rows[0].status).toBe("failed");
      expect(report.rows[1].status).toBe("passed");
      expect(JSON.stringify(report)).not.toContain(secret);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("预览不调用网络，不适用与缺 Key 保留为不同状态", async () => {
    const f = await fixture();
    try {
      await writeFile(
        f.options.listFile,
        JSON.stringify({ ...f.list, caseIds: ["IMAGE-001", "REASON-001"] }),
      );
      const cfg = JSON.parse(await readFile(f.options.providersFile, "utf8"));
      cfg.providerRules[0].config.access.apiKey = "";
      await writeFile(f.options.providersFile, JSON.stringify(cfg));
      const r = await runRegression({
        ...f.options,
        dryRun: true,
        transport: async () => {
          throw new Error("must not call");
        },
      });
      expect(r.rows.find((x) => x.caseId === "IMAGE-001")?.status).toBe("skipped");
      expect(
        r.rows.filter((x) => x.caseId === "REASON-001").every((x) => x.status === "untested"),
      ).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("未知用例和不存在的模型在发请求前报错", async () => {
    const f = await fixture();
    try {
      await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["WRONG"] }));
      await expect(runRegression(f.options)).rejects.toThrow();
      await writeFile(
        f.options.listFile,
        JSON.stringify({ ...f.list, targets: [{ providerId: "test-a", modelIds: ["wrong"] }] }),
      );
      await expect(runRegression(f.options)).rejects.toThrow();
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it.each(["stop", "length", "error"])("输出预算只检查传参和合法结束：%s", async (finish) => {
    const f = await fixture();
    try {
      await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["OUTPUT-001"] }));
      const report = await runRegression({
        ...f.options,
        transport: async () => chatResponse(0, finish),
      });
      expect(report.rows[0].status).toBe(finish === "error" ? "failed" : "passed");
      if (finish === "stop") expect(report.rows[0].detail).toContain("未观察到截断");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("截断不算成功", async () => {
    const f = await fixture();
    try {
      const r = await runRegression({
        ...f.options,
        transport: async () => chatResponse(20, "length"),
      });
      expect(r.rows.every((x) => x.status === "failed")).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
});
