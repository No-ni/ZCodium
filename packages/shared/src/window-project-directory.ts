import { z } from "zod";
import { webRemoteControlWorkspaceKindSchema } from "./webRemoteControl/envelope.js";

const text = z.string().trim().min(1);
export const windowProjectDirectoryEntrySchema = z
  .object({
    workspaceKey: text,
    workspacePath: text,
    workspaceIdentity: text.optional(),
    remoteSessionId: text.optional(),
    kind: webRemoteControlWorkspaceKindSchema,
    connectionState: z.enum(["connected", "connecting", "disconnected"]).optional(),
    label: z.string().optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.workspaceKey !== (entry.workspaceIdentity?.trim() || entry.workspacePath)) {
      context.addIssue({
        code: "custom",
        message: "Window directory key does not match its identity",
        path: ["workspaceKey"],
      });
    }
    if (entry.remoteSessionId && (entry.kind !== "remote" || !entry.workspaceIdentity)) {
      context.addIssue({
        code: "custom",
        message: "Remote directory entries require a full identity",
        path: ["remoteSessionId"],
      });
    }
  });
export type WindowProjectDirectoryEntry = z.infer<typeof windowProjectDirectoryEntrySchema>;
export const windowProjectDirectorySnapshotSchema = z
  .object({
    version: z.literal(1),
    generation: z.number().int().nonnegative(),
    workspaces: z.array(windowProjectDirectoryEntrySchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const keys = new Set<string>();
    for (const [index, workspace] of snapshot.workspaces.entries()) {
      if (keys.has(workspace.workspaceKey))
        context.addIssue({
          code: "custom",
          message: "Duplicate Window directory identity",
          path: ["workspaces", index, "workspaceKey"],
        });
      keys.add(workspace.workspaceKey);
    }
  });
export type WindowProjectDirectorySnapshot = z.infer<typeof windowProjectDirectorySnapshotSchema>;
export const hostWindowProjectDirectoryProjectionSchema = z
  .object({
    type: z.literal("window-project-directory-projection"),
    projection: windowProjectDirectorySnapshotSchema,
  })
  .strict();
export const windowProjectDirectoryCapabilitySchema = z.object({ version: z.literal(1) }).strict();
