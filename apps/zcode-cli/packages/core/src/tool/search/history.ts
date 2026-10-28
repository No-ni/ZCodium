import {
  DEFERRED_TOOL_CALL_NAME,
  TOOL_SEARCH_NAME,
  type CompactBoundaryPayload,
  type ModelMessageContentBlock,
  type ModelToolCall,
  type ModelToolContract,
  type ResolvedToolSearchMode,
} from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  createLocalToolDefinitionRenderer,
  localToolsAlreadyLoadedReminder,
  localToolsLoadedReminder,
} from "./local-projection.js";

export function compactDiscoveryMetadata(
  boundary: Pick<CompactBoundaryPayload, "boundaryId" | "preCompactDiscoveredTools">,
) {
  return {
    boundaryId: boundary.boundaryId,
    preCompactDiscoveredTools: [...(boundary.preCompactDiscoveredTools ?? [])],
  };
}
export function collectToolSearchHistory(entries: readonly RuntimeMessageEntry[]) {
  const discovered = new Set<string>();
  const preCompactDiscoveredTools = new Set<string>();
  for (const entry of entries) {
    for (const name of entry.metadata?.compactBoundary?.preCompactDiscoveredTools ?? []) {
      discovered.add(name);
      preCompactDiscoveredTools.add(name);
    }
    if (
      entry.kind === "attachment" ||
      entry.message.role !== "tool" ||
      entry.message.isError ||
      entry.message.toolName !== TOOL_SEARCH_NAME
    )
      continue;
    if (!Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block.type === "tool_reference") discovered.add(block.toolName);
    }
  }
  return { discovered, preCompactDiscoveredTools };
}
export function collectDiscoveredTools(entries: readonly RuntimeMessageEntry[]): Set<string> {
  return collectToolSearchHistory(entries).discovered;
}

export function projectToolReferences(
  entries: readonly RuntimeMessageEntry[],
  mode: ResolvedToolSearchMode,
  tools: readonly ModelToolContract[],
  deferred: ReadonlySet<string> = new Set(),
): { entries: RuntimeMessageEntry[]; loadedToolCallIds: ReadonlySet<string> } {
  const catalog = mode === "off" ? undefined : new Map(tools.map((tool) => [tool.name, tool]));
  const renderDefinition = mode === "local" ? createLocalToolDefinitionRenderer() : undefined;
  const visible = new Set<string>();
  const pending = new Set<string>();
  const loadedToolCallIds = new Set<string>();
  const projected: RuntimeMessageEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "attachment" && entry.message.role === "assistant") {
      for (const name of pending) visible.add(name);
      pending.clear();
    }
    if (
      mode === "off" &&
      (entry.metadata?.toolSearchAnnouncement ||
        entry.metadata?.source === "tool_search_announcement")
    )
      continue;
    if (
      entry.kind === "attachment" ||
      entry.message.role !== "tool" ||
      !Array.isArray(entry.message.content)
    ) {
      projected.push(entry);
      continue;
    }
    const original = entry.message.content;
    let content: ModelMessageContentBlock[] | undefined;
    let definitions: string[] | undefined;
    const newlyLoaded = new Set<string>();
    const alreadyLoaded = new Set<string>();
    const successfulSearch = entry.message.toolName === TOOL_SEARCH_NAME && !entry.message.isError;
    for (let index = 0; index < original.length; index++) {
      const block = original[index]!;
      if (block.type !== "tool_reference") {
        if (definitions) {
          content!.push(localDefinitionsBlock(definitions));
          definitions = undefined;
        }
        content?.push(block);
        continue;
      }
      const tool = catalog?.get(block.toolName);
      if (tool && !renderDefinition) {
        if (successfulSearch && entry.message.toolCallId)
          loadedToolCallIds.add(entry.message.toolCallId);
        content?.push(block);
        continue;
      }
      content ??= original.slice(0, index);
      if (tool && renderDefinition) {
        if (successfulSearch && deferred.has(tool.name) && visible.has(tool.name)) {
          alreadyLoaded.add(tool.name);
        } else {
          (definitions ??= []).push(renderDefinition(tool));
          if (successfulSearch && deferred.has(tool.name)) newlyLoaded.add(tool.name);
        }
        // 同批 sibling tool results 尚未给模型看，下一 assistant 才推进已交付集合。
        if (successfulSearch) pending.add(tool.name);
      }
    }
    if (definitions) content!.push(localDefinitionsBlock(definitions));
    if (newlyLoaded.size)
      content!.push({ type: "text", text: localToolsLoadedReminder([...newlyLoaded]) });
    if (alreadyLoaded.size)
      content!.push({ type: "text", text: localToolsAlreadyLoadedReminder([...alreadyLoaded]) });
    projected.push(
      content === undefined
        ? entry
        : {
            ...entry,
            message: {
              ...entry.message,
              content: content.length
                ? content
                : [
                    {
                      type: "text",
                      text:
                        mode === "off"
                          ? "[Tool references removed - tool search not enabled]"
                          : "[Tool references removed - tools no longer available]",
                    },
                  ],
            },
          },
    );
  }
  return { entries: projectModelCallWrappers(projected, mode, deferred), loadedToolCallIds };
}

// Canonical 永远存真实 target + marker；包装只属于本次请求，callId和逐条providerOptions不改。
function projectModelCallWrappers(
  entries: readonly RuntimeMessageEntry[],
  mode: ResolvedToolSearchMode,
  deferred: ReadonlySet<string>,
): RuntimeMessageEntry[] {
  const wrapperById = new Map<string, string>();
  return entries.map((entry) => {
    if (entry.kind === "attachment") return entry;
    const message = entry.message;
    if (message.role === "assistant" && message.toolCalls?.some((call) => call.modelCallWrapper)) {
      const toolCalls = message.toolCalls.map((call): ModelToolCall => {
        if (!call.modelCallWrapper) return call;
        const { modelCallWrapper: _marker, ...canonical } = call;
        if (mode !== "local" || !deferred.has(call.name)) return canonical;
        wrapperById.set(call.id, DEFERRED_TOOL_CALL_NAME);
        return {
          ...canonical,
          name: DEFERRED_TOOL_CALL_NAME,
          input: { name: call.name, input: call.input },
        };
      });
      return { ...entry, message: { ...message, toolCalls } };
    }
    const wrapper =
      message.role === "tool" && message.toolCallId
        ? wrapperById.get(message.toolCallId)
        : undefined;
    return wrapper ? { ...entry, message: { ...message, toolName: wrapper } } : entry;
  });
}
function localDefinitionsBlock(definitions: readonly string[]): ModelMessageContentBlock {
  return { type: "text", text: `<functions>\n${definitions.join("\n")}\n</functions>` };
}
