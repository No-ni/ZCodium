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
  const parsed = PersistedToolSearchContentSchema.safeParse(part.state.metadata?.toolSearchContent);
  return parsed.success ? parsed.data : undefined;
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
