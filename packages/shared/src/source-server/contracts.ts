// Profile、连接代际与快照只由本仓契约定义，附加 DTO 不得建立第二套事实。
import {
  sourceServerProfileTargetSchema,
  sourceServerConnectionStateSchema,
  sourceServerConnectionStateSnapshotSchema,
  type SourceServerProfileTarget,
} from "./contract.js";
export const sshProfileTargetSchema = sourceServerProfileTargetSchema.options[0];
export const wslProfileTargetSchema = sourceServerProfileTargetSchema.options[1];
export const dockerProfileTargetSchema = sourceServerProfileTargetSchema.options[2];
export type SSHProfileTarget = Extract<SourceServerProfileTarget, { kind: "ssh" }>;
export type WSLProfileTarget = Extract<SourceServerProfileTarget, { kind: "wsl" }>;
export type DockerProfileTarget = Extract<SourceServerProfileTarget, { kind: "docker" }>;
import { z } from "zod";
import type { RemoteTarget } from "#src/remoteTarget.js";
import { wslUserSchema } from "../wslUserValidation.js";
import { serverRemoteWorkspaceInfoSchema } from "../server-remote.js";

const nonEmptyStringSchema = z.string().trim().min(1);
const timestampSchema = z.number().int().nonnegative();

export const sourceServerTransportKindSchema = z.enum(["ssh", "wsl", "docker"]);
export type SourceServerTransportKind = z.infer<typeof sourceServerTransportKindSchema>;

/** 升级授权只绑定执行身份，不携带凭据或可变 Profile 内容。 */
export const sourceServerUpdateTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ssh"),
      host: nonEmptyStringSchema.toLowerCase(),
      port: z.number().int().positive().max(65_535).default(22),
      username: nonEmptyStringSchema,
      sshConfigAlias: nonEmptyStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wsl"),
      distro: nonEmptyStringSchema,
      user: wslUserSchema.refine((value) => value.length > 0),
    })
    .strict(),
  dockerProfileTargetSchema,
]);
export type SourceServerUpdateTarget = z.infer<typeof sourceServerUpdateTargetSchema>;

export function getSourceServerUpdateTarget(
  target: Exclude<RemoteTarget, { kind: "server" }>,
): SourceServerUpdateTarget {
  switch (target.kind) {
    case "ssh":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
      });
    case "wsl":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        distro: target.distro,
        user: target.user,
      });
    case "docker":
      return sourceServerUpdateTargetSchema.parse({
        kind: target.kind,
        container: target.container,
      });
  }
}

export function isSameSourceServerUpdateTarget(
  left: Exclude<RemoteTarget, { kind: "server" }>,
  right: Exclude<RemoteTarget, { kind: "server" }>,
): boolean {
  if (
    [left, right].some(
      (target) => target.kind === "wsl" && (!target.distro?.trim() || !target.user?.trim()),
    )
  )
    return false;
  return (
    JSON.stringify(getSourceServerUpdateTarget(left)) ===
    JSON.stringify(getSourceServerUpdateTarget(right))
  );
}

/**
 * 设备级生命周期操作（停止、重启远端服务，RDLC-01）只接收设备身份；具体走哪条连接由 Host 路由，
 * Renderer 不传 profileId。
 */
export const sourceServerLifecycleSourceIdSchema = nonEmptyStringSchema.regex(/^[A-Za-z0-9_-]+$/);

export const sourceServerWorkspaceHistoryEntrySchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
    legacyWorkspaceIdentity: nonEmptyStringSchema.optional(),
    profileId: nonEmptyStringSchema.regex(/^[A-Za-z0-9_-]+$/),
    sourceServerId: nonEmptyStringSchema.regex(/^[A-Za-z0-9_-]+$/).optional(),
    lastOpenedAt: timestampSchema,
  })
  .strict();

export type SourceServerWorkspaceHistoryEntry = z.infer<
  typeof sourceServerWorkspaceHistoryEntrySchema
>;

export const sourceServerMigrationConflictSchema = z
  .object({
    kind: z.enum(["task-identity", "config-file"]),
    key: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema.optional(),
    relativePath: nonEmptyStringSchema.optional(),
    sourceKey: nonEmptyStringSchema,
    canonicalKey: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
  })
  .strict();
export type SourceServerMigrationConflict = z.infer<typeof sourceServerMigrationConflictSchema>;

export const sourceServerMigrationReportRowSchema = z
  .object({
    migrationId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    canonicalKey: nonEmptyStringSchema,
    variantKeys: z.array(nonEmptyStringSchema),
    status: z.enum(["running", "completed", "failed", "abandoned", "abandoned-diverged"]),
    phase: nonEmptyStringSchema.optional(),
    errorCode: nonEmptyStringSchema.optional(),
    taskBackupPath: nonEmptyStringSchema.optional(),
    sessionBackupPath: nonEmptyStringSchema.optional(),
    updatedAt: timestampSchema,
    abandonedAt: timestampSchema.optional(),
    abandonedTrigger: nonEmptyStringSchema.optional(),
    conflicts: z.array(sourceServerMigrationConflictSchema),
  })
  .strict();
export type SourceServerMigrationReportRow = z.infer<typeof sourceServerMigrationReportRowSchema>;

export const sourceServerMigrationReportSchema = z
  .object({ rows: z.array(sourceServerMigrationReportRowSchema) })
  .strict();
export type SourceServerMigrationReport = z.infer<typeof sourceServerMigrationReportSchema>;

export const sourceServerMigrationPathActionSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    migrationId: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerMigrationPathAction = z.infer<typeof sourceServerMigrationPathActionSchema>;

export const sourceServerResolveWorkspaceRequestSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    legacyRouteHint: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerResolveWorkspaceRequest = z.infer<
  typeof sourceServerResolveWorkspaceRequestSchema
>;

export const sourceServerResolveWorkspaceResultSchema = z
  .object({
    canonicalWorkspaceKey: nonEmptyStringSchema,
    mergedKeys: z.array(nonEmptyStringSchema),
    migrationId: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerResolveWorkspaceResult = z.infer<
  typeof sourceServerResolveWorkspaceResultSchema
>;
export type SourceServerConnectionState = z.infer<typeof sourceServerConnectionStateSchema>;

/** 远端任务 owner 的活动投影；身份用于隔离，实际路径仅用于展示。 */
export const sourceServerRunningTaskSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();
export type SourceServerRunningTask = z.infer<typeof sourceServerRunningTaskSchema>;
export const sourceServerRunningTasksSchema = z.array(sourceServerRunningTaskSchema);

/**
 * 停止 / 重启远端服务确认前按设备读取的运行中任务（RDLC-01）。`available: false` 表示设备没有提供
 * 可信清单（远端输出 null、命令失败或输出不符 schema），不能当作“没有任务”；空数组才是没有任务。
 */
export const sourceServerRunningTasksResultSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true), tasks: sourceServerRunningTasksSchema }).strict(),
  z.object({ available: z.literal(false) }).strict(),
]);
export type SourceServerRunningTasksResult = z.infer<typeof sourceServerRunningTasksResultSchema>;

export const sourceServerManagementSnapshotRequestSchema = z
  .object({
    refreshMigrationCounts: z.boolean().optional(),
  })
  .strict();
export type SourceServerManagementSnapshotRequest = z.infer<
  typeof sourceServerManagementSnapshotRequestSchema
>;

export const sourceServerManagementStateDeltaSchema = z
  .object({
    generation: z.number().int().positive(),
    state: sourceServerConnectionStateSnapshotSchema,
  })
  .strict();
export type SourceServerManagementStateDelta = z.infer<
  typeof sourceServerManagementStateDeltaSchema
>;

export const sourceServerManagementDirectoryDeltaSchema = z
  .object({
    generation: z.number().int().positive(),
  })
  .strict();
export type SourceServerManagementDirectoryDelta = z.infer<
  typeof sourceServerManagementDirectoryDeltaSchema
>;

export const sourceServerOperationLogSchema = z
  .object({
    profileId: nonEmptyStringSchema.regex(/^[A-Za-z0-9_-]+$/),
    operation: z.enum(["connect", "update", "stop", "restart"]),
    phase: nonEmptyStringSchema,
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
    progress: z.number().min(0).max(1).optional(),
    timestamp: timestampSchema,
  })
  .strict();
export type SourceServerOperationLog = z.infer<typeof sourceServerOperationLogSchema>;

export type SourceServerDeclaredWorkspaceWire = z.infer<typeof serverRemoteWorkspaceInfoSchema>;
