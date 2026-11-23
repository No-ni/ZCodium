import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import ts from "typescript";

const require = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const React = require("react");
const { createRoot } = require("react-dom/client");
const jsx = require("react/jsx-runtime");
const intl = { formatMessage: ({ id }) => id };
const presentationContext = React.createContext({ currentTime: 1 });
const pass = ({ children }) => React.createElement(React.Fragment, null, children);
const icon = () => null;

async function component(path, dependencies) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", compiled)(
    (id) => {
      if (id === "react") return React;
      if (id === "react/jsx-runtime") return jsx;
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected runtime dependency: ${id}`);
      return dependencies[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://fixture.invalid" });
  const names = [
    "window",
    "document",
    "HTMLElement",
    "Element",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const previous = new Map(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  let registrations = 0;
  let pathReads = 0;
  const calls = [];
  const content = await component(
    "../../packages/ui/src/project-sidebar/grouped/TaskRowContent.tsx",
    {
      "@zcode/shared/test-ids": {
        TID_TASK_ROW_WORKTREE_ICON: "worktree",
        TID_TASK_ITEM: "task",
        testId: (id, value) => `${id}:${value}`,
      },
      "lucide-react": Object.fromEntries(
        ["GitBranch", "ArrowUpToLine", "Clock", "ListTree", "LoaderIcon", "Moon", "X"].map(
          (name) => [name, icon],
        ),
      ),
      "@/managed-worktrees/index.js": { formatWorktreeLabel: () => "" },
      "@/components/ui/context-menu.js": { ContextMenuTrigger: pass },
      "@/task-row-hover/index.js": { TaskRowIdentityHoverCard: pass },
      "@/components/lib/utils.js": { cn: (...values) => values.filter(Boolean).join(" ") },
      "@/components/ui/badge.js": { Badge: pass },
      "@/components/TaskTitleOverflowText.js": { TaskTitleOverflowText: pass },
      "@/TaskInteractionBadge.js": { TaskInteractionBadge: icon },
      "@/workspace-grouped-tasks/task-row-action-button.js": { TaskRowActionButton: icon },
      "@/project-sidebar/grouped/types.js": {
        TASK_GROUP_ROW_CLASS: "row",
        TASK_GROUP_ROW_LINE_CLASS: "line",
      },
    },
  );
  const useDnd = () => {
    React.useEffect(() => {
      registrations++;
      return () => {
        registrations--;
      };
    }, []);
    return { attributes: {}, listeners: undefined, setNodeRef() {} };
  };
  const useTaskActions = ({ loadTaskPaths, loadProviderConfig }) => {
    React.useRef(null);
    if (loadTaskPaths || loadProviderConfig) pathReads++;
    return {
      handleCopyText() {},
      handleCopyWorkspacePath() {},
      handleOpenTaskPathInFileManager() {},
      handleOpenProviderConfig() {},
    };
  };
  const row = await component("../../packages/ui/src/project-sidebar/grouped/task-row.tsx", {
    "@dnd-kit/core": { useDraggable: useDnd, useDroppable: useDnd },
    "@zcode/shared": { isCronTask: () => false, isOffPeakTask: () => false },
    "@/components/ui/context-menu.js": { ContextMenu: pass },
    "@/managed-worktrees/index.js": { formatWorktreeLabel: () => "" },
    "@/i18n/IntlProvider.js": {
      useZCodeIntl: () => {
        React.useContext(presentationContext);
        return { intl };
      },
    },
    "@/lib/taskListItemPresentation.js": {
      deriveTaskLeadingIndicator: () => "none",
      formatTaskRelativeTime: () => "recent",
      isTaskRowRenameBlockedTarget: () => false,
    },
    "@/lib/taskQueryCache.js": { buildTaskWorkspaceKey: (path, identity) => identity || path },
    "@/useTaskListItemContextActions.js": { useTaskListItemContextActions: useTaskActions },
    "@/hooks/usePlatform.js": {
      usePlatform: () => {
        React.useRef(null);
        return { openFeedback() {} };
      },
    },
    "@/v4/taskListRowActivity.js": {
      getTaskListAttention: () => null,
      getTaskListRowActivity: () => null,
      isTaskListRowRunning: () => false,
    },
    "@/project-sidebar/grouped/task-context-menu-content.js": {
      GroupedTaskContextMenuContent: icon,
    },
    "@/project-sidebar/grouped/TaskRowContent.js": content,
    "@/project-sidebar/grouped/TaskRowPreview.js": {
      TaskRowPreview: ({ taskTitle }) =>
        React.createElement("div", { "data-preview": true }, taskTitle),
    },
    "@/project-sidebar/ProjectTaskListContext.js": { ProjectTaskListContext: presentationContext },
    "@/components/workflow-run-line/TaskWorkflowRunLines.js": { TaskWorkflowRunLines: icon },
    "@/hooks/useTaskInteractionAutoResolutionSnooze.js": {
      useTaskInteractionAutoResolutionSnooze: () => {
        React.useRef(null);
        return () => false;
      },
    },
    "@/store/TabStoreProvider.js": { useOptionalTabStore: () => React.useState(false)[0] },
    "@/store/tabStore.js": { isWorkspaceReadOnly: () => false },
  });
  const root = createRoot(dom.window.document.getElementById("root"));
  const task = {
    taskId: "fixture",
    title: "Fixture task",
    workspacePath: "/fixture",
    updatedAt: 1,
  };
  const noop = () => {};
  const props = {
    task,
    groups: [],
    isActive: false,
    isMobileActive: false,
    workspaceLabel: "Fixture",
    onSelectTask: () => calls.push("select"),
    onStartRenameTask: () => calls.push("rename"),
    onCloseTask: noop,
    onOpenFileTree: noop,
    onMoveTaskToGroup: noop,
    onMoveTaskToTop: noop,
    onArchiveTask: noop,
    onMarkTaskAsUnread: noop,
    dragId: "fixture-row",
    tooltipsDisabled: true,
  };
  const render = async (dragOverlay) =>
    React.act(async () =>
      root.render(React.createElement(row.GroupedTaskRow, { ...props, dragOverlay })),
    );
  return {
    dom,
    calls,
    errors,
    render,
    registrations: () => registrations,
    pathReads: () => pathReads,
    async close() {
      await React.act(async () => root.unmount());
      console.error = originalError;
      for (const name of names) {
        const descriptor = previous.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
      dom.window.close();
    },
  };
}

test("preview and interactive rows can alternate without Hook order errors or preview registrations", async () => {
  const f = await fixture();
  try {
    for (const preview of [true, false, true, false, true]) {
      await f.render(preview);
      assert.equal(f.registrations(), preview ? 0 : 2);
      assert.equal(f.pathReads(), 0);
      assert.ok(f.dom.window.document.body.textContent.includes("Fixture task"));
    }
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("real row DOM dispatches one select and one rename for a double click", async () => {
  const f = await fixture();
  try {
    await f.render(false);
    const row = f.dom.window.document.querySelector('[role="button"]');
    assert.ok(row);
    await React.act(async () => {
      row.dispatchEvent(new f.dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
      row.dispatchEvent(new f.dom.window.MouseEvent("click", { bubbles: true, detail: 2 }));
      row.dispatchEvent(new f.dom.window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    });
    assert.deepEqual(f.calls, ["select", "rename"]);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
