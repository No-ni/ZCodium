import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatedTerminalPanel } from "../src/app-shell/AnimatedTerminalPanel.js";

const state = vi.hoisted(() => ({
  panels: [] as Record<string, unknown>[],
  terminals: [] as Record<string, unknown>[],
}));
vi.mock("@/components/ui/resizable.js", () => ({
  ResizablePanel: ({ children, ...props }: Record<string, unknown>) => {
    state.panels.push(props);
    return createElement("section", {}, children as ReactNode);
  },
  ResizableHandle: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) =>
    createElement("button", { disabled, "data-resize": "true" }, children),
}));
vi.mock("@/Terminal.js", () => ({
  Terminal: (props: Record<string, unknown>) => {
    state.terminals.push(props);
    return createElement("div", { "data-terminal": "true" });
  },
}));
vi.mock("@/ErrorBoundary.js", () => ({
  ScopedErrorBoundary: ({ children }: { children?: ReactNode }) => children,
}));

describe("full-view terminal presentation", () => {
  beforeEach(() => {
    state.panels.length = 0;
    state.terminals.length = 0;
  });
  it("hides the existing open terminal without collapsing its panel or unmounting its content", () => {
    const markup = renderToStaticMarkup(
      createElement(AnimatedTerminalPanel, {
        services: {} as never,
        workspaceAbsPath: "/fixture",
        cwd: "/fixture",
        terminalWorkspaceKey: "/fixture",
        executionWorkspacePathReady: true,
        isVisible: true,
        presentationHidden: true,
        panelRef: { current: null },
        panelElementRef: { current: null },
        onClose() {},
        onOpenBrowserUrl() {},
      }),
    );
    expect(markup).toContain('data-terminal="true"');
    expect(state.panels[0]?.collapsible).toBe(false);
    expect(state.panels[0]?.disabled).toBe(true);
    expect(state.panels[0]?.inert).toBe(true);
    expect(state.terminals[0]?.isVisible).toBe(false);
  });
  it("leaves a never-opened terminal lazy while in full view", () => {
    renderToStaticMarkup(
      createElement(AnimatedTerminalPanel, {
        services: {} as never,
        workspaceAbsPath: "/fixture",
        cwd: "/fixture",
        terminalWorkspaceKey: "/fixture",
        executionWorkspacePathReady: true,
        isVisible: false,
        presentationHidden: true,
        panelRef: { current: null },
        panelElementRef: { current: null },
        onClose() {},
        onOpenBrowserUrl() {},
      }),
    );
    expect(state.terminals).toHaveLength(0);
    expect(state.panels[0]?.collapsible).toBe(true);
  });
});
