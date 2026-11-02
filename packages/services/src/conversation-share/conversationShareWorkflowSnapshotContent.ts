import { basename, extname } from "node:path";
import {
  shareWorkflowRunSchema,
  type ShareWorkflowPayload,
  type ConversationShareCapabilities,
} from "@zcode/shared";
import {
  type WorkflowRunsState,
  type WorkflowRunArtifactSummary,
  type WorkflowRunArtifactVersion,
} from "@zcode/shared/zcode-protocol-v4";

/** 只保留 schema 认可的键，未定义值不进入分享快照，避免内部字段外泄。 */
function pick(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => keys.includes(key) && entry !== undefined),
  );
}

/** 用分享协议 schema 裁剪 run；actors/nodes 逐个再过一遍，只留认得的字段。 */
export function projectShareWorkflowRun(run: WorkflowRunsState["runs"][number]) {
  return shareWorkflowRunSchema.parse({
    ...pick(run, Object.keys(shareWorkflowRunSchema.shape)),
    actors: run.actors.map((actor) =>
      pick(actor, Object.keys(shareWorkflowRunSchema.shape.actors.element.shape)),
    ),
    nodes: run.nodes.map((node) =>
      pick(node, Object.keys(shareWorkflowRunSchema.shape.nodes.element.shape)),
    ),
  });
}

/** 合成摘要只用于展示：拼名称、状态、阶段、参与者与产物清单，不改写业务含义。 */
export function buildWorkflowShareSummary(payload: ShareWorkflowPayload): string {
  const status = payload.run?.status ?? "unavailable";
  return [
    payload.name,
    `Workflow · ${status}`,
    ...(payload.summary ? [payload.summary] : []),
    ...(payload.run?.phases?.map((phase) => phase.name) ?? []),
    ...(payload.run?.actors.map((actor) => actor.name ?? actor.siteId) ?? []),
    ...payload.artifacts.map(
      (artifact) => `${artifact.title}${artifact.unavailable ? " (未包含 / not included)" : ""}`,
    ),
    ...(payload.unavailable ? ["Workflow snapshot unavailable / 工作流快照不可用"] : []),
  ].join("\n\n");
}

/** 产物卡片基座：标题/描述取最新版，版本号以状态键 summary 为准。 */
export function buildArtifactBase(
  summary: WorkflowRunArtifactSummary,
  version: WorkflowRunArtifactVersion | undefined,
) {
  return {
    id: summary.id,
    kind: summary.kind,
    title: version?.title ?? summary.title ?? summary.id,
    version: summary.version,
    ...(summary.primary ? { primary: true as const } : {}),
    ...(version?.description ? { description: version.description } : {}),
  };
}

/** 文件类产物的 MIME 与扩展名：contentType 缺省按 kind 兜底，扩展名从 sourcePath 取。 */
export function resolveArtifactMimeAndExtension(
  kind: WorkflowRunArtifactSummary["kind"],
  version: WorkflowRunArtifactVersion,
): { mime: string; extension: string } {
  const mime =
    version.contentType ?? (kind === "markdown" ? "text/markdown" : "application/octet-stream");
  const extension = extname(version.sourcePath ?? "").slice(1) || (kind === "markdown" ? "md" : "");
  return { mime, extension };
}

/** 标题里的版本号不是文件类型；仅已有正确后缀时不再重复追加。 */
export function buildArtifactDisplayName(title: string, extension: string): string {
  const safeTitle = basename(title).replace(/[\\/]/gu, "_") || "artifact";
  return safeTitle.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
    ? safeTitle
    : `${safeTitle}.${extension}`;
}

/** v2 内容块下的文本预览：非文本、超限或未启用时返回空对象。 */
function buildArtifactPreviewText(
  capabilities: ConversationShareCapabilities,
  mime: string,
  data: Uint8Array,
) {
  if ((capabilities.content_block_versions?.workflow ?? 0) < 2) return {};
  if (mime !== "text/markdown" && mime !== "text/plain") return {};
  if (data.length > 65536) return {};
  return {
    preview_text: new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(data),
  };
}

/** 文件类产物条目：挂 resource_id、content_type，并按条件附 preview_text。 */
export function buildFileArtifact(
  base: ReturnType<typeof buildArtifactBase>,
  resourceId: string,
  mime: string,
  data: Uint8Array,
  capabilities: ConversationShareCapabilities,
) {
  return {
    ...base,
    kind: base.kind,
    resource_id: resourceId,
    content_type: mime,
    ...buildArtifactPreviewText(capabilities, mime, data),
    bytes: data.length,
  };
}
