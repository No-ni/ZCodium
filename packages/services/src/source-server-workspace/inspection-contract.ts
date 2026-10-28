import { z } from "zod";
import { workspaceAliasScopeSchema, type WorkspaceAliasScope } from "./contract.js";

const baseSchema = workspaceAliasScopeSchema.extend({
  schemaVersion: z.literal(1),
  stableIdentity: z.string().min(1).max(8192),
});
export const sourceWorkspaceInspectionResultSchema = z.discriminatedUnion("state", [
  baseSchema.extend({ state: z.literal("clear") }).strict(),
  baseSchema
    .extend({
      state: z.literal("history-present"),
      reason: z.literal("source-workspace-history-present"),
    })
    .strict(),
  baseSchema
    .extend({
      state: z.literal("unavailable"),
      reason: z.enum([
        "source-workspace-inspection-unavailable",
        "source-workspace-inspection-stale",
      ]),
    })
    .strict(),
]);
export type SourceWorkspaceInspectionResult = z.infer<typeof sourceWorkspaceInspectionResultSchema>;
export const sourceWorkspaceInspectionCapabilitySchema = z
  .object({ version: z.literal(1) })
  .strict();
export type SourceWorkspaceInspectionCapability = z.infer<
  typeof sourceWorkspaceInspectionCapabilitySchema
>;
export interface ISourceWorkspaceInspectionService {
  getCapabilities(): Promise<SourceWorkspaceInspectionCapability>;
  inspect(scope: WorkspaceAliasScope): Promise<SourceWorkspaceInspectionResult>;
}
export const ISourceWorkspaceInspectionService = {
  channelName: "source-workspace-inspection",
  _brand: undefined as ISourceWorkspaceInspectionService | undefined,
} as const;
