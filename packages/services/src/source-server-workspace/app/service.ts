import type {
  WorkspaceAliasAuthority,
  WorkspaceAliasConfirmation,
  WorkspaceAliasJobRequest,
  WorkspaceAliasPreview,
  WorkspaceAliasReport,
  WorkspaceAliasRestoreRequest,
  WorkspaceAliasScope,
  SourceServerWorkspaceService,
} from "../contract.js";
import {
  WorkspaceAliasError,
  workspaceAliasConfirmationSchema,
  workspaceAliasJobRequestSchema,
  workspaceAliasRestoreRequestSchema,
  workspaceAliasScopeSchema,
} from "../contract.js";
import { buildPlan } from "../domain/plan.js";
import { deriveMerge } from "../domain/merge.js";
import type { MergePlan, WorkspaceInspection } from "../domain/images.js";

export interface WorkspaceAliasApplicationPort {
  now(): number;
  ttl: number;
  inspect(scope: WorkspaceAliasScope, signal?: AbortSignal): Promise<WorkspaceInspection>;
  sign(preview: WorkspaceAliasPreview): string;
  verify(token: string): { binding: string; createdAt: number; expiresAt: number };
  hash(value: unknown): string;
  owner<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  approve(plan: MergePlan, request: WorkspaceAliasConfirmation): Promise<WorkspaceAliasReport>;
  pending(scope: WorkspaceAliasScope): Promise<boolean>;
  execute(request: WorkspaceAliasJobRequest, signal?: AbortSignal): Promise<WorkspaceAliasReport>;
  report(jobId: string): Promise<WorkspaceAliasReport | null>;
  restore(
    request: WorkspaceAliasRestoreRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceAliasReport>;
}
export function confirmationBinding(
  value: Pick<
    WorkspaceAliasConfirmation,
    | "sourceServerId"
    | "workspacePath"
    | "sourceGeneration"
    | "canonicalKey"
    | "candidateVersion"
    | "planHash"
  >,
  port: Pick<WorkspaceAliasApplicationPort, "hash">,
): string {
  return port.hash({
    sourceServerId: value.sourceServerId,
    workspacePath: value.workspacePath,
    sourceGeneration: value.sourceGeneration,
    canonicalKey: value.canonicalKey,
    candidateVersion: value.candidateVersion,
    planHash: value.planHash,
  });
}
export function createWorkspaceAliasApplication(
  port: WorkspaceAliasApplicationPort,
): SourceServerWorkspaceService {
  async function preview(
    scope: WorkspaceAliasScope,
    signal?: AbortSignal,
  ): Promise<WorkspaceAliasPreview> {
    const input = workspaceAliasScopeSchema.parse(scope);
    const plan = buildPlan(await port.inspect(input, signal), port, port.now(), port.ttl);
    plan.preview.confirmationToken = port.sign(plan.preview);
    return plan.preview;
  }
  return {
    preview: (scope, options) => preview(scope, options?.signal),
    async getResolvedWorkspace(scope, options) {
      const plan = await preview(scope, options?.signal);
      const pending = await port.pending(scope);
      const state =
        pending || plan.state === "blocked"
          ? "blocked"
          : plan.state === "confirmation-required"
            ? "confirmation-required"
            : "ready";
      return {
        state,
        stableIdentity: plan.stableIdentity,
        ...(state === "ready" ? { canonicalKey: plan.canonicalKey } : {}),
        persisted: plan.state === "resolved" && !pending,
        preview: plan,
      };
    },
    async confirm(raw, options) {
      const request = workspaceAliasConfirmationSchema.parse(raw);
      return port.owner(async () => {
        const signed = port.verify(request.confirmationToken);
        if (signed.expiresAt <= port.now() || signed.binding !== confirmationBinding(request, port))
          throw new WorkspaceAliasError("plan-stale");
        const scope = workspaceAliasScopeSchema.parse({
          sourceServerId: request.sourceServerId,
          workspacePath: request.workspacePath,
        });
        const plan = buildPlan(
          await port.inspect(scope, options?.signal),
          port,
          signed.createdAt,
          port.ttl,
        );
        if (
          plan.preview.planHash !== request.planHash ||
          plan.preview.candidateVersion !== request.candidateVersion ||
          signed.expiresAt <= port.now()
        )
          throw new WorkspaceAliasError("plan-stale");
        if (plan.preview.blocks.length) throw new WorkspaceAliasError(plan.preview.blocks[0]!.code);
        const choices = new Map(
          request.choices.map((choice) => [choice.collisionId, choice.sourceKey]),
        );
        if (
          choices.size !== request.choices.length ||
          request.choices.some(
            (choice) =>
              !plan.collisions.some(
                (collision) =>
                  collision.collisionId === choice.collisionId &&
                  collision.sources.some((source) => source.workspaceKey === choice.sourceKey),
              ),
          ) ||
          plan.collisions.some((collision) => !choices.has(collision.collisionId))
        )
          throw new WorkspaceAliasError("collision-unresolved");
        const derived = deriveMerge(
          plan.inspection,
          plan.canonicalKey,
          plan.candidates,
          port,
          choices,
        );
        if (derived.blocks.length) throw new WorkspaceAliasError(derived.blocks[0]!.code);
        options?.signal?.throwIfAborted();
        return port.approve(plan, request);
      }, options?.signal);
    },
    execute: (raw, options) =>
      port.execute(workspaceAliasJobRequestSchema.parse(raw), options?.signal),
    retry: (raw, options) =>
      port.execute(workspaceAliasJobRequestSchema.parse(raw), options?.signal),
    report: (jobId) => port.report(jobId),
    restore: (raw, options) =>
      port.restore(workspaceAliasRestoreRequestSchema.parse(raw), options?.signal),
  };
}
export type { WorkspaceAliasAuthority };
