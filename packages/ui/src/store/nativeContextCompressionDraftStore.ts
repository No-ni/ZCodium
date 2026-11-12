import { create } from "zustand";
import type { NativeContextConfiguration } from "@zcode/shared/native-context-compression";
import type {
  NativeContextParameterDraft,
  NativeContextTab,
} from "@/native-context-compression/contract.js";

interface NativeContextDraftStore {
  drafts: Readonly<Record<string, NativeContextParameterDraft>>;
  tabs: Readonly<Record<string, NativeContextTab>>;
  trends: Readonly<Record<string, NativeContextTrendSelection>>;
  initialize(key: string, configuration: NativeContextConfiguration, version: number): void;
  edit(
    key: string,
    update: (current: NativeContextParameterDraft) => NativeContextParameterDraft,
  ): void;
  reset(key: string, configuration: NativeContextConfiguration, version: number): void;
  selectTab(key: string, tab: NativeContextTab): void;
  selectTrend(key: string, patch: Partial<NativeContextTrendSelection>): void;
}

export interface NativeContextTrendSelection {
  range: "50" | "200" | "segment";
  segmentScope: "current" | "all" | "chosen";
  segmentId: string | null;
  observationId: string | null;
  imageUnit: "bytes" | "count";
  cacheUnit: "tokens" | "hit";
  hiddenSeries: readonly string[];
}

export const INITIAL_NATIVE_CONTEXT_TREND_SELECTION: NativeContextTrendSelection = {
  range: "50",
  segmentScope: "current",
  segmentId: null,
  observationId: null,
  imageUnit: "bytes",
  cacheUnit: "hit",
  hiddenSeries: [],
};

function makeDraft(
  configuration: NativeContextConfiguration,
  version: number,
): NativeContextParameterDraft {
  return {
    configuration,
    baseConfiguration: configuration,
    baseVersion: version,
    rawFields: {},
    jsonText: JSON.stringify(configuration, null, 2),
    jsonPending: false,
    jsonError: false,
  };
}

/** 仅内存草稿；不复制已提交 Runtime 事实，也不写用户目录。 */
export const useNativeContextDraftStore = create<NativeContextDraftStore>((set) => ({
  drafts: {},
  tabs: {},
  trends: {},
  initialize(key, configuration, version) {
    set((state) =>
      state.drafts[key]
        ? state
        : {
            drafts: { ...state.drafts, [key]: makeDraft(configuration, version) },
          },
    );
  },
  edit(key, update) {
    set((state) => {
      const current = state.drafts[key];
      return current ? { drafts: { ...state.drafts, [key]: update(current) } } : state;
    });
  },
  reset(key, configuration, version) {
    set((state) => ({ drafts: { ...state.drafts, [key]: makeDraft(configuration, version) } }));
  },
  selectTab(key, tab) {
    set((state) => ({ tabs: { ...state.tabs, [key]: tab } }));
  },
  selectTrend(key, patch) {
    set((state) => ({
      trends: {
        ...state.trends,
        [key]: { ...(state.trends[key] ?? INITIAL_NATIVE_CONTEXT_TREND_SELECTION), ...patch },
      },
    }));
  },
}));
