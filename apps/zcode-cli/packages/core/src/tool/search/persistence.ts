import {
  ModelCallWrapperSchema,
  PersistedToolSearchContentSchema,
  ToolSearchAnnouncementSchema,
  TOOL_SEARCH_NAME,
  compactBoundaryPayloadSchema,
  type ModelMessageContent,
  type ToolPart,
} from "@zcode/contracts";
import type { RuntimeMessageMetadata } from "../../agent/message-history.js";

const discoveryMetadataSchema = compactBoundaryPayloadSchema.pick({
  boundaryId: true,
  preCompactDiscoveredTools: true,
});

export function restoredModelCallWrapper(metadata: Record<string, unknown> | undefined) {
  const marker = ModelCallWrapperSchema.safeParse(metadata?.modelCallWrapper);
  return marker.success ? marker.data : undefined;
}

export function restoredToolSearchContent(part: ToolPart): ModelMessageContent | undefined {
  if (part.tool !== TOOL_SEARCH_NAME || part.state.status !== "completed") return undefined;
  // 新版 canonical 与旧本仓字段都只在成功的 ToolSearch 结果上接受严格 schema。
  for (const value of [part.state.metadata?.modelContent, part.state.metadata?.toolSearchContent]) {
    const parsed = PersistedToolSearchContentSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function restoredToolSearchMetadata(
  metadata: Record<string, unknown> | undefined,
): Pick<RuntimeMessageMetadata, "toolSearchAnnouncement" | "compactBoundary"> {
  const announcement = ToolSearchAnnouncementSchema.safeParse(metadata?.toolSearchAnnouncement);
  const boundary = discoveryMetadataSchema.safeParse(metadata?.compactBoundary);
  return {
    ...(announcement.success ? { toolSearchAnnouncement: announcement.data } : {}),
    ...(boundary.success ? { compactBoundary: boundary.data } : {}),
  };
}
