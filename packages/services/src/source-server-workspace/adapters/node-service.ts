import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWorkspaceAliasApplication, confirmationBinding } from "../app/service.js";
import { z } from "zod";
import { WorkspaceAliasError } from "../contract.js";
import type { SourceServerWorkspaceService, WorkspaceAliasPreview } from "../contract.js";
import { deriveMerge } from "../domain/merge.js";
import {
  layout,
  inspectWorkspace,
  type AliasJob,
  type NodeWorkspaceAliasOptions,
} from "./inspection.js";
import { readAliases, readJob, saveJob, listScopeJobs, withOwner } from "./ledger.js";
import { executeJob } from "./execution.js";
import { restoreJob } from "./restore.js";
import { hash } from "./files.js";

export function createNodeSourceServerWorkspaceService(
  options: NodeWorkspaceAliasOptions,
): SourceServerWorkspaceService {
  const locations = layout(options);
  const secret = randomBytes(32);
  const signature = (payload: string) => createHmac("sha256", secret).update(payload).digest();
  const now = options.now ?? Date.now;
  return createWorkspaceAliasApplication({
    now,
    ttl: options.approvalTtlMs ?? 5 * 60_000,
    hash,
    inspect: async (scope, signal) =>
      inspectWorkspace(options, scope, await readAliases(locations), signal),
    sign(preview) {
      const payload = Buffer.from(
        JSON.stringify({
          binding: confirmationBinding(preview, { hash }),
          createdAt: preview.createdAt,
          expiresAt: preview.expiresAt,
        }),
      ).toString("base64url");
      return `${payload}.${signature(payload).toString("base64url")}`;
    },
    verify(token) {
      const [payload, encodedSignature, extra] = token.split(".");
      if (!payload || !encodedSignature || extra) throw new WorkspaceAliasError("plan-stale");
      const actual = Buffer.from(encodedSignature, "base64url");
      const expected = signature(payload);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new WorkspaceAliasError("plan-stale");
      // token只签冻结绑定字段；完整collision DTO随数据增大可能超过协议text上限。
      const bindingSchema = z
        .object({
          binding: z.string().regex(/^[a-f0-9]{64}$/),
          createdAt: z.number().int().nonnegative().safe(),
          expiresAt: z.number().int().nonnegative().safe(),
        })
        .strict();
      return bindingSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    },
    owner: (operation, signal) => withOwner(locations, operation, signal),
    async pending(scope) {
      const path = (await inspectWorkspace(options, scope, await readAliases(locations)))
        .normalizedPath;
      const jobs = await listScopeJobs(locations, scope.sourceServerId, path);
      return jobs.some((job) => !["completed", "restored"].includes(job.report.phase));
    },
    async approve(plan, request) {
      const jobs = await listScopeJobs(
        locations,
        request.sourceServerId,
        plan.inspection.normalizedPath,
      );
      const matching = jobs.find(
        (job) => job.report.planHash === request.planHash && job.report.phase !== "restored",
      );
      if (matching) return matching.report;
      if (jobs.some((job) => !["completed", "restored"].includes(job.report.phase)))
        throw new WorkspaceAliasError("state-diverged");
      const derived = deriveMerge(
        plan.inspection,
        plan.canonicalKey,
        plan.candidates,
        { hash },
        new Map(request.choices.map((choice) => [choice.collisionId, choice.sourceKey])),
      );
      const job: AliasJob = {
        plan,
        output: derived.output,
        choices: request.choices,
        configIndex: 0,
        restoreConfigIndex: 0,
        report: {
          sourceServerId: request.sourceServerId,
          workspacePath: request.workspacePath,
          sourceGeneration: request.sourceGeneration,
          jobId: randomUUID(),
          revision: 0,
          canonicalKey: plan.canonicalKey,
          mergedKeys: plan.candidates.filter((key) => key !== plan.canonicalKey),
          planHash: plan.preview.planHash,
          phase: "approved",
          status: "approved",
        },
      };
      await saveJob(locations, job);
      return job.report;
    },
    execute: (request, signal) => executeJob(locations, options, request, signal),
    report: async (jobId) => (await readJob(locations, jobId))?.report ?? null,
    restore: (request, signal) => restoreJob(locations, options, request, signal),
  });
}
export type { NodeWorkspaceAliasOptions } from "./inspection.js";
export type { WorkspaceAliasPreview };
