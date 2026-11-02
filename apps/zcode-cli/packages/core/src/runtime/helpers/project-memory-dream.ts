import { resolve } from "node:path";
import type { SessionInfo } from "../deps.js";
import { systemReminderAttachmentEntry, type RuntimeAttachmentEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isMainMemoryTaskType } from "./project-memory.js";

export interface ProjectMemoryUpdate {
  inContextPaths: string[];
  paths: string[];
  source: "dream";
  summary: string;
}

export function selectProjectDreamSessions(input: {
  currentSessionId: AgentRuntimeInternal["sessionId"];
  sessions: readonly SessionInfo[];
  workspacePath: string;
  workspaceIdentity?: string;
}): SessionInfo[] {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  const workspacePath = workspaceIdentity ? undefined : resolve(input.workspacePath);

  return input.sessions.filter((session) => {
    if (session.id === input.currentSessionId) return false;
    if (!isMainMemoryTaskType(session.taskType)) return false;
    if (workspaceIdentity) return session.workspaceID === workspaceIdentity;
    return resolve(session.directory) === workspacePath;
  });
}

export function consumePendingProjectMemoryUpdate(
  runtime: AgentRuntimeInternal,
): RuntimeAttachmentEntry | undefined {
  const update = runtime.pendingMemoryUpdate;
  if (!update) return undefined;
  runtime.pendingMemoryUpdate = undefined;
  return systemReminderAttachmentEntry("memory_update", formatProjectMemoryUpdate(update));
}

function formatProjectMemoryUpdate(update: ProjectMemoryUpdate): string {
  const lines = [
    `Background memory consolidation updated your memory directory: ${update.summary}`,
  ];
  if (update.paths.length > 0) {
    lines.push(`Files changed: ${update.paths.join(", ")}`);
  }
  if (update.inContextPaths.length > 0) {
    lines.push(
      `Your loaded copy of ${update.inContextPaths.join(", ")} is now stale relative to disk — Read it again if you need current contents.`,
    );
  }
  lines.push(
    "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.",
  );
  return lines.join("\n");
}
