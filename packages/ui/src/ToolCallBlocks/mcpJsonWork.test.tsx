import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallBlockRenderContext } from "./shared.js";

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: "code-block",
  CodeBlockActions: "code-actions",
  CodeBlockCopyButton: "copy-button",
  CodeBlockHeader: "code-header",
  CodeBlockTitle: "code-title",
  CodeBlockWrapButton: "wrap-button",
}));
vi.mock("@/components/ui/button.js", () => ({ Button: "button" }));
vi.mock("@/components/ui/collapsible.js", () => ({
  Collapsible: "collapsible",
  CollapsibleContent: "collapsible-content",
  CollapsibleTrigger: "collapsible-trigger",
}));
vi.mock("@/ToolCallBlocks/ToolLayout.js", () => ({ ToolLayout: "tool-layout" }));
vi.mock("@/ToolCallBlocks/ToolSnapshotFieldNotice.js", () => ({
  ToolSnapshotFieldNotice: "field-notice",
}));
vi.mock("@/ToolCallBlocks/ToolCallProgressIndicator.js", () => ({
  readToolCallProgress: () => null,
  ToolCallProgressIndicator: "progress",
}));

import { McpToolCallBlock } from "./renderers/mcp.js";

function context(
  output: unknown,
  status = "completed",
  error?: string,
): ToolCallBlockRenderContext {
  return {
    theme: "dark",
    statusLabel: status,
    toolCallNode: {
      toolCall: {
        toolId: "fixture",
        toolName: "mcp__fixture__action",
        title: "Fixture",
        status,
        output,
        error,
      },
    },
  } as unknown as ToolCallBlockRenderContext;
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (predicate(node)) return node;
  return findElement(node.props.children as ReactNode, predicate);
}

function expanded(input: ToolCallBlockRenderContext): ReactNode {
  const layout = McpToolCallBlock(input) as ReactElement<{ renderContent: () => ReactNode }>;
  return layout.props.renderContent();
}

afterEach(() => vi.restoreAllMocks());

describe("MCP result JSON classification", () => {
  for (const result of ['{"ok":true}', JSON.stringify({ text: "x".repeat(5_000) }), "[\n1,2\n]"]) {
    it(`parses expanded JSON once for code block props (${result.length} characters)`, () => {
      const spy = vi.spyOn(JSON, "parse");
      const tree = expanded(context(result));
      const code = findElement(tree, (element) => element.type === "code-block")!;
      expect(code.props.code).toBe(result);
      expect(code.props.enableSyntaxHighlighting).toBe(true);
      expect(code.props.language).toBe("json");
      expect(spy).toHaveBeenCalledTimes(1);
    });
  }

  it("retains compact text and strict invalid JSON classification", () => {
    for (const result of ["  success  ", "0", "true", '"string"', "{invalid}", "[invalid]"]) {
      const tree = expanded(context(result));
      const surface = findElement(
        tree,
        (element) => element.props["data-testid"] === "mcp-result-surface",
      )!;
      expect(surface.type).toBe("p");
      expect(surface.props.children).toBe(result.trim());
    }
    for (const result of ["{invalid".repeat(30), "plain\ntext", "x".repeat(161)]) {
      const tree = expanded(context(result));
      const code = findElement(tree, (element) => element.type === "code-block")!;
      expect(code.props.code).toBe(result);
      expect(code.props.enableSyntaxHighlighting).toBe(false);
      expect(code.props.language).toBe("log");
    }
  });

  it("does not parse collapsed, summary-only, absent, or error-obscured results", () => {
    const spy = vi.spyOn(JSON, "parse");
    McpToolCallBlock(context('{"ok":true}'));
    for (const status of ["pending", "stopped"]) {
      const layout = McpToolCallBlock(context('{"ok":true}', status))!;
      expect(layout.props.canToggle).toBe(false);
      expect(layout.props.forceOpen).toBe(false);
    }
    const error = expanded(context('{"ok":true}', "failed", "failure"));
    expect(
      findElement(error, (element) => element.props["data-testid"] === "mcp-error-surface")!.props
        .children,
    ).toBe("failure");
    expanded(context(undefined));
    expanded(context(""));
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps whitespace, carriage return, empty JSON, and compact length boundaries", () => {
    for (const result of [" {} ", " [] ", '{\r"ok":true}']) {
      const code = findElement(
        expanded(context(result)),
        (element) => element.type === "code-block",
      )!;
      expect(code.props.language).toBe("json");
      expect(code.props.code).toBe(result);
    }
    expect(
      findElement(
        expanded(context("x".repeat(160))),
        (element) => element.props["data-testid"] === "mcp-result-surface",
      )!.type,
    ).toBe("p");
    expect(
      findElement(expanded(context("x".repeat(161))), (element) => element.type === "code-block"),
    ).toBeDefined();
    expect(
      findElement(expanded(context(" \r ")), (element) => element.type === "code-block")!.props
        .language,
    ).toBe("log");
  });
});
