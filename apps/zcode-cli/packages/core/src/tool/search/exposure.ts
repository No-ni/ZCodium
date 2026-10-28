import {
  DEFERRED_TOOL_CALL_NAME,
  TOOL_SEARCH_NAME,
  type Model,
  type ModelToolContract,
  type ResolvedToolSearchMode,
  type ToolSearchCandidate,
  type ToolSearchExecutionContext,
  type ToolSearchMode,
} from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolMetadata } from "../types.js";
import { LOCAL_TOOL_SEARCH_DESCRIPTION } from "./description.js";
import { collectToolSearchHistory, projectToolReferences } from "./history.js";

export function resolveToolSearchMode(
  model: Model,
  mode: ToolSearchMode = "off",
): ResolvedToolSearchMode {
  const capability = model.requestCapabilities?.toolSearch;
  if (mode === "off") return "off";
  if (mode === "native") {
    if (!capability?.protocolSupported)
      throw new Error("Native ToolSearch requires a supported Anthropic Messages wire.");
    return "native";
  }
  if (mode === "auto" && capability?.protocolSupported && capability.defaultEnabled)
    return "native";
  if (model.properties.supportsToolCall) return "local";
  if (mode === "local")
    throw new Error("Local ToolSearch requires a model that supports tool calls.");
  return "off";
}
export function isDeferredTool(tool: ModelToolContract, metadata?: ToolMetadata): boolean {
  return (
    tool.name !== TOOL_SEARCH_NAME &&
    tool.name !== DEFERRED_TOOL_CALL_NAME &&
    !tool.providerNative &&
    metadata?.alwaysLoad !== true &&
    (metadata?.shouldDefer === true || metadata?.mcpPresentation !== undefined)
  );
}
interface ToolExposureInput {
  model: Model;
  mode?: ToolSearchMode;
  tools: readonly ModelToolContract[];
  registry?: Pick<ToolRegistry, "get">;
  entries: readonly RuntimeMessageEntry[];
}
function resolveCatalog(input: ToolExposureInput, preCompactDiscoveredTools: ReadonlySet<string>) {
  const requestedMode = resolveToolSearchMode(input.model, input.mode);
  let hasConfiguredDeferred = false;
  const catalog: ToolSearchCandidate[] = input.tools
    .filter((tool) => requestedMode === "local" || tool.name !== DEFERRED_TOOL_CALL_NAME)
    .map((tool) => {
      const entry = input.registry?.get(tool.name);
      const configuredDeferred = isDeferredTool(tool, entry?.metadata);
      hasConfiguredDeferred ||= configuredDeferred;
      return {
        name: tool.name,
        aliases: entry?.aliases,
        description: tool.description,
        searchHint: entry?.metadata.searchHint,
        mcp: entry?.metadata.mcpPresentation,
        deferred:
          configuredDeferred &&
          !(requestedMode === "local" && preCompactDiscoveredTools.has(tool.name)),
      };
    });
  const controlsAvailable =
    catalog.some((tool) => tool.name === TOOL_SEARCH_NAME) &&
    (requestedMode !== "local" || catalog.some((tool) => tool.name === DEFERRED_TOOL_CALL_NAME));
  const enabled = requestedMode !== "off" && hasConfiguredDeferred && controlsAvailable;
  const mode: ResolvedToolSearchMode = enabled ? requestedMode : "off";
  const deferred = new Set(catalog.filter((tool) => tool.deferred).map((tool) => tool.name));
  return {
    catalog,
    enabled,
    mode,
    deferred,
    reason: enabled
      ? mode
      : requestedMode === "off"
        ? "disabled"
        : !hasConfiguredDeferred
          ? "no_deferred_tools"
          : "tool_unavailable",
  };
}
export function buildToolExposure(input: ToolExposureInput) {
  const { discovered, preCompactDiscoveredTools } = collectToolSearchHistory(input.entries);
  const { catalog, enabled, mode, deferred, reason } = resolveCatalog(
    input,
    preCompactDiscoveredTools,
  );
  const tools = input.tools
    .filter((tool) => {
      if (tool.name === TOOL_SEARCH_NAME) return enabled;
      if (tool.name === DEFERRED_TOOL_CALL_NAME) return mode === "local";
      return (
        mode === "off" ||
        !deferred.has(tool.name) ||
        (mode === "native" && discovered.has(tool.name))
      );
    })
    .map((tool) => {
      const { deferLoading: _previous, ...contract } = tool;
      if (mode === "local" && tool.name === TOOL_SEARCH_NAME)
        return { ...contract, description: LOCAL_TOOL_SEARCH_DESCRIPTION };
      return mode === "native" && deferred.has(tool.name)
        ? { ...contract, deferLoading: true }
        : contract;
    });
  const projection = projectToolReferences(
    input.entries,
    mode,
    mode === "local" ? [...input.tools, ...tools] : tools,
    deferred,
  );
  const context: ToolSearchExecutionContext = { mode, enabled, catalog, discovered };
  return { tools, ...projection, enabled, context, reason };
}
export function buildToolSearchAnnouncement(
  input: ToolExposureInput,
  compactDiscoveredTools?: ReadonlySet<string>,
): RuntimeMessageEntry | undefined {
  if (resolveToolSearchMode(input.model, input.mode) === "off") return undefined;
  const { preCompactDiscoveredTools } = collectToolSearchHistory(input.entries);
  for (const name of compactDiscoveredTools ?? []) preCompactDiscoveredTools.add(name);
  const { enabled, deferred, mode } = resolveCatalog(input, preCompactDiscoveredTools);
  if (!enabled) return undefined;
  const announced = new Set<string>();
  for (const entry of input.entries) {
    for (const name of entry.metadata?.toolSearchAnnouncement?.addedNames ?? [])
      announced.add(name);
    for (const name of entry.metadata?.toolSearchAnnouncement?.removedNames ?? [])
      announced.delete(name);
  }
  const addedNames = [...deferred].filter((name) => !announced.has(name)).sort();
  const available = new Set(input.tools.map((tool) => tool.name));
  const removedNames = [...announced].filter((name) => !available.has(name)).sort();
  if (!addedNames.length && !removedNames.length) return undefined;
  const lines = [
    ...(addedNames.length
      ? [
          `Deferred tools available via ${TOOL_SEARCH_NAME}:\n${addedNames.join("\n")}`,
          mode === "local"
            ? `Load their complete schema, then call ${DEFERRED_TOOL_CALL_NAME} {name, input}. Call resident tools directly.`
            : "Load their schema, then call them directly.",
        ]
      : []),
    ...(removedNames.length ? [`Tools no longer available:\n${removedNames.join("\n")}`] : []),
    "Discovery is not authorization. Keep normal hooks and permission checks. This is ambient context; do not narrate it unless relevant.",
  ];
  return {
    kind: "attachment",
    content: lines.join("\n\n"),
    metadata: {
      source: "tool_search_announcement",
      toolSearchAnnouncement: { addedNames, removedNames, readdedNames: [] },
    },
  };
}
