import { useCallback, useEffect, useMemo, useState } from "react";
import {
  NATIVE_CONTEXT_PARAMETER_FIELDS,
  createRecommendedNativeContextConfiguration,
  getNativeContextParameterValue,
  nativeContextConfigurationSchema,
  setNativeContextParameterValue,
  type NativeContextConfiguration,
  type NativeContextParameterField,
  type NativeContextParameterGroup,
  type NativeContextParameterValue,
} from "@zcode/shared/native-context-compression";
import { useNativeContextDraftStore } from "@/store/nativeContextCompressionDraftStore.js";
import {
  isParameterDraftDirty,
  parameterIssuePaths,
  rawParameterIsValid,
} from "../domain/parameters.js";
import type { NativeContextParameterDraft } from "../contract.js";

export function useParameterDraft(options: {
  scopeKey: string;
  configuration: NativeContextConfiguration | null;
  version: number;
  onSave: (configuration: NativeContextConfiguration, expectedVersion: number) => Promise<number>;
}) {
  const { scopeKey, configuration, version, onSave } = options;
  const draft = useNativeContextDraftStore((state) => state.drafts[scopeKey]);
  const [saveState, setSaveState] = useState<{
    key: string;
    saving: boolean;
    result: "saved" | "error" | null;
  }>({ key: scopeKey, saving: false, result: null });
  const dirty = draft ? isParameterDraftDirty(draft) : false;
  const conflict = !!draft && draft.baseVersion !== version;

  useEffect(() => {
    if (!configuration) return;
    const store = useNativeContextDraftStore.getState();
    const current = store.drafts[scopeKey];
    if (!current) store.initialize(scopeKey, configuration, version);
    else if (current.baseVersion !== version && !isParameterDraftDirty(current))
      store.reset(scopeKey, configuration, version);
  }, [configuration, scopeKey, version]);

  const edit = useCallback(
    (update: (current: NativeContextParameterDraft) => NativeContextParameterDraft) => {
      useNativeContextDraftStore.getState().edit(scopeKey, update);
      setSaveState({ key: scopeKey, saving: false, result: null });
    },
    [scopeKey],
  );

  const setValue = useCallback(
    (field: NativeContextParameterField, value: Readonly<NativeContextParameterValue>) => {
      edit((current) => {
        const next = {
          ...current.configuration,
          parameters: setNativeContextParameterValue(
            current.configuration.parameters,
            field.path,
            value,
          ),
        };
        const rawFields = { ...current.rawFields };
        delete rawFields[field.path];
        return {
          ...current,
          configuration: next,
          rawFields,
          jsonText: current.jsonPending ? current.jsonText : JSON.stringify(next, null, 2),
        };
      });
    },
    [edit],
  );
  const setRaw = useCallback(
    (field: NativeContextParameterField, text: string) => {
      edit((current) => {
        const rawFields = { ...current.rawFields, [field.path]: text };
        if (!rawParameterIsValid(field, text)) return { ...current, rawFields };
        const oldValue = getNativeContextParameterValue(
          current.configuration.parameters,
          field.path,
        );
        const value =
          field.type === "list"
            ? text.trim() === ""
              ? []
              : text.split(",").map((item) => item.trim())
            : field.type === "text"
              ? text
              : field.type === "threshold" && typeof oldValue === "object" && "kind" in oldValue
                ? { ...oldValue, value: Number(text) }
                : field.type === "auto-number" && text === "auto"
                  ? "auto"
                  : Number(text);
        const next = {
          ...current.configuration,
          parameters: setNativeContextParameterValue(
            current.configuration.parameters,
            field.path,
            value,
          ),
        };
        return {
          ...current,
          configuration: next,
          rawFields,
          jsonText: current.jsonPending ? current.jsonText : JSON.stringify(next, null, 2),
        };
      });
    },
    [edit],
  );
  const setMode = useCallback(
    (mode: NativeContextConfiguration["mode"]) =>
      edit((current) => {
        const next = { ...current.configuration, mode };
        return {
          ...current,
          configuration: next,
          jsonText: current.jsonPending ? current.jsonText : JSON.stringify(next, null, 2),
        };
      }),
    [edit],
  );
  const restore = useCallback(
    (group?: NativeContextParameterGroup) => {
      edit((current) => {
        let parameters = current.configuration.parameters;
        const rawFields = { ...current.rawFields };
        for (const field of NATIVE_CONTEXT_PARAMETER_FIELDS) {
          if (group && field.group !== group) continue;
          parameters = setNativeContextParameterValue(
            parameters,
            field.path,
            Array.isArray(field.value) ? [...field.value] : field.value,
          );
          delete rawFields[field.path];
        }
        const next = { ...current.configuration, parameters };
        return {
          ...current,
          configuration: next,
          rawFields,
          jsonText: current.jsonPending ? current.jsonText : JSON.stringify(next, null, 2),
        };
      });
    },
    [edit],
  );
  const load = useCallback(
    (candidate: NativeContextConfiguration) =>
      edit((current) => ({
        ...current,
        configuration: candidate,
        rawFields: {},
        jsonText: JSON.stringify(candidate, null, 2),
        jsonPending: false,
        jsonError: false,
      })),
    [edit],
  );
  const setJsonText = useCallback(
    (jsonText: string) =>
      edit((current) => ({ ...current, jsonText, jsonPending: true, jsonError: false })),
    [edit],
  );
  const loadJson = useCallback(() => {
    const current = useNativeContextDraftStore.getState().drafts[scopeKey];
    if (!current) return;
    try {
      const candidate: unknown = JSON.parse(current.jsonText);
      const parsed = nativeContextConfigurationSchema.safeParse(candidate);
      if (parsed.success) load(parsed.data);
      else edit((value) => ({ ...value, jsonError: true }));
    } catch {
      edit((value) => ({ ...value, jsonError: true }));
    }
  }, [edit, load, scopeKey]);
  const restoreJson = useCallback(
    () =>
      edit((current) => ({
        ...current,
        jsonText: JSON.stringify(current.configuration, null, 2),
        jsonPending: false,
        jsonError: false,
      })),
    [edit],
  );
  const reload = useCallback(() => {
    if (configuration)
      useNativeContextDraftStore.getState().reset(scopeKey, configuration, version);
    setSaveState({ key: scopeKey, saving: false, result: null });
  }, [configuration, scopeKey, version]);
  const issuePaths = useMemo(
    () => (draft ? parameterIssuePaths(draft.configuration) : new Set<string>()),
    [draft?.configuration],
  );
  const rawInvalid =
    !!draft &&
    NATIVE_CONTEXT_PARAMETER_FIELDS.some((field) => {
      const text = draft.rawFields[field.path];
      return text !== undefined && !rawParameterIsValid(field, text);
    });
  const valid = !!draft && !draft.jsonPending && !rawInvalid && issuePaths.size === 0;
  const saving = saveState.key === scopeKey && saveState.saving;
  const save = useCallback(async () => {
    const captured = useNativeContextDraftStore.getState().drafts[scopeKey];
    if (!captured || !valid || conflict || saving) return;
    const parsed = nativeContextConfigurationSchema.safeParse(captured.configuration);
    if (!parsed.success) return;
    setSaveState({ key: scopeKey, saving: true, result: null });
    try {
      const committedVersion = await onSave(parsed.data, captured.baseVersion);
      const store = useNativeContextDraftStore.getState();
      if (store.drafts[scopeKey] === captured) store.reset(scopeKey, parsed.data, committedVersion);
      else
        store.edit(scopeKey, (current) => ({
          ...current,
          baseConfiguration: parsed.data,
          baseVersion: committedVersion,
        }));
      setSaveState({ key: scopeKey, saving: false, result: "saved" });
    } catch {
      setSaveState({ key: scopeKey, saving: false, result: "error" });
    }
  }, [conflict, onSave, saving, scopeKey, valid]);

  return {
    draft,
    dirty,
    conflict,
    valid,
    saving,
    issuePaths,
    saveResult: saveState.key === scopeKey ? saveState.result : null,
    setValue,
    setRaw,
    setMode,
    restore,
    load,
    setJsonText,
    loadJson,
    restoreJson,
    reload,
    save,
    recommended: createRecommendedNativeContextConfiguration,
  };
}

export type NativeContextParameterDraftController = ReturnType<typeof useParameterDraft>;
