import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolSearchSetting } from "../src/settings/ToolSearchSetting.js";
import { ToolSearchToolCallBlock } from "../src/ToolCallBlocks/renderers/tool-search.js";
import { readToolResultDisplay } from "../src/ToolCallBlocks/toolResultDisplay.js";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";

const capture = vi.hoisted(() => ({
  layouts: [] as Record<string, unknown>[],
  selects: [] as { value: string; onValueChange(value: string): void }[],
  locale: "en-US" as "en-US" | "zh-CN",
}));
vi.mock("@/i18n/IntlProvider.js", async () => {
  const en = (await import("../src/i18n/locales/en-US.js")).default;
  const zh = (await import("../src/i18n/locales/zh-CN.js")).default;
  return {
    useZCodeIntl: () => ({
      intl: {
        formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) => {
          const messages: Record<string, string> = capture.locale === "zh-CN" ? zh : en;
          let text = messages[id] ?? id;
          for (const [key, value] of Object.entries(values ?? {}))
            text = text.replaceAll(`{${key}}`, String(value));
          return text;
        },
      },
    }),
  };
});
vi.mock("@/components/ai-elements/code-block.js", () => ({ CodeBlock: () => null }));
vi.mock("@/components/ui/select.js", () => {
  const wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Select: ({
      children,
      ...props
    }: {
      children?: ReactNode;
      value: string;
      onValueChange(value: string): void;
    }) => {
      capture.selects.push(props);
      return createElement("div", { "data-value": props.value }, children);
    },
    SelectContent: wrapper,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) =>
      createElement("div", { "data-option": value }, children),
    SelectTrigger: ({ children, ...props }: ComponentProps<"button">) =>
      createElement("button", props, children),
    SelectValue: () => null,
  };
});
vi.mock("@/ToolCallBlocks/ToolLayout.js", () => ({
  ToolLayout: (props: Record<string, unknown>) => {
    capture.layouts.push(props);
    const content = props.renderContent as (() => ReactNode) | undefined;
    return createElement(
      "div",
      null,
      props.kindLabel as ReactNode,
      props.primaryText as ReactNode,
      props.statusLabel as ReactNode,
      props.forceOpen ? content?.() : null,
    );
  },
}));
vi.mock("@/ToolCallBlocks/ToolSnapshotFieldNotice.js", () => ({
  ToolSnapshotFieldNotice: () => null,
}));

const display = {
  kind: "tool_search",
  query: "+fixture lookup",
  matches: ["FixtureLookup", "mcp__fixture__inspect"],
  totalMatches: 2,
  totalDeferredTools: 3,
};
function context(
  status = "completed",
  raw: unknown = { display },
  overrides: Record<string, unknown> = {},
): ToolCallBlockRenderContext {
  return {
    toolCallNode: {
      toolCall: {
        toolId: "fixture",
        toolName: "ToolSearch",
        kind: "ToolSearch",
        status,
        input: { query: "input query" },
        raw,
      },
      childToolCalls: [],
    },
    isRunning: status === "running",
    statusLabel: `status-${status}`,
    errorText: "fixture-error",
    forceOpen: true,
    ...overrides,
  } as unknown as ToolCallBlockRenderContext;
}
const renderCard = (value: ToolCallBlockRenderContext) =>
  renderToStaticMarkup(createElement(ToolSearchToolCallBlock, value));

beforeEach(() => {
  capture.layouts.length = 0;
  capture.selects.length = 0;
  capture.locale = "en-US";
});

describe("experimental ToolSearch setting", () => {
  it("defaults Off and offers only Auto/Local/Off through the existing save callback", () => {
    const save = vi.fn(async () => {});
    const markup = renderToStaticMarkup(createElement(ToolSearchSetting, { onModeChange: save }));
    expect(capture.selects[0]?.value).toBe("off");
    expect(markup).toContain('data-option="auto"');
    expect(markup).toContain('data-option="local"');
    expect(markup).toContain('data-option="off"');
    expect(markup).not.toContain('data-option="native"');
    expect(markup).toContain("Experimental");
    expect(markup).toContain("w-full min-w-0");
    capture.selects[0]?.onValueChange("local");
    expect(save).toHaveBeenCalledExactlyOnceWith("local");
    capture.selects[0]?.onValueChange("native");
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("renders Chinese without creating a second preference state", () => {
    capture.locale = "zh-CN";
    const markup = renderToStaticMarkup(
      createElement(ToolSearchSetting, { mode: "auto", onModeChange: vi.fn(async () => {}) }),
    );
    expect(capture.selects[0]?.value).toBe("auto");
    expect(markup).toContain("实验");
    expect(markup).not.toContain("settings.toolSearch");
  });
});

describe("ToolSearch authoritative tool cards", () => {
  it("reads the same strict display from live result, V4 output, and cold metadata", () => {
    for (const raw of [
      { result: { display } },
      { output: { display } },
      { metadata: { display } },
      { display },
    ]) {
      expect(readToolResultDisplay(raw)).toEqual(display);
      const markup = renderCard(context("completed", raw));
      expect(markup).toContain("FixtureLookup");
      expect(markup).toContain("mcp__fixture__inspect");
      expect(markup).not.toContain("input query");
    }
    expect(readToolResultDisplay({ display: { ...display, schema: {} } })).toBeUndefined();
  });
  it("never reads/prints full Local JSONSchema for a collapsed card", () => {
    const parse = vi.spyOn(JSON, "parse");
    const markup = renderCard(
      context("completed", { display, output: "unbounded-schema-fixture" }, { forceOpen: false }),
    );
    expect(capture.layouts[0]?.canToggle).toBe(true);
    expect(markup).not.toContain("FixtureLookup");
    expect(markup).not.toContain("unbounded-schema-fixture");
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });
  it("shows zero matches and preserves failed/denied/stopped/running statuses without fake success", () => {
    const none = renderCard(
      context("completed", { display: { ...display, matches: [], totalMatches: 0 } }),
    );
    expect(none).toContain("No matching tools");
    for (const status of ["failed", "denied", "stopped", "running"]) {
      capture.layouts.length = 0;
      renderCard(context(status));
      expect(capture.layouts[0]?.statusLabel).toBe(`status-${status}`);
      expect(capture.layouts[0]?.canToggle).toBe(false);
      expect(capture.layouts[0]?.showFailureStatus).toBe(status === "failed");
    }
  });
  it("marks display truncation and renders Chinese matched names without inference from wrapper JSON", () => {
    capture.locale = "zh-CN";
    const markup = renderCard(
      context("completed", { display: { ...display, truncated: true, totalMatches: 120 } }),
    );
    expect(markup).toContain("FixtureLookup");
    expect(markup).not.toContain("chat.toolCall.toolSearch");
    expect(markup).toContain("120");
    expect(markup).not.toContain("DeferredToolCall");
  });
});
