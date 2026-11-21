import {
  WorkflowKindSchema,
  WorkflowPhaseIdSchema,
  WorkflowRunStatusSchema,
  WorkflowNodeStatusSchema,
  WorkflowStrategySchema,
  WorkflowArtifactSchema,
  WorkflowPhaseSnapshotSchema,
  WorkflowGraphSchema,
  deriveWorkflowSchedulerState,
} from "../protocol-values/workflow-contract.js";
import type {
  WorkflowKind,
  WorkflowRunStatus,
  WorkflowNodeStatus,
  WorkflowDefinition,
  WorkflowGraphRecord,
  WorkflowEvent,
  WorkflowSchedulerState,
} from "../protocol-values/workflow-contract.js";
export * from "../protocol-values/workflow-contract.js";
import { z } from "zod";

export * from "./script.js";

export const WorkflowActivityKindSchema = z.enum([
  "agent_session",
  "planner_agent",
  "subplanner_agent",
  "actor_agent",
  "critic_agent",
]);
export type WorkflowActivityKind = z.infer<typeof WorkflowActivityKindSchema>;

export const WorkflowSessionLinkStatusSchema = z.enum([
  "starting",
  "running",
  "retrying_model",
  "waiting_permission",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowSessionLinkStatus = z.infer<typeof WorkflowSessionLinkStatusSchema>;

export const WorkflowFailureKindSchema = z.enum([
  "network",
  "rate_limit",
  "timeout",
  "auth",
  "provider",
  "model_context",
  "configuration",
  "permission",
  "tool",
  "cancelled",
  "unknown",
]);
export type WorkflowFailureKind = z.infer<typeof WorkflowFailureKindSchema>;

export const WorkflowFailureSchema = z.object({
  activityId: z.string().optional(),
  code: z.string().optional(),
  kind: WorkflowFailureKindSchema,
  message: z.string(),
  nodeId: z.string().optional(),
  phase: WorkflowPhaseIdSchema.optional(),
  recoverable: z.boolean(),
  retryable: z.boolean(),
  sessionId: z.string().optional(),
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowFailure = z.infer<typeof WorkflowFailureSchema>;

export const WorkflowRecoveryActionSchema = z.object({
  action: z.enum(["retry", "retry_with_current_model", "skip_node", "cancel"]),
  activityId: z.string().optional(),
  destructive: z.boolean().optional(),
  label: z.string(),
  nodeId: z.string().optional(),
  phase: WorkflowPhaseIdSchema.optional(),
});
export type WorkflowRecoveryAction = z.infer<typeof WorkflowRecoveryActionSchema>;

export const WorkflowSessionLinkSchema = z.object({
  activityId: z.string(),
  attempt: z.number().int().positive(),
  completedAt: z.string().optional(),
  kind: WorkflowActivityKindSchema,
  model: z.string().optional(),
  nodeId: z.string().optional(),
  parentSessionId: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  runId: z.string(),
  sessionId: z.string().optional(),
  startedAt: z.string(),
  status: WorkflowSessionLinkStatusSchema,
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowSessionLink = z.infer<typeof WorkflowSessionLinkSchema>;

export const WorkflowActivitySnapshotSchema = z.object({
  activityId: z.string(),
  artifactPath: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  inputArtifactPaths: z.array(z.string()).default([]),
  kind: WorkflowActivityKindSchema,
  model: z.string().optional(),
  nodeId: z.string().optional(),
  outputArtifactPaths: z.array(z.string()).default([]),
  parentSessionId: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  sessionId: z.string().optional(),
  startedAt: z.string(),
  status: WorkflowNodeStatusSchema,
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
export type WorkflowActivitySnapshot = z.infer<typeof WorkflowActivitySnapshotSchema>;

export const WorkflowCriticSeveritySchema = z.enum(["critical", "major", "minor"]);
export type WorkflowCriticSeverity = z.infer<typeof WorkflowCriticSeveritySchema>;

export const WorkflowCriticReopenProposalSchema = z.object({
  nodeId: z.string().min(1),
  reason: z.string().min(1),
  severity: WorkflowCriticSeveritySchema.optional(),
});
export type WorkflowCriticReopenProposal = z.infer<typeof WorkflowCriticReopenProposalSchema>;

export const WorkflowCriticResultSchema = z.object({
  acceptanceGaps: z.array(z.string()).default([]),
  reasoning: z.string().default(""),
  reopenProposals: z.array(WorkflowCriticReopenProposalSchema).default([]),
  verdict: z.enum(["pass", "fail"]),
});
export type WorkflowCriticResult = z.infer<typeof WorkflowCriticResultSchema>;

export const WorkflowRunSnapshotSchema = z.object({
  activities: z.array(WorkflowActivitySnapshotSchema).default([]),
  artifacts: z.array(WorkflowArtifactSchema),
  completedAt: z.string().optional(),
  createdAt: z.string(),
  currentPhase: WorkflowPhaseIdSchema.optional(),
  cwd: z.string(),
  definitionId: z.string().min(1).optional(),
  definitionVersion: z.string().min(1).optional(),
  graph: WorkflowGraphSchema,
  kind: WorkflowKindSchema,
  phaseOrder: z.array(WorkflowPhaseIdSchema),
  phases: z.array(WorkflowPhaseSnapshotSchema),
  failure: WorkflowFailureSchema.optional(),
  pauseReason: z.string().optional(),
  reportPath: z.string().optional(),
  recoveryActions: z.array(WorkflowRecoveryActionSchema).default([]),
  runId: z.string(),
  schemaVersion: z.literal(1),
  sessionId: z.string().optional(),
  sessionLinks: z.array(WorkflowSessionLinkSchema).default([]),
  startedAt: z.string().optional(),
  status: WorkflowRunStatusSchema,
  strategy: WorkflowStrategySchema,
  task: z.string(),
  traceId: z.string().optional(),
  updatedAt: z.string(),
});
export type WorkflowRunSnapshot = z.infer<typeof WorkflowRunSnapshotSchema>;

export const ExpertWorkflowRunSnapshotSchema = WorkflowRunSnapshotSchema;
export type ExpertWorkflowRunSnapshot = WorkflowRunSnapshot;

export function deriveWorkflowRunSchedulerState(
  snapshot: WorkflowRunSnapshot,
): WorkflowSchedulerState {
  const state = deriveWorkflowSchedulerState(snapshot.graph);
  const activeActivities = snapshot.activities
    .filter((activity) => activity.status === "active")
    .map((activity) => ({
      activityId: activity.activityId,
      ...(activity.nodeId ? { nodeId: activity.nodeId } : {}),
      phase: activity.phase,
      ...(activity.sessionId ? { sessionId: activity.sessionId } : {}),
      ...(activity.traceId ? { traceId: activity.traceId } : {}),
      ...(activity.turnId ? { turnId: activity.turnId } : {}),
    }));

  return {
    ...state,
    activeActivities,
    activeChildSessionIds: activeActivities
      .map((activity) => activity.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== undefined),
  };
}

export function deriveWorkflowSessionLinks(
  snapshot: Pick<WorkflowRunSnapshot, "activities" | "runId">,
): WorkflowSessionLink[] {
  const attemptByScope = new Map<string, number>();
  return snapshot.activities.map((activity) => {
    const scope = [
      activity.phase,
      activity.nodeId ?? `phase:${activity.phase}`,
      activity.kind,
    ].join(":");
    const attempt = (attemptByScope.get(scope) ?? 0) + 1;
    attemptByScope.set(scope, attempt);
    return {
      activityId: activity.activityId,
      attempt,
      ...(activity.completedAt ? { completedAt: activity.completedAt } : {}),
      kind: activity.kind,
      ...(activity.model ? { model: activity.model } : {}),
      ...(activity.nodeId ? { nodeId: activity.nodeId } : {}),
      ...(activity.parentSessionId ? { parentSessionId: activity.parentSessionId } : {}),
      phase: activity.phase,
      runId: snapshot.runId,
      ...(activity.sessionId ? { sessionId: activity.sessionId } : {}),
      startedAt: activity.startedAt,
      status: workflowSessionLinkStatusFromActivity(activity.status),
      ...(activity.traceId ? { traceId: activity.traceId } : {}),
      ...(activity.turnId ? { turnId: activity.turnId } : {}),
    };
  });
}

function workflowSessionLinkStatusFromActivity(
  status: WorkflowNodeStatus,
): WorkflowSessionLinkStatus {
  switch (status) {
    case "active":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "skipped":
      return "cancelled";
    case "pending":
    default:
      return "starting";
  }
}

export interface WorkflowRunListItem {
  completedAt?: string;
  createdAt: string;
  cwd: string;
  kind: WorkflowKind;
  runId: string;
  status: WorkflowRunStatus;
  task: string;
  updatedAt: string;
}

export interface WorkflowStorePort {
  appendEvent(event: WorkflowEvent, options?: { signal?: AbortSignal }): Promise<void>;
  appendGraphRecord(
    runId: string,
    record: WorkflowGraphRecord,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  listRuns(
    options?: { cwd?: string; kind?: WorkflowKind; limit?: number },
    signalOptions?: { signal?: AbortSignal },
  ): Promise<WorkflowRunListItem[]>;
  readEvents(runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowEvent[]>;
  readLatestRun(
    options?: { cwd?: string; kind?: WorkflowKind },
    signalOptions?: { signal?: AbortSignal },
  ): Promise<WorkflowRunSnapshot | null>;
  readRun(runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowRunSnapshot | null>;
  writeArtifact(
    runId: string,
    relativePath: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }>;
  writeReport(
    runId: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }>;
  writeSnapshot(snapshot: WorkflowRunSnapshot, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface WorkflowDefinitionStorePort {
  listDefinitions(options?: { signal?: AbortSignal }): Promise<WorkflowDefinition[]>;
  readDefinition(
    definitionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowDefinition | null>;
}
