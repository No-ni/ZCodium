import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { testRender } from "@mbears/opentui-react/test-utils";
import { getTreeSitterClient } from "@mbears/opentui-core";
import {
  createTurnId,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
} from "@zcode/contracts";
import type { TuiOptions, TuiSubmitPrompt } from "../src/types.js";
type TuiSubmitPromptOptions = Parameters<TuiSubmitPrompt>[1];
import { TuiApp } from "../src/app.js";

const cache = await mkdtemp(join(tmpdir(), "zcodium-tui-quit-"));
const previousCache = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = cache;
after(async () => {
  await getTreeSitterClient().destroy();
  if (previousCache === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousCache;
  await rm(cache, { recursive: true, force: true });
});

async function mount(overrides: Partial<TuiOptions> = {}) {
  const exits: number[] = [];
  const submitted: unknown[] = [];
  const sent: unknown[] = [];
  const ui = await testRender(
    createElement(TuiApp, {
      copySelection: async () => ({ kind: "empty" as const }),
      hasCopyableSelection: () => false,
      onExit: (code: number) => exits.push(code),
      options: {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        version: "fixture",
        noColor: true,
        submitPrompt: async (input) => {
          submitted.push(input);
          return { response: "" };
        },
        sendInput: async (input) => {
          sent.push(input);
          return {
            kind: "queued",
            pendingInputId: "fixture-queued",
            queueLength: 1,
            turnId: createTurnId("fixture-turn"),
          };
        },
        ...overrides,
      },
    }),
    { width: 100, height: 30, kittyKeyboard: true },
  );
  await act(async () => {
    await ui.flush();
  });
  return { ...ui, exits, submitted, sent };
}

type Ui = Awaited<ReturnType<typeof mount>>;
function burst(ui: Ui, value: string) {
  for (const char of value) ui.mockInput.pressKey(char);
  ui.mockInput.pressEnter();
}
async function submit(ui: Ui, value: string) {
  await act(async () => {
    if (value.includes("\n")) await ui.mockInput.pasteBracketedText(value);
    else await ui.mockInput.typeText(value);
  });
  await act(async () => {
    ui.mockInput.pressEnter();
    await ui.flush();
  });
}
async function destroy(ui: Ui) {
  await act(async () => {
    ui.renderer.destroy();
  });
}
function request(question = false): PermissionBrokerRequest {
  return {
    requestId: "fixture-request",
    sessionId: "fixture-session",
    traceId: "fixture-trace",
    toolCallId: "fixture-call",
    toolName: question ? "AskUserQuestion" : "Bash",
    input: question
      ? {
          questions: [
            {
              question: "Choose fixture",
              header: "Fixture",
              multiSelect: false,
              options: [
                { label: "A", description: "first" },
                { label: "B", description: "second" },
              ],
            },
          ],
        }
      : { command: "fixture-command" },
    mode: "build",
    ruleId: "fixture-rule",
    reason: "fixture",
    riskLevel: "medium",
    requestedAt: new Date(),
  } as PermissionBrokerRequest;
}

test("同批 prompt/Enter/quit 不拼旧 prompt，也不进入 busy queue", async () => {
  let context: TuiSubmitPromptOptions | undefined;
  let release = () => {};
  const prompts: unknown[] = [];
  const accepted = ["already-accepted"];
  const ui = await mount({
    submitPrompt: async (input, options) => {
      prompts.push(input);
      context = options;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { response: "" };
    },
    sendInput: async (input) => {
      accepted.push(String(input));
      return {
        kind: "queued",
        pendingInputId: "unexpected",
        queueLength: accepted.length,
        turnId: createTurnId("fixture-turn"),
      };
    },
  });
  try {
    await act(async () => {
      burst(ui, "fixture prompt");
      burst(ui, "/quit");
      await ui.flush();
    });
    assert.deepEqual(
      ui.exits,
      [0],
      `quit must be local; prompts=${JSON.stringify(prompts)} queue=${JSON.stringify(accepted)}`,
    );
    assert.deepEqual(prompts, ["fixture prompt"]);
    assert.deepEqual(accepted, ["already-accepted"]);
    assert.equal(context?.abortSignal.aborted, true);
    await act(async () => {
      burst(ui, "/quit");
      burst(ui, "late input");
      await ui.flush();
    });
    assert.deepEqual(ui.exits, [0]);
    assert.deepEqual(prompts, ["fixture prompt"]);
  } finally {
    await act(async () => {
      release();
      await ui.flush();
    });
    await destroy(ui);
  }
});

for (const locale of ["en-US", "zh-CN"] as const) {
  for (const modelSetupRequired of [false, true]) {
    test(`idle/no-model 本地退出 ${locale} ${modelSetupRequired}`, async () => {
      const ui = await mount({ locale, modelSetupRequired });
      try {
        await submit(ui, " /QuIt ");
        assert.deepEqual(ui.exits, [0]);
        assert.deepEqual(ui.submitted, []);
        assert.deepEqual(ui.sent, []);
      } finally {
        await destroy(ui);
      }
    });
  }
}

test("/quit 补全及帮助只在 TUI 本地处理", async () => {
  const ui = await mount();
  try {
    await submit(ui, "/help quit");
    assert.deepEqual(ui.submitted, []);
    await act(async () => {
      await ui.mockInput.typeText("/qui");
      await ui.flush();
    });
    await ui.renderOnce();
    assert.match(ui.captureCharFrame(), /Exit the TUI/);
    await act(async () => {
      ui.mockInput.pressEnter();
      await ui.flush();
    });
    assert.deepEqual(ui.exits, [0]);
    assert.deepEqual(ui.submitted, []);
  } finally {
    await destroy(ui);
  }
});

for (const kind of ["permission", "question", "other"] as const) {
  test(`${kind} 占用键盘后同批输入退出，不放行审批`, async () => {
    let context: TuiSubmitPromptOptions | undefined;
    let release = () => {};
    const ui = await mount({
      submitPrompt: async (_input, options) => {
        context = options;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { response: "" };
      },
    });
    const independent = new AbortController();
    let outcome: PermissionBrokerResult | Error | undefined;
    try {
      await submit(ui, "start");
      await act(async () => {
        void context!.requestPermission!(request(kind !== "permission"), {
          signal: independent.signal,
        }).then(
          (result) => {
            outcome = result;
          },
          (error: Error) => {
            outcome = error;
          },
        );
        await ui.flush();
      });
      await act(async () => {
        if (kind === "other") ui.mockInput.pressKey("o");
        burst(ui, "/quit");
        await ui.flush();
      });
      assert.deepEqual(ui.exits, [0]);
      assert.equal(context?.abortSignal.aborted, true);
      assert.ok(
        outcome instanceof Error,
        "exit rejects even a pending request with an independent signal",
      );
      independent.abort();
      assert.deepEqual(ui.exits, [0]);
    } finally {
      independent.abort();
      await act(async () => {
        release();
        await ui.flush();
      });
      await destroy(ui);
    }
  });
}

test("Other 同批编辑普通路径仍能完成，取消克隆审批后 composer 可用", async () => {
  let context: TuiSubmitPromptOptions | undefined;
  const ui = await mount({
    submitPrompt: async (_input, options) => {
      context = options;
      return { response: "" };
    },
  });
  const controller = new AbortController();
  let result: PermissionBrokerResult | undefined;
  try {
    await submit(ui, "start");
    await act(async () => {
      void context!.requestPermission!(request(true), { signal: controller.signal }).then(
        (value) => {
          result = value;
        },
        () => {},
      );
      await ui.flush();
    });
    await act(async () => {
      ui.mockInput.pressKey("o");
      burst(ui, "/tmp/fixture");
      ui.mockInput.pressEnter();
      ui.mockInput.pressEnter();
      await ui.flush();
    });
    assert.ok(result);
    assert.equal(result.decision, "modify");
    assert.equal(
      (result.modifiedInput as { answers: Record<string, string> }).answers["Choose fixture"],
      "/tmp/fixture",
    );
    assert.deepEqual(ui.exits, []);
    await submit(ui, "/quit");
    assert.deepEqual(ui.exits, [0]);
  } finally {
    controller.abort();
    await destroy(ui);
  }
});

test("streaming 的迟到 rejected 输入不覆盖新草稿，quit 不删除已接受 queue", async () => {
  let releaseTurn = () => {};
  let rejectInput = () => {};
  let signal: AbortSignal | undefined;
  const accepted = ["existing-input"];
  const ui = await mount({
    submitPrompt: async (_input, options) => {
      signal = options.abortSignal;
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      return { response: "" };
    },
    sendInput: async () => {
      await new Promise<void>((resolve) => {
        rejectInput = resolve;
      });
      return { kind: "rejected", reason: "turn_not_steerable" };
    },
  });
  try {
    await submit(ui, "start");
    await submit(ui, "old rejected prompt");
    await act(async () => {
      await ui.mockInput.typeText("/qui");
      rejectInput();
      await ui.flush();
    });
    await ui.renderOnce();
    assert.match(ui.captureCharFrame(), /Exit the TUI/);
    assert.doesNotMatch(ui.captureCharFrame(), /old rejected prompt/);
    await act(async () => {
      ui.mockInput.pressKey("t");
      ui.mockInput.pressEnter();
      await ui.flush();
    });
    assert.deepEqual(ui.exits, [0]);
    assert.equal(signal?.aborted, true);
    assert.deepEqual(accepted, ["existing-input"]);
  } finally {
    await act(async () => {
      rejectInput();
      releaseTurn();
      await ui.flush();
    });
    await destroy(ui);
  }
});

test("附件 composer 不误退，独立审批 quit 不提交该附件", async () => {
  let context: TuiSubmitPromptOptions | undefined;
  const ui = await mount({
    readClipboardImage: async () => ({
      dataUrl: "data:image/png;base64,ZmFrZQ==",
      mediaType: "image/png",
    }),
    submitPrompt: async (input, options) => {
      context = options;
      ui.submitted.push(input);
      return { response: "" };
    },
  });
  try {
    await act(async () => {
      ui.mockInput.pressKey("v", { ctrl: true });
      await ui.flush();
    });
    await submit(ui, "/quit");
    assert.deepEqual(ui.exits, []);
    assert.equal(ui.submitted.length, 1);
    const controller = new AbortController();
    await act(async () => {
      void context!.requestPermission!(request(), { signal: controller.signal }).catch(() => {});
      await ui.flush();
    });
    await act(async () => {
      burst(ui, "/quit");
      await ui.flush();
    });
    assert.deepEqual(ui.exits, [0]);
    assert.equal(ui.submitted.length, 1);
  } finally {
    await destroy(ui);
  }
});

for (const suffix of ["tfoo", "t args"]) {
  test(`已渲染 quit 建议后同批追加 ${suffix} 不退出`, async () => {
    const ui = await mount();
    try {
      await act(async () => {
        await ui.mockInput.typeText("/qui");
        await ui.flush();
      });
      await ui.renderOnce();
      assert.match(ui.captureCharFrame(), /Exit the TUI/);
      await act(async () => {
        burst(ui, suffix);
        await ui.flush();
      });
      assert.deepEqual(ui.exits, []);
      assert.deepEqual(ui.submitted, [`/qui${suffix}`]);
    } finally {
      await destroy(ui);
    }
  });
}

test("参数、多行和修饰 Enter 不误退", async () => {
  const ui = await mount();
  try {
    for (const text of ["/quitfoo", "/quit args", "first\n/quit", "/quit\n"])
      await submit(ui, text);
    assert.deepEqual(ui.exits, []);
    assert.equal(ui.submitted.length, 4);
    assert.ok(ui.submitted.every((value) => value !== "/quit"));
    await act(async () => {
      await ui.mockInput.typeText("/quit");
      ui.mockInput.pressEnter({ shift: true });
      await ui.flush();
    });
    assert.deepEqual(ui.exits, []);
  } finally {
    await destroy(ui);
  }
});
