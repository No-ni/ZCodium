import { describe, expect, it } from "vitest";
import {
  applyPrimaryDraftEffectiveSessionBinding,
  type PrimaryDraftEffectiveSessionBinding,
} from "./primaryDraftSessionBinding.js";

const PRIMARY_PANE_ID = "workspace-main";
const WORKSPACE_KEY = "/Users/me/.zcodium/workspace/default";
const SCOPE_TOKEN = {};
const CONTEXT = {
  workspaceKey: WORKSPACE_KEY,
  activeTaskId: null,
  isLocalWorkspace: true,
  primaryPaneId: PRIMARY_PANE_ID,
  scopeToken: SCOPE_TOKEN,
};

function binding(sessionId: string, generation: object = {}): PrimaryDraftEffectiveSessionBinding {
  return {
    workspaceKey: WORKSPACE_KEY,
    paneId: PRIMARY_PANE_ID,
    sessionId,
    generation,
  };
}

describe("applyPrimaryDraftEffectiveSessionBinding", () => {
  it("accepts only the current local primary draft binding", () => {
    const next = binding("prewarm-a");

    expect(
      applyPrimaryDraftEffectiveSessionBinding(
        null,
        { type: "bind", binding: next, scopeToken: SCOPE_TOKEN },
        CONTEXT,
      ),
    ).toBe(next);
    expect(
      applyPrimaryDraftEffectiveSessionBinding(
        null,
        {
          type: "bind",
          binding: { ...next, workspaceKey: "/another/workspace" },
          scopeToken: SCOPE_TOKEN,
        },
        CONTEXT,
      ),
    ).toBeNull();
    expect(
      applyPrimaryDraftEffectiveSessionBinding(
        null,
        {
          type: "bind",
          binding: { ...next, paneId: "secondary-pane" },
          scopeToken: SCOPE_TOKEN,
        },
        CONTEXT,
      ),
    ).toBeNull();
    expect(
      applyPrimaryDraftEffectiveSessionBinding(
        null,
        {
          type: "bind",
          binding: next,
          scopeToken: SCOPE_TOKEN,
        },
        {
          ...CONTEXT,
          activeTaskId: "task-a",
        },
      ),
    ).toBeNull();
    expect(
      applyPrimaryDraftEffectiveSessionBinding(
        null,
        {
          type: "bind",
          binding: next,
          scopeToken: SCOPE_TOKEN,
        },
        {
          ...CONTEXT,
          isLocalWorkspace: false,
        },
      ),
    ).toBeNull();
  });

  it("does not let an old cleanup clear a newer prewarm generation", () => {
    const oldBinding = binding("prewarm-old");
    const currentBinding = binding("prewarm-new");
    const cleared = applyPrimaryDraftEffectiveSessionBinding(
      currentBinding,
      { type: "clear", generation: oldBinding.generation, scopeToken: SCOPE_TOKEN },
      CONTEXT,
    );

    expect(cleared).toBe(currentBinding);
    expect(
      applyPrimaryDraftEffectiveSessionBinding(
        currentBinding,
        { type: "clear", generation: currentBinding.generation, scopeToken: SCOPE_TOKEN },
        CONTEXT,
      ),
    ).toBeNull();
  });

  it("rejects late bindings and cleanup from a prior workspace visit", () => {
    const currentBinding = binding("prewarm-current");
    const oldScopeToken = {};
    const returnedToWorkspaceContext = { ...CONTEXT, scopeToken: {} };

    expect(
      applyPrimaryDraftEffectiveSessionBinding(
        null,
        {
          type: "bind",
          binding: binding("prewarm-old"),
          scopeToken: oldScopeToken,
        },
        returnedToWorkspaceContext,
      ),
    ).toBeNull();
    expect(
      applyPrimaryDraftEffectiveSessionBinding(
        currentBinding,
        {
          type: "clear",
          generation: currentBinding.generation,
          scopeToken: oldScopeToken,
        },
        returnedToWorkspaceContext,
      ),
    ).toBe(currentBinding);
  });
});
