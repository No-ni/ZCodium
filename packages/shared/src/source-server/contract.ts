import { z } from "zod";

const text = z.string().trim().min(1);
const id = text.regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.number().int().nonnegative();

export const sourceServerProfileTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ssh"),
      host: text,
      port: z.number().int().positive().max(65_535).optional(),
      username: text,
      sshConfigAlias: text.optional(),
      privateKeyPath: text.optional(),
      passwordCredentialKey: text.optional(),
      privateKeyPassphraseCredentialKey: text.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("wsl"), distro: text.optional(), user: text.optional() }).strict(),
  z.object({ kind: z.literal("docker"), container: text }).strict(),
]);
export type SourceServerProfileTarget = z.infer<typeof sourceServerProfileTargetSchema>;
export const connectionProfileSchema = z
  .object({
    profileId: id,
    generation: z.number().int().positive(),
    sourceServerId: id.optional(),
    displayName: text,
    target: sourceServerProfileTargetSchema,
    configurationMode: z.enum(["target", "mirror-personal"]).default("target"),
    createdAt: timestamp,
    lastConnectedAt: timestamp.optional(),
  })
  .strict();
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;
export const sourceServerRecordSchema = z
  .object({
    sourceServerId: id,
    displayName: text,
    version: text,
    preferredProfileId: id.optional(),
    lastOnlineAt: timestamp,
  })
  .strict();
export type SourceServerRecord = z.infer<typeof sourceServerRecordSchema>;
export const sourceServerDirectorySchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.number().int().nonnegative(),
    profiles: z.array(connectionProfileSchema),
    servers: z.array(sourceServerRecordSchema),
  })
  .strict();
export type SourceServerDirectorySnapshot = z.infer<typeof sourceServerDirectorySchema>;
export const sourceServerConnectionStateSchema = z.enum([
  "absent",
  "connecting",
  "needs-install",
  "needs-start",
  "needs-upgrade",
  "identity-change-pending",
  "online",
  "offline",
  "failed",
]);
export const sourceServerConnectionStateSnapshotSchema = z
  .object({
    profileId: id,
    generation: z.number().int().positive(),
    sourceServerId: id.optional(),
    pendingSourceServerId: id.optional(),
    state: sourceServerConnectionStateSchema,
    errorCode: z
      .enum([
        "source-server-install-required",
        "source-server-start-required",
        "source-server-upgrade-required",
        "source-server-identity-change-pending",
        "source-server-profile-stale",
        "source-server-connection-failed",
        "source-server-configuration-sync-failed",
      ])
      .optional(),
    updatedAt: timestamp,
  })
  .strict();
export type SourceServerConnectionStateSnapshot = z.infer<
  typeof sourceServerConnectionStateSnapshotSchema
>;
export const sourceServerProfileOperationSchema = z
  .object({
    profileId: id,
    generation: z.number().int().positive(),
  })
  .strict();
export type SourceServerProfileOperation = z.infer<typeof sourceServerProfileOperationSchema>;
export const sourceServerIdentityConfirmationSchema = sourceServerProfileOperationSchema
  .extend({
    expectedSourceServerId: id,
  })
  .strict();
export type SourceServerIdentityConfirmation = z.infer<
  typeof sourceServerIdentityConfirmationSchema
>;
export const sourceServerDisconnectSchema = z.object({ sourceServerId: id }).strict();
export const sourceServerManagementSnapshotSchema = z
  .object({
    directory: sourceServerDirectorySchema,
    states: z.array(sourceServerConnectionStateSnapshotSchema),
  })
  .strict();
export type SourceServerManagementSnapshot = z.infer<typeof sourceServerManagementSnapshotSchema>;
export interface SourceServerDirectoryContract {
  snapshot(): Promise<SourceServerDirectorySnapshot>;
  saveProfile(profile: ConnectionProfile): Promise<ConnectionProfile>;
  removeProfile(profileId: string, expectedGeneration: number): Promise<void>;
}
