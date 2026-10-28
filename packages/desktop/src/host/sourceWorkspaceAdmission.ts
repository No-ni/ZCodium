import {
  sourceWorkspaceInspectionResultSchema,
  sourceWorkspaceInspectionCapabilitySchema,
  type ISourceWorkspaceInspectionService,
  type WorkspaceAliasScope,
} from "@zcode/services/source-server-workspace";
import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";

export async function assertSourceWorkspaceAdmission(options: {
  service?: ISourceWorkspaceInspectionService;
  scope: WorkspaceAliasScope;
  signal?: AbortSignal;
  assertCurrent(): Promise<void>;
}): Promise<void> {
  options.signal?.throwIfAborted();
  await options.assertCurrent();
  if (!options.service) throw new Error("Source 工作区只读检查能力不可用，请先手动更新 Source");
  const capability = sourceWorkspaceInspectionCapabilitySchema.safeParse(
    await options.service.getCapabilities(),
  );
  if (!capability.success) throw new Error("Source 工作区只读检查版本不可用");
  options.signal?.throwIfAborted();
  const parsed = sourceWorkspaceInspectionResultSchema.safeParse(
    await options.service.inspect(options.scope),
  );
  options.signal?.throwIfAborted();
  await options.assertCurrent();
  if (
    !parsed.success ||
    parsed.data.sourceServerId !== options.scope.sourceServerId ||
    parsed.data.workspacePath !== options.scope.workspacePath ||
    parsed.data.stableIdentity !==
      buildServerRemoteWorkspaceIdentity({
        serverId: options.scope.sourceServerId,
        workspacePath: options.scope.workspacePath,
      })
  )
    throw new Error("Source 工作区只读检查结果不可信");
  // clear 只接纳本次 attachment；历史或未知介质没有全根停写证明，不能自动迁移或忽略。
  if (parsed.data.state === "history-present")
    throw new Error("Source 存在潜在旧历史；安全迁移能力尚未接入，已阻断工作区访问");
  if (parsed.data.state !== "clear")
    throw new Error("Source 工作区历史范围无法安全检查，已阻断工作区访问");
}
