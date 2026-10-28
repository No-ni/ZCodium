import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatPromptEditor } from "../src/prompt-editor/ChatPromptEditor.js";

vi.mock("@/LexicalChatInput.js", () => ({
  LexicalChatInput: () =>
    createElement("div", { contentEditable: true, "data-testid": "test-editor", role: "textbox" }),
}));
vi.mock("@/prompt-editor/ChatPromptActionMenu.js", () => ({
  ChatPromptActionMenu: () =>
    createElement("button", { type: "button", "data-testid": "test-action-menu" }, "+"),
}));
vi.mock("@/prompt-editor/useComposerToolbarFit.js", () => ({
  useComposerToolbarFit: () => ({ current: null }),
}));
vi.mock("@/prompt-editor/usePromptEditorDragState.js", () => ({
  usePromptEditorDragState: () => ({
    externalFileDragging: false,
    internalDragging: false,
    workspaceFileDragging: false,
    setExternalFileDragging() {},
    setInternalDragging() {},
    setWorkspaceFileDragging() {},
  }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
const props: ComponentProps<typeof ChatPromptEditor> = {
  workspacePath: "/fixture",
  taskId: null,
  submitLabel: "Send",
  onSubmit: () => false,
  showMentionButton: true,
  leadingActions: createElement("button", { "data-testid": "test-mode" }, "Mode"),
};
function markup(layout: "inline" | "stacked", topContent?: ReactNode) {
  return renderToStaticMarkup(createElement(ChatPromptEditor, { ...props, layout, topContent }));
}
describe("full-view keeps one editor tree", () => {
  it("has one editor at the same stable position for both layouts", () => {
    for (const layout of ["inline", "stacked"] as const) {
      const rendered = markup(layout);
      expect(rendered.match(/data-testid="test-editor"/g)).toHaveLength(1);
      expect(rendered).toContain(`data-composer-layout="${layout}"`);
      expect(rendered).toContain('data-composer-input=""');
    }
  });
  it("keeps attachment content above the inline input instead of nesting it in the toolbar", () => {
    const rendered = markup(
      "inline",
      createElement("span", { "data-testid": "test-attachment" }, "Attachment"),
    );
    expect(rendered.indexOf("test-attachment")).toBeLessThan(rendered.indexOf("test-editor"));
    expect(rendered).toContain("basis-full");
  });
  it("keeps the action menu before the inline input and the original controls after it", () => {
    const inline = markup("inline");
    expect(inline.indexOf("test-action-menu")).toBeLessThan(inline.indexOf("test-editor"));
    expect(inline.indexOf("test-mode")).toBeGreaterThan(inline.indexOf("test-editor"));
    expect(inline).toContain('data-composer-action-menu=""');
    const stacked = markup("stacked");
    expect(stacked).toContain("order-3");
    expect(stacked).toContain("order-4");
  });
  it("preserves the existing stacked controls and send semantics", () => {
    const rendered = markup("stacked");
    expect(rendered).toContain('data-testid="test-action-menu"');
    expect(rendered).toContain('data-testid="test-mode"');
    expect(rendered).toContain('type="submit"');
  });
});
