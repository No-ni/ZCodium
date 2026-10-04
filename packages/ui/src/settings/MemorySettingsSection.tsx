import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type IMemoryService, type ProjectMemoryWorkspaceSummary } from "@zcode/services";
import { TID_SETTINGS_MEMORY_SWITCH, ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { ModelSelection } from "@zcode/shared/model-selection";

import { ModelConfigSelect, type ModelSelectFooterAction } from "@/ModelConfigSelect.js";
import {
  buildRegistryModelSelectGroups,
  resolveModelDisplayName,
} from "@/lib/modelSelectionGroups.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import {
  MemorySettingsViewer,
  type MemoryViewerLoadingState,
} from "@/settings/MemorySettingsViewer.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

type MemoryCatalogService = Pick<IMemoryService, "listProjectMemories">;

/** 「总结模型」未指定时的哨兵值：跟随会话当前模型。 */
const SUMMARY_MODEL_DEFAULT_VALUE = "__summary_model_default__";

const MODEL_ITEM_NEVER_LOCKED = (): boolean => false;

function normalizeWorkspaceDisplayName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

function buildWorkspaceDisplayNameMap(names: readonly string[]): ReadonlyMap<string, string> {
  const matches = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const candidate of names) {
    const displayName = candidate.trim();
    const slug = normalizeWorkspaceDisplayName(displayName);
    if (!displayName || !slug || ambiguous.has(slug)) continue;
    const existing = matches.get(slug);
    if (existing && existing !== displayName) {
      matches.delete(slug);
      ambiguous.add(slug);
      continue;
    }
    matches.set(slug, displayName);
  }
  return matches;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemorySettingsSection({
  memoryEnabled,
  memoryService,
  onMemoryEnabledChange,
  onSummaryModelChange,
  projectMemoryViewerAvailable,
  summaryModelSelection,
  workspaceDisplayNames = [],
}: {
  memoryEnabled: boolean;
  memoryService: MemoryCatalogService;
  onMemoryEnabledChange: (enabled: boolean) => Promise<void>;
  onSummaryModelChange: (selection: ModelSelection | null) => Promise<void>;
  projectMemoryViewerAvailable: boolean;
  summaryModelSelection?: ModelSelection | null;
  workspaceDisplayNames?: readonly string[];
}) {
  const { intl } = useZCodeIntl();
  const localHostServices = useBaseWorkspaceServices();
  const modelSelectionRead = useModelSelectionServiceView(localHostServices.modelSelectionService);
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const modelSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionView);
  }, [modelSelectionView]);
  const summaryModelValue = summaryModelSelection
    ? encodeCustomModelValue(summaryModelSelection.providerId, summaryModelSelection.modelId)
    : SUMMARY_MODEL_DEFAULT_VALUE;
  const summaryModelDefaultLabel = intl.formatMessage({
    id: "settings.memory.summaryModel.default",
  });
  // Registry 候选里找不到时仍展示保存的模型身份（provider 已删/换号），提示用户修复。
  const summaryModelTriggerLabel =
    summaryModelValue === SUMMARY_MODEL_DEFAULT_VALUE
      ? summaryModelDefaultLabel
      : (resolveModelDisplayName(modelSelectGroups, summaryModelValue) ??
        intl.formatMessage({ id: "settings.memory.summaryModel.select" }));
  const catalogRequestIdRef = useRef(0);
  const [catalogState, setCatalogState] = useState<MemoryViewerLoadingState>("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ProjectMemoryWorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const refreshCatalog = useCallback(async (): Promise<ProjectMemoryWorkspaceSummary[] | null> => {
    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    setCatalogState("loading");
    setCatalogError(null);
    try {
      const result = await memoryService.listProjectMemories();
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces(result);
      setCatalogState("ready");
      return result;
    } catch (error) {
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setCatalogError(getErrorMessage(error));
      setCatalogState("error");
      return null;
    }
  }, [memoryService]);

  useEffect(() => {
    if (memoryEnabled && projectMemoryViewerAvailable) {
      void refreshCatalog();
      return;
    }

    catalogRequestIdRef.current += 1;
    setCatalogState("idle");
    setCatalogError(null);
    setWorkspaces([]);
    setSelectedWorkspaceId(null);
  }, [memoryEnabled, projectMemoryViewerAvailable, refreshCatalog]);

  const displayWorkspaces = useMemo(() => {
    const displayNameBySlug = buildWorkspaceDisplayNameMap(workspaceDisplayNames);
    const orderBySlug = new Map<string, number>();
    for (const [index, name] of workspaceDisplayNames.entries()) {
      const slug = normalizeWorkspaceDisplayName(name);
      if (!orderBySlug.has(slug)) orderBySlug.set(slug, index);
    }
    return workspaces
      .map((workspace, catalogIndex) => {
        const slug = normalizeWorkspaceDisplayName(workspace.label);
        return {
          catalogIndex,
          order: orderBySlug.get(slug) ?? Number.POSITIVE_INFINITY,
          workspace: {
            ...workspace,
            label: displayNameBySlug.get(slug) ?? workspace.label,
          },
        };
      })
      .sort((left, right) => left.order - right.order || left.catalogIndex - right.catalogIndex)
      .map(({ workspace }) => workspace);
  }, [workspaceDisplayNames, workspaces]);
  const selectedWorkspace = useMemo(
    () => displayWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [displayWorkspaces, selectedWorkspaceId],
  );

  useEffect(() => {
    const firstWorkspace = displayWorkspaces[0];
    if (!firstWorkspace) {
      setSelectedWorkspaceId(null);
      return;
    }
    if (
      !selectedWorkspaceId ||
      !displayWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ) {
      setSelectedWorkspaceId(firstWorkspace.id);
    }
  }, [displayWorkspaces, selectedWorkspaceId]);

  const handleRefresh = useCallback(async () => {
    await refreshCatalog();
  }, [refreshCatalog]);

  const handleSummaryModelValueChange = useCallback(
    (nextValue: string) => {
      if (nextValue === summaryModelValue) return;
      if (nextValue === SUMMARY_MODEL_DEFAULT_VALUE) {
        void onSummaryModelChange(null);
        return;
      }
      const selection = parseModelPickerValue(nextValue);
      void onSummaryModelChange({
        providerId: selection.providerId,
        modelId: selection.modelId,
      });
    },
    [onSummaryModelChange, summaryModelValue],
  );

  const summaryModelFooterActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "summary-model:default",
        label: summaryModelDefaultLabel,
        onSelect: () => handleSummaryModelValueChange(SUMMARY_MODEL_DEFAULT_VALUE),
        selected: summaryModelValue === SUMMARY_MODEL_DEFAULT_VALUE,
      },
    ],
    [handleSummaryModelValueChange, summaryModelDefaultLabel, summaryModelValue],
  );

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({
            id: "settings.memory.workspaceMemory",
          })}
          description={intl.formatMessage({
            id: "settings.memoryDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.memory.workspaceMemory",
              })}
              checked={memoryEnabled}
              data-testid={TID_SETTINGS_MEMORY_SWITCH}
              onCheckedChange={(checked) => {
                void onMemoryEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.memory.summaryModel" })}
          description={intl.formatMessage({ id: "settings.memory.summaryModelDescription" })}
          control={
            <ModelConfigSelect
              modelGroups={modelSelectGroups}
              normalizedValue={summaryModelValue}
              triggerLabel={summaryModelTriggerLabel}
              showManageModelsAction={false}
              lockReasonMessage=""
              isItemLocked={MODEL_ITEM_NEVER_LOCKED}
              onValueChange={handleSummaryModelValueChange}
              footerActions={summaryModelFooterActions}
              manageModelsLabel={intl.formatMessage({
                id: "chat.toolbar.model.manageModels",
              })}
              contentSide="bottom"
              contentAlign="end"
              focusSelectorOnClose={null}
              labelVisibilityClassName="inline-flex"
              triggerClassName="h-8 w-fit max-w-52 min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
              triggerLabelClassName="inline-flex min-w-0 truncate text-left"
            />
          }
        />
      </SettingsGroupCard>

      {!projectMemoryViewerAvailable ? (
        <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.memory.viewer.localOnly" })}
        </div>
      ) : !memoryEnabled ? null : (
        <MemorySettingsViewer
          catalogError={catalogError}
          catalogState={catalogState}
          selectedWorkspace={selectedWorkspace}
          workspaces={displayWorkspaces}
          onRefresh={handleRefresh}
          onScopeKeyChange={(workspaceId) => setSelectedWorkspaceId(workspaceId)}
        />
      )}
    </div>
  );
}
