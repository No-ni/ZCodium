import { describe, expect, it } from "vitest";
import { ToolExecutionPerformanceSchema } from "../src/tools/performance.js";

describe("ToolExecutionPerformanceSchema", () => {
  it("命令 detail 接受真实退出码", () => {
    expect(
      ToolExecutionPerformanceSchema.parse({
        detail: {
          kind: "command",
          command: {
            exitCode: 2,
            name: "git",
            status: "failed",
          },
        },
        totalMs: 20,
      }),
    ).toMatchObject({
      detail: {
        kind: "command",
        command: {
          exitCode: 2,
        },
      },
    });
  });

  it("文件 detail 在类型和运行时 Schema 中都不接受退出码", () => {
    expect(() =>
      ToolExecutionPerformanceSchema.parse({
        detail: {
          kind: "filesystem",
          filesystem: {
            exitCode: 0,
            readMs: 10,
          },
        },
      }),
    ).toThrow();
  });

  it("顶层不再接受兼容 exitCode", () => {
    expect(() =>
      ToolExecutionPerformanceSchema.parse({
        exitCode: 0,
      }),
    ).toThrow();
  });
});
