import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const calls = vi.hoisted(() => ({
  lists: [] as Array<{
    enabled?: boolean;
    workspaceTabs: WorkspaceTabState[];
    searchQuery: string;
    collapsedLimit: number;
  }>,
}));
vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList(params: (typeof calls.lists)[number]) {
    calls.lists.push(params);
    return {
      items: [],
      total: 0,
      hasMore: false,
      loading: false,
      syncingRemoteWorkspaces: false,
      refresh: async () => {},
    };
  },
}));
vi.mock("@/hooks/useCommandCenterFileSearch.js", () => ({
  useCommandCenterFileSearch: () => ({ files: [], loading: false, error: null }),
}));
afterEach(() => {
  calls.lists.length = 0;
});

const current: WorkspaceTabState = {
  id: "current",
  kind: "workspace",
  label: "Synthetic",
  workspacePath: "C:/synthetic",
  workspaceIdentity: "identity-current",
};
const samePathOtherIdentity: WorkspaceTabState = {
  ...current,
  id: "other",
  workspaceIdentity: "identity-other",
};

function render(open: boolean) {
  renderToString(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(CommandCenterDialog, {
        open,
        commands: [],
        workspaceAbsPath: current.workspacePath,
        workspaceIdentity: current.workspaceIdentity,
        activeTaskId: "active",
        workspaceTabs: [current, samePathOtherIdentity],
        onOpenChange() {},
        onSelectTask() {},
        onOpenCodeViewer() {},
      }),
    }),
  );
}

describe("Command Center list subscription wiring", () => {
  it("disables both existing list hooks while closed without skipping hooks", () => {
    render(false);
    expect(calls.lists).toHaveLength(2);
    for (const call of calls.lists) {
      expect(call.enabled).toBe(false);
      expect(call.workspaceTabs).toEqual([]);
    }
  });

  it("enables both hooks while open and keeps existing scope and limit semantics", () => {
    render(true);
    expect(calls.lists).toHaveLength(2);
    expect(calls.lists.map((call) => call.enabled)).toEqual([true, true]);
    expect(calls.lists[0]).toMatchObject({
      workspaceTabs: [],
      searchQuery: "",
      collapsedLimit: 80,
    });
    expect(calls.lists[1]).toMatchObject({
      workspaceTabs: [current],
      searchQuery: "",
      collapsedLimit: 4,
    });
  });
});
