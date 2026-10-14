export interface PrimaryDraftEffectiveSessionBinding {
  workspaceKey: string;
  paneId: string;
  sessionId: string;
  generation: object;
}

export type PrimaryDraftEffectiveSessionBindingEvent =
  | { type: "bind"; binding: PrimaryDraftEffectiveSessionBinding; scopeToken: object }
  | { type: "clear"; generation: object; scopeToken: object };

export function applyPrimaryDraftEffectiveSessionBinding(
  current: PrimaryDraftEffectiveSessionBinding | null,
  event: PrimaryDraftEffectiveSessionBindingEvent,
  context: {
    workspaceKey: string;
    activeTaskId: string | null;
    isLocalWorkspace: boolean;
    primaryPaneId: string;
    scopeToken: object;
  },
): PrimaryDraftEffectiveSessionBinding | null {
  if (event.scopeToken !== context.scopeToken) {
    return current;
  }

  if (event.type === "clear") {
    return current?.generation === event.generation ? null : current;
  }

  if (
    !context.isLocalWorkspace ||
    context.activeTaskId !== null ||
    event.binding.workspaceKey !== context.workspaceKey ||
    event.binding.paneId !== context.primaryPaneId
  ) {
    return current;
  }

  return event.binding;
}
