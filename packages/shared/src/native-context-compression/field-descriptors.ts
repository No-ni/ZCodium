import { z } from "zod";
import type {
  NativeContextParameterField,
  NativeContextParameterFieldType,
  NativeContextParameterGroup,
  NativeContextParameterLabels,
} from "./types.js";

type Labels = readonly [zh: string, en: string];
type Choice = readonly [value: string, zh: string, en: string];
interface FieldOptions {
  advanced?: boolean;
  help?: Labels;
  min?: number;
  max?: number;
  decimal?: boolean;
  multiline?: boolean;
  maxLength?: number;
  maxItems?: number;
  itemMaxLength?: number;
  options?: readonly (readonly [string, string])[];
  optionLabels?: Readonly<Record<string, NativeContextParameterLabels>>;
  thresholdRanges?: {
    percent: { min: number; max: number };
    tokens: { min: number };
  };
}
interface FieldMetadata extends Omit<FieldOptions, "help"> {
  group: NativeContextParameterGroup;
  type: NativeContextParameterFieldType;
  label: string;
  labels: NativeContextParameterLabels;
  help?: string;
  helpLabels?: NativeContextParameterLabels;
  advanced: boolean;
  value: unknown;
}

// 字段描述附着于校验叶节点，避免表单、默认值与 JSON 规则各维护一份目录。
const fieldMetadata = z.registry<FieldMetadata>();
function localize([zh, en]: Labels): NativeContextParameterLabels {
  return { "zh-CN": zh, "en-US": en };
}
function describe<TSchema extends z.ZodType>(
  schema: TSchema,
  group: NativeContextParameterGroup,
  type: NativeContextParameterFieldType,
  labels: Labels,
  value: z.output<TSchema>,
  options: FieldOptions = {},
): TSchema {
  const { help, ...properties } = options;
  // 同一个列表校验器可复用，但各字段必须有独立 schema 身份，不能覆盖其它标签。
  const describedSchema = schema.clone();
  const metadataSchema: z.ZodType = describedSchema;
  fieldMetadata.add(metadataSchema, {
    ...properties,
    group,
    type,
    label: labels[0],
    labels: localize(labels),
    ...(help ? { help: help[0], helpLabels: localize(help) } : {}),
    advanced: options.advanced ?? false,
    value,
  });
  return describedSchema;
}
function numericSchema(options: FieldOptions): z.ZodNumber {
  let schema = z.number().finite();
  if (!options.decimal) schema = schema.int();
  if (options.min !== undefined) schema = schema.min(options.min);
  if (options.max !== undefined) schema = schema.max(options.max);
  return schema;
}
function numberField(
  group: NativeContextParameterGroup,
  labels: Labels,
  value: number,
  options: FieldOptions,
) {
  return describe(numericSchema(options), group, "number", labels, value, options);
}
function autoNumberField(
  group: NativeContextParameterGroup,
  labels: Labels,
  value: "auto" | number,
  options: FieldOptions,
) {
  return describe(
    z.union([z.literal("auto"), numericSchema(options)]),
    group,
    "auto-number",
    labels,
    value,
    options,
  );
}
function booleanField(
  group: NativeContextParameterGroup,
  labels: Labels,
  value: boolean,
  options: FieldOptions = {},
) {
  return describe(z.boolean(), group, "boolean", labels, value, options);
}
function selectField<const TChoices extends readonly [Choice, ...Choice[]]>(
  group: NativeContextParameterGroup,
  labels: Labels,
  choices: TChoices,
  value: TChoices[number][0],
  options: FieldOptions = {},
) {
  const values: TChoices[number][0][] = choices.map(([key]) => key);
  return describe(z.enum(values), group, "select", labels, value, {
    ...options,
    options: choices.map(([key, zh]) => [key, zh] as const),
    optionLabels: Object.fromEntries(choices.map(([key, zh, en]) => [key, localize([zh, en])])),
  });
}
function textField(
  group: NativeContextParameterGroup,
  labels: Labels,
  value: string,
  options: FieldOptions = {},
) {
  const schema = options.maxLength === undefined ? z.string() : z.string().max(options.maxLength);
  return describe(schema, group, "text", labels, value, options);
}
function thresholdField(labels: Labels, value: number, isTarget: boolean) {
  const min = isTarget ? 0 : 1;
  const max = isTarget ? 94 : 95;
  return describe(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("percent"), value: numericSchema({ min, max }) }).strict(),
      z.object({ kind: z.literal("tokens"), value: numericSchema({ min }) }).strict(),
    ]),
    "trigger",
    "threshold",
    labels,
    { kind: "percent", value },
    {
      min,
      max,
      options: [
        ["percent", "可用输入预算 %"],
        ["tokens", "Token"],
      ],
      optionLabels: {
        percent: localize(["可用输入预算 %", "% of available input budget"]),
        tokens: localize(["Token", "Tokens"]),
      },
      thresholdRanges: { percent: { min, max }, tokens: { min } },
      help: [
        "百分比基于可用输入预算；绝对 token 与混合单位关系在当前模型下校验。",
        "Percentages use the available input budget; token and mixed-unit limits are checked against the current model.",
      ],
    },
  );
}

const toolPatternMaxItems = 256;
const toolPatternMaxLength = 256;
const toolPatternSchema = z
  .string()
  .min(1)
  .max(toolPatternMaxLength)
  .regex(/^[A-Za-z0-9_.:-]+\*?$/);
const toolPatternsSchema = z
  .array(toolPatternSchema)
  .max(toolPatternMaxItems)
  .refine((patterns) => new Set(patterns).size === patterns.length, {
    message: "Tool patterns must be unique.",
  });
function toolListField(labels: Labels, group: NativeContextParameterGroup = "tools") {
  return describe(toolPatternsSchema, group, "list", labels, [], {
    advanced: true,
    maxItems: toolPatternMaxItems,
    itemMaxLength: toolPatternMaxLength,
    help: [
      "名称或非空前缀后的末尾 *，以逗号分隔；留空为 []，不允许重复或空白。",
      "Comma-separated names or a nonempty prefix ending in *. Empty means []; duplicates and whitespace are rejected.",
    ],
  });
}
function strategyFields(name: string) {
  return z
    .object({
      enabled: booleanField("tools", [`${name} 策略`, `${name} strategy`], true, {
        advanced: true,
      }),
      excludeTools: toolListField([`${name} 排除工具`, `${name} excluded tools`]),
    })
    .strict();
}
const customPromptOptions: FieldOptions = {
  advanced: true,
  multiline: true,
  maxLength: 16000,
  help: [
    "留空使用内置提示；保存不会重新生成已有摘要。",
    "Leave empty to use the built-in guidance. Saving does not regenerate existing summaries.",
  ],
};

function freezeMetadata<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}
function collectParameterFields(schema: z.ZodType): readonly NativeContextParameterField[] {
  const fields: NativeContextParameterField[] = [];
  function visit(node: z.ZodType, path: string) {
    const metadata = fieldMetadata.get(node);
    if (metadata) {
      fields.push(freezeMetadata({ ...metadata, path }) as NativeContextParameterField);
      return;
    }
    if (node instanceof z.ZodObject) {
      for (const [key, child] of Object.entries(node.shape)) {
        visit(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    throw new Error("Native context parameter schema is missing field metadata.");
  }
  visit(schema, "");
  if (fields.length !== 90) throw new Error("Native context schema version 1 must have 90 fields.");
  return Object.freeze(fields);
}

export {
  localize,
  describe,
  numberField,
  autoNumberField,
  booleanField,
  selectField,
  textField,
  thresholdField,
  toolListField,
  strategyFields,
  customPromptOptions,
  collectParameterFields,
};
