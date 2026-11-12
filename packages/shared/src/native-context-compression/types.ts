import type { ModelSelection } from "../model-selection.js";

export type NativeContextMode = "auto" | "manual";
export type NativeContextThreshold =
  | { kind: "percent"; value: number }
  | { kind: "tokens"; value: number };
export type NativeContextAutoNumber = "auto" | number;
export type NativeContextMaintenanceModel = "follow-current" | ModelSelection;
export type NativeContextImageSourceKind = "attachment" | "read" | "bash" | "mcp";
export type NativeContextSimplificationStrategy = "json-fold" | "code-trim" | "log-select";

/** 完整策略快照；数值单位和组合约束由同一共享 schema 校验。 */
export interface NativeContextParameters {
  trigger: {
    start: NativeContextThreshold;
    target: NativeContextThreshold;
    opportunisticPercent: number;
    capacityPercent: number;
    growthMode: "constant" | "adaptive";
    growthTokens: number;
    tierGrowthTokens: {
      t1: NativeContextAutoNumber;
      t2: NativeContextAutoNumber;
      t3: NativeContextAutoNumber;
    };
    minBenefitTokens: NativeContextAutoNumber;
    checkIntervalRounds: number;
    periodicCheckRounds: number;
    waitForUsageSample: boolean;
    estimateHoldRounds: number;
    modelDecides: boolean;
    decisionMaxOutputTokens: number;
    adaptive: {
      ratioPercent: number;
      floorTokens: number;
      capTokens: number;
      minGrowthFloorTokens: number;
      minGrowthRatioPercent: number;
      tierMultiplier: number;
    };
  };
  history: {
    preserveTurns: number;
    preserveMessages: number;
    preserveTokens: number;
    protectedTools: string[];
    protectedLatestTools: string[];
    earlyFoldTools: string[];
    preserveRecentTools: string[];
  };
  summary: {
    minRangeChars: number;
    minChars: number;
    maxChars: number;
    minReductionPercent: number;
    tiersEnabled: boolean;
    tier2BlockCount: number;
    tier3BlockCount: number;
    promotionSurvivals: number;
  };
  reasoning: {
    completedMode: "retain" | "provider-safe-omit";
    thresholdChars: number;
  };
  tools: {
    reference: {
      enabled: boolean;
      minTokens: number;
      headChars: number;
      excludeTools: string[];
      inlineReadTokens: number;
    };
    distill: {
      enabled: boolean;
      minTokens: number;
      minContextPercent: number;
      mediaOnly: boolean;
      excludeTools: string[];
    };
    simplify: {
      enabled: boolean;
      minReductionPercent: number;
      strategies: Record<
        NativeContextSimplificationStrategy,
        { enabled: boolean; excludeTools: string[] }
      >;
    };
  };
  retrieval: {
    planAware: boolean;
    maxHits: number;
    textPageTokens: number;
  };
  images: {
    rescale: boolean;
    foldWithHistory: boolean;
    omitSeen: boolean;
    keepRecentUserTurns: number;
    convention: { enabled: boolean; text: string };
    triggerMode: "edge" | "edge-or-bytes";
    maxEdge: number;
    byteTriggerKiB: number;
    jpegQuality: number;
    minJpegQuality: number;
    minEdge: number;
    minReductionPercent: number;
    pngMode: "preserve" | "jpeg-if-opaque";
    alphaMode: "preserve" | "flatten";
    flattenColor: string;
    targetRawKiB: NativeContextAutoNumber;
    sourceKinds: NativeContextImageSourceKind[];
    cacheMaxEntries: number;
    cacheMaxMiB: number;
  };
  maintenance: {
    model: NativeContextMaintenanceModel;
    stream: "auto" | "always";
    maxOutputTokens: NativeContextAutoNumber;
  };
  prompts: {
    pack: "default" | "lean";
    compressPhilosophy: string;
    howToCompressRules: string;
    tier2DistillRules: string;
    tier3CondenseRules: string;
    visibilityMarkers: boolean;
    messageTimestamps: boolean;
  };
}

/** 默认配置和可导出配置不携带本任务的提交版本。 */
export interface NativeContextConfiguration {
  schemaVersion: 1;
  mode: NativeContextMode;
  parameters: NativeContextParameters;
}

export type NativeContextPolicy = NativeContextConfiguration & { policyVersion: number };

export type NativeContextParameterGroup = "trigger" | "history" | "tools" | "images" | "prompts";
export type NativeContextParameterFieldType =
  | "boolean"
  | "number"
  | "auto-number"
  | "threshold"
  | "select"
  | "list"
  | "text"
  | "model";
export type NativeContextParameterLabels = Readonly<{ "zh-CN": string; "en-US": string }>;

type AtomicParameter =
  | boolean
  | number
  | string
  | readonly string[]
  | NativeContextThreshold
  | ModelSelection;
type ParameterPaths<T> = {
  [TKey in keyof T & string]: T[TKey] extends AtomicParameter
    ? TKey
    : `${TKey}.${ParameterPaths<T[TKey]>}`;
}[keyof T & string];
type ValueAtPath<T, TPath extends string> = TPath extends `${infer TKey}.${infer TRest}`
  ? TKey extends keyof T
    ? ValueAtPath<T[TKey], TRest>
    : never
  : TPath extends keyof T
    ? T[TPath]
    : never;

/** threshold 与 ModelSelection 是可编辑的单个语义字段，不枚举其内部键。 */
export type NativeContextParameterPath = ParameterPaths<NativeContextParameters>;
export type NativeContextParameterValue<
  TPath extends NativeContextParameterPath = NativeContextParameterPath,
> = ValueAtPath<NativeContextParameters, TPath>;

export interface NativeContextParameterFieldBase {
  readonly path: NativeContextParameterPath;
  readonly group: NativeContextParameterGroup;
  /** 保留原型文案；正式界面按 locale 读取 labels/helpLabels。 */
  readonly label: string;
  readonly labels: NativeContextParameterLabels;
  readonly help?: string;
  readonly helpLabels?: NativeContextParameterLabels;
  readonly advanced: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly decimal?: boolean;
  readonly multiline?: boolean;
  readonly maxLength?: number;
  readonly maxItems?: number;
  readonly itemMaxLength?: number;
  readonly options?: readonly (readonly [value: string, label: string])[];
  readonly optionLabels?: Readonly<Record<string, NativeContextParameterLabels>>;
}

/** 表单描述来自 schema 叶节点；value 是推荐值而非运行时生效值。 */
export type NativeContextParameterField = NativeContextParameterFieldBase &
  (
    | { readonly type: "boolean"; readonly value: boolean }
    | { readonly type: "number"; readonly value: number }
    | { readonly type: "auto-number"; readonly value: NativeContextAutoNumber }
    | {
        readonly type: "threshold";
        readonly value: NativeContextThreshold;
        readonly thresholdRanges: Readonly<{
          percent: Readonly<{ min: number; max: number }>;
          tokens: Readonly<{ min: number }>;
        }>;
      }
    | { readonly type: "select" | "text"; readonly value: string }
    | { readonly type: "list"; readonly value: readonly string[] }
    | { readonly type: "model"; readonly value: NativeContextMaintenanceModel }
  );
