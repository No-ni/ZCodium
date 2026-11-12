/* oxlint-disable eslint(max-lines) -- provider 卡片同时承载名称、连接、鉴权、模型和映射编辑；本阶段先维持单组件，后续再按表单域拆分。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getProviderFormApiKey,
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
  type ProviderSettingsFormModel,
} from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderModelCatalogResult } from "@zcode/services";
import {
  isApiKeyAccess,
  type ProviderApiType,
  type ProviderRequestCompression,
  type SavePersonalModelDraftInput,
} from "@zcode/provider";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import {
  getProviderDraftValues,
  resolvePendingProviderDraftSave,
  type ProviderDraftValues,
} from "./ProviderDraftSave.js";
import {
  ProviderApiKeySection,
  ProviderCardHeader,
  ProviderConnectionSection,
  ProviderModelsSection,
} from "./ProviderCardSections.js";
import { resolveModelProviderDisplayName } from "./constants.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";
import { MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS, useIdleTrigger } from "./useIdleTrigger.js";
import { useOptimisticReorder } from "./useOptimisticReorder.js";

export type ProviderNameEditKeyAction = "commit" | "cancel";
export type ProviderDraftCleanupAction = "commit" | "skip-delete";
interface ProviderSaveNotificationTarget {
  modelId?: string;
  operation?: "delete";
  /** 显式弹窗在原草稿中重试，不让外部通知另起一次脱离编辑事务的保存。 */
  draftOwnsRetry?: boolean;
  retry?: () => void;
}

export const PROVIDER_TEXT_INPUT_IDLE_SAVE_MS = MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS;

export function shouldApplyProviderSaveCompletion(
  currentRevision: number,
  completedRevision: number,
): boolean {
  return currentRevision === completedRevision;
}

export function resolveProviderDraftCleanupAction({
  deleteRequested,
}: {
  deleteRequested: boolean;
}): ProviderDraftCleanupAction {
  return deleteRequested ? "skip-delete" : "commit";
}

export async function runProviderDeleteWithDraftCleanupGuard({
  deleteRequestedRef,
  onDelete,
  isCurrent = () => true,
}: {
  deleteRequestedRef: { current: boolean };
  onDelete?: () => boolean | void | Promise<boolean | void>;
  isCurrent?: () => boolean;
}): Promise<boolean> {
  if (!onDelete) {
    return false;
  }

  deleteRequestedRef.current = true;
  try {
    const deleted = (await onDelete()) === true;
    // 已删除的卡片保留终止标记；原 finally 无条件清零会让迟到保存重新创建 Provider。
    if (isCurrent()) deleteRequestedRef.current = deleted;
    return deleted;
  } catch (error) {
    if (isCurrent()) deleteRequestedRef.current = false;
    throw error;
  }
}

export function resolveProviderNameEditKeyAction(event: {
  key: string;
  compositionActive?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): ProviderNameEditKeyAction | null {
  // 中文输入法用 Enter 确认候选时仍处于 composition 阶段。
  // 部分平台的 keydown 标志会先恢复 false，因此同时读取本地 composition 状态，
  // 避免提前 blur 打断候选提交，导致拼音原始按键被留在名称里。
  if (isImeComposingKeyEvent(event)) {
    return null;
  }

  if (event.key === "Enter") {
    return "commit";
  }

  if (event.key === "Escape") {
    return "cancel";
  }

  return null;
}

function resolveVisibleProviderModelsForEdit(
  provider: ProviderSettingsFormProvider,
): ProviderSettingsFormModel[] {
  return provider.models.map((model) => structuredClone(model));
}

function projectModelsToOrder(
  models: readonly ProviderSettingsFormModel[],
  modelIds: readonly string[],
): ProviderSettingsFormModel[] {
  const byId = new Map(models.map((model) => [model.modelId, model]));
  const ordered = modelIds.flatMap((modelId) => {
    const model = byId.get(modelId);
    return model ? [model] : [];
  });
  const orderedIds = new Set(ordered.map((model) => model.modelId));
  return [...ordered, ...models.filter((model) => !orderedIds.has(model.modelId))];
}

export function InlineEditableProviderCard({
  provider,
  onSave,
  onAddPersonalModel,
  onSavePersonalModelDraft,
  onSetPersonalModelEnabled,
  onDeletePersonalModel,
  onDelete,
  onTestModel,
  onFetchModels,
  onReorderModelIds,
  readOnlyEndpoints,
  presetApiKeyUrl,
  onOpenPresetApiKey,
  statusSection,
  nameEditable,
  headerVisible = true,
  headerActionsVisible,
  settingsRevision,
}: {
  provider: ProviderSettingsFormProvider;
  onSave: (config: ProviderSettingsFormProvider) => Promise<ProviderSettingsFormProvider>;
  onAddPersonalModel?: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormModel["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft?: (input: SavePersonalModelDraftInput) => Promise<unknown>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel?: (providerId: string, modelId: string) => Promise<unknown>;
  onDelete?: () => Promise<boolean>;
  onTestModel?: (providerId: string, modelId: string) => Promise<ModelConnectivityResult>;
  /** 拉取该 Provider 的模型目录；仅 API Key 型自定义 Provider 装配。 */
  onFetchModels?: (providerId: string) => Promise<ProviderModelCatalogResult>;
  onReorderModelIds?: (modelIds: string[]) => Promise<void>;
  readOnlyEndpoints?: boolean;
  presetApiKeyUrl?: string;
  onOpenPresetApiKey?: () => void;
  statusSection?: ReactNode;
  nameEditable?: boolean;
  headerVisible?: boolean;
  headerActionsVisible?: boolean;
  settingsRevision?: number;
}) {
  const { intl } = useZCodeIntl();
  const { dismissFeedback, showFeedback } = useProviderDetailFeedback();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(getProviderFormLabel(provider));
  const [apiFormat, setApiFormat] = useState<ProviderApiType>(
    provider.config.api?.type ?? "anthropic-messages",
  );
  const [baseUrlValue, setBaseUrlValue] = useState(provider.config.api?.baseUrl ?? "");
  const [requestCompression, setRequestCompression] = useState<ProviderRequestCompression>(
    provider.config.api?.requestCompression ?? "off",
  );
  const [apiKeyValue, setApiKeyValue] = useState(getProviderFormApiKey(provider));
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const authoritativeModels = useMemo(
    () => resolveVisibleProviderModelsForEdit(provider),
    [provider],
  );
  const authoritativeModelIds = useMemo(
    () => authoritativeModels.map((model) => model.modelId),
    [authoritativeModels],
  );
  const reorderModelIdsTargetRef = useRef(onReorderModelIds);
  reorderModelIdsTargetRef.current = onReorderModelIds;
  const nameCompositionActiveRef = useRef(false);
  const nameEditProviderIdRef = useRef<string | null>(null);
  const technicalInputCompositionActiveRef = useRef(false);
  const deleteRequestedRef = useRef(false);
  const selfSaveRequestedRef = useRef(false);
  const providerIdRef = useRef(provider.providerId);
  const dirtyProviderFieldsRef = useRef(new Set<keyof ProviderDraftValues>());
  const draftRevisionRef = useRef(0);
  const pendingDraftSaveRef = useRef<Promise<ProviderSettingsFormProvider> | null>(null);
  const pendingEnabledUpdateRef = useRef<boolean | undefined>(undefined);
  const nameConfirmedForSaveRef = useRef(false);
  const latestProviderRef = useRef(provider);
  latestProviderRef.current = provider;
  const activeSaveOwnerRef = useRef(onSave);
  activeSaveOwnerRef.current = onSave;
  const draftSaveOwnerRef = useRef(onSave);
  const saveScopeGenerationRef = useRef(0);
  const providerDisplayName = resolveModelProviderDisplayName(provider);
  const saveNotificationRef = useRef({
    providerId: provider.providerId,
    providerDisplayName,
    formatMessage: intl.formatMessage,
    dismissFeedback,
    showFeedback,
  });
  saveNotificationRef.current = {
    providerId: provider.providerId,
    providerDisplayName,
    formatMessage: intl.formatMessage,
    dismissFeedback,
    showFeedback,
  };
  const draftRef = useRef<ProviderDraftValues>(getProviderDraftValues(provider));
  const syncProviderDraft = useCallback(
    (values: ProviderDraftValues, submitted?: ProviderDraftValues, nameConfirmed = false) => {
      const syncField = <TKey extends keyof ProviderDraftValues>(
        key: TKey,
        value: ProviderDraftValues[TKey],
        apply: (next: ProviderDraftValues[TKey]) => void,
      ) => {
        if (submitted) {
          if ((key === "nameValue" && !nameConfirmed) || draftRef.current[key] !== submitted[key])
            return;
        } else if (
          dirtyProviderFieldsRef.current.has(key) &&
          (pendingDraftSaveRef.current || draftRef.current[key] !== value)
        ) {
          return;
        }
        dirtyProviderFieldsRef.current.delete(key);
        draftRef.current[key] = value;
        apply(value);
      };
      syncField("nameValue", values.nameValue, setNameValue);
      syncField("apiFormat", values.apiFormat, setApiFormat);
      syncField("baseUrlValue", values.baseUrlValue, setBaseUrlValue);
      syncField("apiKeyValue", values.apiKeyValue, setApiKeyValue);
      syncField("requestCompression", values.requestCompression, setRequestCompression);
    },
    [],
  );

  useEffect(() => {
    if (providerIdRef.current !== provider.providerId || draftSaveOwnerRef.current !== onSave) {
      // 同一所有者切走再切回也已换代；只比较 ID/回调会重新接纳旧失败和名称确认标记。
      saveScopeGenerationRef.current += 1;
      providerIdRef.current = provider.providerId;
      draftSaveOwnerRef.current = onSave;
      nameEditProviderIdRef.current = null;
      nameCompositionActiveRef.current = false;
      setEditingName(false);
      draftRevisionRef.current += 1;
      dirtyProviderFieldsRef.current.clear();
      pendingDraftSaveRef.current = null;
      pendingEnabledUpdateRef.current = undefined;
      nameConfirmedForSaveRef.current = false;
      deleteRequestedRef.current = false;
      setSavingEnabled(false);
    }
    syncProviderDraft(getProviderDraftValues(provider));
  }, [provider, onSave, syncProviderDraft]);

  const markDraftDirty = useCallback((field: keyof ProviderDraftValues) => {
    dirtyProviderFieldsRef.current.add(field);
    selfSaveRequestedRef.current = false;
    draftRevisionRef.current += 1;
    saveNotificationRef.current.dismissFeedback(`provider-save:${providerIdRef.current}`);
  }, []);

  const runSaveOperation = useCallback(
    async (operation: () => Promise<void>, target: ProviderSaveNotificationTarget = {}) => {
      selfSaveRequestedRef.current = true;
      const revision = draftRevisionRef.current + 1;
      draftRevisionRef.current = revision;
      const notification = saveNotificationRef.current;
      const saveOwner = activeSaveOwnerRef.current;
      const scopeGeneration = saveScopeGenerationRef.current;
      const isCurrent = () =>
        saveScopeGenerationRef.current === scopeGeneration &&
        activeSaveOwnerRef.current === saveOwner &&
        latestProviderRef.current.providerId === notification.providerId;
      const dedupeKey = target.modelId
        ? `model-save:${notification.providerId}:${target.modelId}`
        : `provider-save:${notification.providerId}`;
      const messageValues = {
        provider: notification.providerDisplayName,
        model: target.modelId ?? "",
      };
      const messageIds = target.modelId
        ? target.operation === "delete"
          ? {
              pending: "settings.modelProvider.modelDeleting",
              failure: "settings.modelProvider.modelDeleteFailure",
            }
          : {
              pending: "settings.modelProvider.modelSaving",
              failure: "settings.modelProvider.modelSaveFailure",
            }
        : {
            pending: "settings.modelProvider.providerSaving",
            failure: "settings.modelProvider.providerSaveFailure",
          };
      if (target.modelId)
        notification.showFeedback({
          key: dedupeKey,
          message: notification.formatMessage(
            {
              id: messageIds.pending,
            },
            messageValues,
          ),
          state: "pending",
          durationMs: 0,
        });
      try {
        await operation();
        if (!isCurrent() || !shouldApplyProviderSaveCompletion(draftRevisionRef.current, revision))
          return;
        // 成功由输入值、模型列表和弹窗关闭体现，自动保存不堆叠横幅干扰编辑。
        // 失败反馈仍保留；显式连通性测试由独立入口展示结果。
        notification.dismissFeedback(dedupeKey);
      } catch (error) {
        if (isCurrent()) selfSaveRequestedRef.current = false;
        // 串行草稿仍承载最新编辑；仅靠 revision 会吞掉保存期间再次编辑后的失败和重试入口。
        // 迟到错误只在原 Provider/Service 内反馈，重试回调重新读取当前草稿。
        if (
          isCurrent() &&
          (shouldApplyProviderSaveCompletion(draftRevisionRef.current, revision) || target.retry)
        ) {
          notification.showFeedback({
            key: dedupeKey,
            message: notification.formatMessage(
              {
                id: messageIds.failure,
              },
              {
                ...messageValues,
                error: error instanceof Error ? error.message : String(error),
              },
            ),
            state: "failure",
            durationMs: 8_000,
            ...(target.draftOwnsRetry
              ? {}
              : {
                  actionLabel: notification.formatMessage({ id: "common.retry" }),
                  onAction: () => {
                    if (target.retry) target.retry();
                    else void runSaveOperation(operation, target).catch(() => undefined);
                  },
                }),
            dismissible: true,
            dismissLabel: notification.formatMessage({ id: "common.close" }),
          });
        }
        throw error;
      }
    },
    // runSaveOperation 参与卸载保存 effect 的依赖链。intl/provider 随渲染换引用时，
    // 回调也换引用会先执行旧 effect cleanup，进而再次保存并形成循环；通知身份通过 ref 读取。
    [],
  );

  const persistModelOrder = useCallback(
    async (modelIds: readonly string[]) => {
      const target = reorderModelIdsTargetRef.current;
      if (!target) throw new Error("当前设置入口未装配 Model 调序能力");
      await runSaveOperation(async () => {
        await target([...modelIds]);
      });
    },
    [provider.providerId, runSaveOperation],
  );
  const optimisticModelOrder = useOptimisticReorder({
    authoritativeIds: authoritativeModelIds,
    persist: persistModelOrder,
  });

  // 成员与配置只有 Host View 一份事实。旧本地副本在异步成功/失败时会覆盖新 View，
  // 甚至短暂移除正在编辑的模型。只保留拖拽顺序这一份明确的 pending intent。
  const models = useMemo(
    () => projectModelsToOrder(authoritativeModels, optimisticModelOrder.renderedIds),
    [authoritativeModels, optimisticModelOrder.renderedIds],
  );

  const saveProviderWithCleanupGuard = useCallback(
    async (
      nextProvider: ProviderSettingsFormProvider,
      retry?: () => void,
    ): Promise<ProviderSettingsFormProvider> => {
      let savedProvider: ProviderSettingsFormProvider | undefined;
      const operation = async () => {
        savedProvider = await onSave(nextProvider);
      };
      await runSaveOperation(operation, { retry }).catch((error) => {
        logger.warn("[ModelProviderSection] 自动保存 Provider 草稿失败", {
          providerId: provider.providerId,
          error,
        });
        throw error;
      });
      return savedProvider!;
    },
    [onSave, provider.providerId, runSaveOperation],
  );

  const cancelIdleDraftSaveRef = useRef<() => void>(() => undefined);

  const commitPendingDraft = useCallback(
    (
      reason: string,
      nameConfirmed = false,
      enabledUpdate?: boolean,
    ): Promise<ProviderSettingsFormProvider> => {
      cancelIdleDraftSaveRef.current();
      nameConfirmedForSaveRef.current ||= nameConfirmed;
      if (enabledUpdate !== undefined) pendingEnabledUpdateRef.current = enabledUpdate;
      if (pendingDraftSaveRef.current) return pendingDraftSaveRef.current;
      const owner = onSave;
      const providerId = provider.providerId;
      const scopeGeneration = saveScopeGenerationRef.current;
      const isCurrent = () =>
        saveScopeGenerationRef.current === scopeGeneration &&
        activeSaveOwnerRef.current === owner &&
        latestProviderRef.current.providerId === providerId;
      // 根因：保存期间切回旧值会被旧 props 判为“无变化”。只保留最新草稿，串行等待权威返回值再比较。
      const operation = Promise.resolve().then(async () => {
        let baseline = latestProviderRef.current;
        while (isCurrent() && !deleteRequestedRef.current) {
          const submitted = { ...draftRef.current };
          const confirmed = nameConfirmedForSaveRef.current;
          const submittedEnabled = pendingEnabledUpdateRef.current;
          nameConfirmedForSaveRef.current = false;
          pendingEnabledUpdateRef.current = undefined;
          const draftProvider = resolvePendingProviderDraftSave({
            provider: baseline,
            draft: submitted,
            readOnlyEndpoints,
            nameConfirmed: confirmed,
            now: Date.now,
          });
          // 启停也保存 Provider Overlay；若另起请求，其旧连接配置会覆盖并发提交的最新压缩。
          const nextProvider =
            submittedEnabled === undefined
              ? draftProvider
              : { ...(draftProvider ?? baseline), enabledUpdate: submittedEnabled };
          if (!nextProvider) return baseline;
          logger.info("[ModelProviderSection] 保存供应商草稿", { providerId, reason });
          try {
            baseline = await saveProviderWithCleanupGuard(nextProvider, () => {
              void commitPendingDraft("retry").catch(() => undefined);
            });
          } catch (error) {
            // 旧保存失败只能恢复原代次的确认意图，不能让新环境的未确认名称被连接保存夹带。
            if (isCurrent()) {
              if (draftRef.current.nameValue === submitted.nameValue)
                nameConfirmedForSaveRef.current ||= confirmed;
              pendingEnabledUpdateRef.current ??= submittedEnabled;
            }
            throw error;
          }
          if (!isCurrent())
            throw new DOMException("供应商设置已切换，本次操作已取消", "AbortError");
          // 只确认提交后未再编辑的字段；旧成功不能覆盖保存期间的新选择。
          syncProviderDraft(getProviderDraftValues(baseline), submitted, confirmed);
        }
        // 依赖 flush 的启停/连通性操作不能把过期结果当作成功后继续执行。
        throw new DOMException("供应商设置已切换或正在删除，本次操作已取消", "AbortError");
      });
      pendingDraftSaveRef.current = operation;
      const clearPending = () => {
        if (pendingDraftSaveRef.current === operation) pendingDraftSaveRef.current = null;
      };
      void operation.then(clearPending, clearPending);
      return operation;
    },
    [
      onSave,
      provider.providerId,
      readOnlyEndpoints,
      saveProviderWithCleanupGuard,
      syncProviderDraft,
    ],
  );

  const idleDraftSave = useIdleTrigger(() => {
    void commitPendingDraft("idle").catch(() => undefined);
  });
  cancelIdleDraftSaveRef.current = idleDraftSave.cancel;
  const scheduleIdleDraftSave = idleDraftSave.schedule;
  const cancelIdleDraftSave = idleDraftSave.cancel;

  const handleProviderEnabledChange = async (enabled: boolean) => {
    if (savingEnabled) return;
    const scopeGeneration = saveScopeGenerationRef.current;
    cancelIdleDraftSave();
    setSavingEnabled(true);
    // 同一次保存带上尚未提交的连接草稿，避免开关保存把刚输入的 Key 覆盖回旧值。
    try {
      await commitPendingDraft("provider-enabled", false, enabled);
    } catch {
      // 统一保存入口已记录错误及可重试反馈；不乐观覆盖权威 enabled。
    } finally {
      if (saveScopeGenerationRef.current === scopeGeneration) setSavingEnabled(false);
    }
  };

  useEffect(() => {
    return () => {
      cancelIdleDraftSave();
      const cleanupAction = resolveProviderDraftCleanupAction({
        deleteRequested: deleteRequestedRef.current,
      });
      if (cleanupAction === "skip-delete") {
        // 确认删除会触发详情卡片卸载；如果 cleanup 继续补保存草稿，
        // 被删除的 provider 会在 delete 后又被 save 重新创建。
        logger.info("[ModelProviderSection] 删除中的供应商跳过 cleanup 草稿保存", {
          providerId: provider.providerId,
        });
        return;
      }
      if (selfSaveRequestedRef.current) {
        selfSaveRequestedRef.current = false;
        // 模型编辑会先保存新的有效模型列表，随后父层乐观更新会触发本组件 cleanup。
        // 此时如果再用旧草稿补保存，会覆盖刚提交的模型列表。
        logger.info("[ModelProviderSection] 内部保存触发的刷新跳过 cleanup 草稿保存", {
          providerId: provider.providerId,
        });
        return;
      }
      void commitPendingDraft("cleanup").catch(() => undefined);
    };
  }, [cancelIdleDraftSave, commitPendingDraft, provider.providerId]);

  const handleNameValueChange = useCallback(
    (value: string) => {
      markDraftDirty("nameValue");
      draftRef.current.nameValue = value;
      setNameValue(value);
    },
    [markDraftDirty],
  );

  const handleBaseUrlValueChange = useCallback(
    (value: string) => {
      markDraftDirty("baseUrlValue");
      draftRef.current.baseUrlValue = value;
      setBaseUrlValue(value);
      scheduleIdleDraftSave();
    },
    [markDraftDirty, scheduleIdleDraftSave],
  );

  const handleApiKeyValueChange = useCallback(
    (value: string) => {
      markDraftDirty("apiKeyValue");
      draftRef.current.apiKeyValue = value;
      setApiKeyValue(value);
      scheduleIdleDraftSave();
    },
    [markDraftDirty, scheduleIdleDraftSave],
  );

  const handleNameBlur = useCallback(() => {
    // Esc/切换供应商先取消编辑意图，随后发生的 blur 不得补发保存。
    if (nameEditProviderIdRef.current !== provider.providerId) return;
    nameEditProviderIdRef.current = null;
    setEditingName(false);
    const trimmed = draftRef.current.nameValue.trim();
    const currentLabel = getProviderFormLabel(provider);
    if (trimmed && trimmed !== currentLabel) {
      void commitPendingDraft("name-blur", true).catch(() => undefined);
    } else {
      draftRef.current.nameValue = currentLabel;
      setNameValue(currentLabel);
      dirtyProviderFieldsRef.current.delete("nameValue");
    }
  }, [commitPendingDraft, provider]);

  const handleNameKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const action = resolveProviderNameEditKeyAction({
        key: event.key,
        compositionActive: nameCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      });
      if (action === "commit") {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      } else if (action === "cancel") {
        event.preventDefault();
        nameEditProviderIdRef.current = null;
        nameCompositionActiveRef.current = false;
        const label = getProviderFormLabel(provider);
        draftRef.current.nameValue = label;
        dirtyProviderFieldsRef.current.delete("nameValue");
        setNameValue(label);
        setEditingName(false);
      }
    },
    [provider],
  );

  const handleStartEditName = useCallback(() => {
    nameEditProviderIdRef.current = provider.providerId;
    nameCompositionActiveRef.current = false;
    setEditingName(true);
  }, [provider.providerId]);

  const saveConnection = useCallback(
    () => void commitPendingDraft("connection-blur").catch(() => undefined),
    [commitPendingDraft],
  );

  const handleApiFormatChange = useCallback(
    (value: ProviderApiType) => {
      markDraftDirty("apiFormat");
      draftRef.current.apiFormat = value;
      setApiFormat(value);
      void commitPendingDraft("api-format-change").catch(() => undefined);
    },
    [commitPendingDraft, markDraftDirty],
  );

  const handleRequestCompressionChange = useCallback(
    (value: ProviderRequestCompression) => {
      markDraftDirty("requestCompression");
      draftRef.current.requestCompression = value;
      setRequestCompression(value);
      // 与 API 格式一致：下拉是即时选择，选完立刻落盘，不等失焦。
      void commitPendingDraft("request-compression-change").catch(() => undefined);
    },
    [commitPendingDraft, markDraftDirty],
  );

  const handleApiKeyBlur = useCallback(() => {
    void commitPendingDraft("api-key-blur").catch(() => undefined);
  }, [commitPendingDraft]);

  const handleTextCommitKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    // 候选确认的 Enter 不能被当作表单提交。本地 ref 覆盖
    // Electron/macOS 上 nativeEvent.isComposing 过早变回 false 的时序。
    if (
      isImeComposingKeyEvent({
        compositionActive: technicalInputCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      })
    ) {
      return;
    }
    event.currentTarget.blur();
  }, []);
  const handleTechnicalInputCompositionStart = useCallback(() => {
    technicalInputCompositionActiveRef.current = true;
  }, []);
  const handleTechnicalInputCompositionEnd = useCallback(() => {
    technicalInputCompositionActiveRef.current = false;
  }, []);

  const handleTestModel = useCallback(
    async (model: string): Promise<ModelConnectivityResult> => {
      if (!onTestModel) {
        return Promise.resolve({
          success: false,
          error: { message: "Model connectivity test is unavailable" },
        });
      }

      // 连接测试曾把 Renderer 模型快照交给外层重新保存，绕过了模型草稿的
      // revision 边界。现在只 flush 本卡片唯一的 Provider 草稿；Service 会等待同一 Provider
      // 操作队列和 Registry 刷新完成，再按正式 providerId/modelId 创建 Model。
      await commitPendingDraft("connectivity-test");
      return onTestModel(provider.providerId, model);
    },
    [commitPendingDraft, onTestModel, provider.providerId],
  );

  const handleModelCommit = useCallback(
    async (
      originalModelId: string,
      nextModel: ProviderSettingsFormModel,
      basedOnRevision: number,
    ): Promise<void> => {
      const trimmed = nextModel.modelId.trim();
      const index = models.findIndex((model) => model.modelId === originalModelId);
      const currentModel = models[index];
      if (!currentModel || !trimmed || !onSavePersonalModelDraft) {
        throw new Error("当前设置入口未装配原子 Model Draft 保存能力");
      }
      const next = [...models];
      next[index] = { ...nextModel, modelId: trimmed, hasPersonalConfig: true };
      if (JSON.stringify(next) === JSON.stringify(models)) {
        return;
      }
      await runSaveOperation(
        async () => {
          await onSavePersonalModelDraft({
            providerId: provider.providerId,
            originalModelId: currentModel.modelId,
            nextModelId: trimmed,
            personalConfig: structuredClone(nextModel.personalConfig),
            ...(nextModel.useRecommendedConfig === undefined
              ? {}
              : { useRecommendedConfig: nextModel.useRecommendedConfig }),
            basedOnRevision,
          });
        },
        { modelId: trimmed, draftOwnsRetry: true },
      );
    },
    [models, onSavePersonalModelDraft, provider.providerId, runSaveOperation],
  );

  const handleDeleteModel = useCallback(
    (modelId: string) => {
      const index = models.findIndex((model) => model.modelId === modelId);
      const model = models[index];
      if (!model) {
        return;
      }
      if (!model.builtin) {
        void runSaveOperation(
          async () => {
            if (!onDeletePersonalModel)
              throw new Error("当前设置入口未装配 Personal Model 删除能力");
            await onDeletePersonalModel(provider.providerId, model.modelId);
          },
          { modelId: model.modelId, operation: "delete" },
        ).catch((error) => {
          logger.warn("[ModelProviderSection] 删除 Personal Model 失败", {
            providerId: provider.providerId,
            modelId: model.modelId,
            error,
          });
        });
        return;
      }
    },
    [models, onDeletePersonalModel, provider.providerId, runSaveOperation],
  );

  const handleModelEnabledChange = useCallback(
    async (modelId: string, enabled: boolean) => {
      if (!onSetPersonalModelEnabled) throw new Error("当前设置入口未装配 Model 启停能力");
      await runSaveOperation(
        () =>
          onSetPersonalModelEnabled(provider.providerId, modelId, enabled).then(() => undefined),
        { modelId },
      );
    },
    [onSetPersonalModelEnabled, provider.providerId, runSaveOperation],
  );

  const handleAddModel = useCallback(
    async (model: ProviderSettingsFormModel) => {
      if (!onAddPersonalModel) throw new Error("当前设置入口未装配 Personal Model 添加能力");
      const added = { ...model, modelId: model.modelId.trim(), hasPersonalConfig: true };
      if (!added.modelId) return;
      await runSaveOperation(
        async () => {
          await onAddPersonalModel(
            provider.providerId,
            added.modelId,
            structuredClone(added.personalConfig),
            added.useRecommendedConfig,
          );
        },
        { modelId: added.modelId, draftOwnsRetry: true },
      );
    },
    [onAddPersonalModel, provider.providerId, runSaveOperation],
  );

  const handleReorderModelIds = useCallback(
    (modelIds: string[]) => {
      if (!onReorderModelIds) return;
      void optimisticModelOrder.commit(modelIds).catch((error) => {
        logger.warn("[ModelProviderSection] 保存 Personal Model 顺序失败", {
          providerId: provider.providerId,
          error,
        });
      });
    },
    [onReorderModelIds, optimisticModelOrder, provider.providerId],
  );

  const handleDeleteProvider = useCallback(() => {
    if (deleteRequestedRef.current) return;
    const owner = onSave;
    const providerId = provider.providerId;
    const scopeGeneration = saveScopeGenerationRef.current;
    const isCurrent = () =>
      saveScopeGenerationRef.current === scopeGeneration &&
      activeSaveOwnerRef.current === owner &&
      latestProviderRef.current.providerId === providerId;
    const resumeDraft = (deleted: boolean) => {
      // 确认框期间可能暂停了最新草稿；取消/失败后仍要保存，已删除或换代则停止。
      if (!deleted && isCurrent())
        void commitPendingDraft("delete-cancelled").catch(() => undefined);
    };
    void runProviderDeleteWithDraftCleanupGuard({
      deleteRequestedRef,
      onDelete,
      isCurrent,
    }).then(resumeDraft, () => resumeDraft(false));
  }, [onDelete, onSave, provider.providerId, commitPendingDraft]);

  const headerProviderName = providerDisplayName;
  const isApiKeyProvider = isApiKeyAccess(provider.config.access);
  const effectiveHeaderVisible = headerVisible && statusSection === undefined;

  return (
    <div className="space-y-3">
      {effectiveHeaderVisible ? (
        <ProviderCardHeader
          providerName={headerProviderName}
          logo={provider.config.logo}
          editingName={editingName}
          nameValue={nameValue}
          nameEditable={nameEditable}
          onNameChange={handleNameValueChange}
          onNameBlur={handleNameBlur}
          onNameKeyDown={handleNameKeyDown}
          onNameCompositionStart={() => {
            nameCompositionActiveRef.current = true;
          }}
          onNameCompositionEnd={() => {
            nameCompositionActiveRef.current = false;
          }}
          onStartEditName={handleStartEditName}
          onDelete={onDelete ? handleDeleteProvider : undefined}
          actionsVisible={headerActionsVisible}
          providerToggle={
            <ControlHintTooltip
              standalone
              title={intl.formatMessage({
                id: provider.enabled
                  ? "settings.modelProvider.disableProvider"
                  : "settings.modelProvider.enableProvider",
              })}
            >
              {/* Tooltip 的 data-state 不能覆盖 Switch 的 checked 状态，否则轨道样式会消失。 */}
              <span className="inline-flex">
                <Switch
                  // 共享开关左右各扩展 12px，会覆盖相邻菜单；本标题栏仅保留 4px 横向热区。
                  className="after:-inset-x-1"
                  data-testid="model-provider-enabled-switch"
                  aria-label={intl.formatMessage({
                    id: provider.enabled
                      ? "settings.modelProvider.disableProvider"
                      : "settings.modelProvider.enableProvider",
                  })}
                  checked={provider.enabled}
                  disabled={savingEnabled}
                  onCheckedChange={(enabled) => {
                    void handleProviderEnabledChange(enabled);
                  }}
                />
              </span>
            </ControlHintTooltip>
          }
        />
      ) : null}

      {statusSection}

      <div className="space-y-3">
        <ProviderConnectionSection
          provider={provider}
          readOnly={readOnlyEndpoints}
          apiFormat={apiFormat}
          baseUrlValue={baseUrlValue}
          requestCompression={requestCompression}
          onApiFormatChange={handleApiFormatChange}
          onBaseUrlChange={handleBaseUrlValueChange}
          onBaseUrlBlur={saveConnection}
          onRequestCompressionChange={handleRequestCompressionChange}
          onBaseUrlKeyDown={handleTextCommitKeyDown}
          onBaseUrlCompositionStart={handleTechnicalInputCompositionStart}
          onBaseUrlCompositionEnd={handleTechnicalInputCompositionEnd}
        />

        {isApiKeyProvider ? (
          <ProviderApiKeySection
            apiKeyValue={apiKeyValue}
            apiKeyVisible={apiKeyVisible}
            presetApiKeyUrl={presetApiKeyUrl}
            onOpenPresetApiKey={onOpenPresetApiKey}
            onApiKeyChange={handleApiKeyValueChange}
            onApiKeyBlur={handleApiKeyBlur}
            onApiKeyKeyDown={handleTextCommitKeyDown}
            onApiKeyCompositionStart={handleTechnicalInputCompositionStart}
            onApiKeyCompositionEnd={handleTechnicalInputCompositionEnd}
            onToggleApiKeyVisibility={() => setApiKeyVisible((value) => !value)}
          />
        ) : null}

        <ProviderModelsSection
          // 不同 Provider 可以有同名模型；不能复用上一供应商的打开中草稿和版本。
          key={provider.providerId}
          providerId={provider.providerId}
          providerName={getProviderFormLabel(provider)}
          providerEnabled={provider.enabled}
          providerAccess={provider.config.access}
          apiFormat={apiFormat}
          models={models}
          onTestModel={onTestModel ? handleTestModel : undefined}
          onFetchModels={
            onFetchModels
              ? async () => {
                  // 与连通性测试同一顺序：目录读取用的是已落盘配置，
                  // 先把本卡片草稿 flush 出去，否则会拿旧 baseUrl/apiKey 发请求。
                  await commitPendingDraft("model-catalog");
                  return onFetchModels(provider.providerId);
                }
              : undefined
          }
          onModelCommit={handleModelCommit}
          onModelEnabledChange={handleModelEnabledChange}
          onDeleteModel={handleDeleteModel}
          onAddModel={handleAddModel}
          onReorderModelIds={onReorderModelIds ? handleReorderModelIds : undefined}
          settingsRevision={settingsRevision ?? 0}
        />
      </div>
    </div>
  );
}
