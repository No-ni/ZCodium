import type { JsonSchema } from "./model-identifiers.js";

export const modelSelectionJsonSchema = {
  type: "object",
  required: ["providerId", "modelId"],
  additionalProperties: false,
  properties: {
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
    options: {
      type: "object",
      additionalProperties: false,
      properties: {
        reasoningLevel: { type: "string", minLength: 1 },
        maxOutputTokens: { type: "number", minimum: 1 },
      },
    },
  },
} satisfies JsonSchema;

export const attachmentRefJsonSchema = {
  type: "object",
  required: ["id", "kind"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    kind: { enum: ["local_file", "resource", "inline"] },
    uri: { type: "string" },
    path: { type: "string" },
    mimeType: { type: "string" },
    sizeBytes: { type: "number" },
    sha256: { type: "string" },
    placeholder: { type: "string" },
  },
} satisfies JsonSchema;

export const modelMessageContentBlockJsonSchema = {
  // oneOf 必须恰好命中一个分支；重复 tool_reference 会让合法单块及混合消息都被拒绝。
  oneOf: [
    {
      type: "object",
      required: ["type", "toolName"],
      additionalProperties: false,
      properties: {
        type: { enum: ["tool_reference"] },
        toolName: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { enum: ["text"] },
        text: { type: "string" },
        blockIndex: { type: "integer", minimum: 0 },
      },
    },
    {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { enum: ["reasoning"] },
        text: { type: "string" },
        providerOptions: { type: "object" },
        blockIndex: { type: "integer", minimum: 0 },
      },
    },
    {
      type: "object",
      required: ["type", "mediaType", "dataUrl"],
      additionalProperties: false,
      properties: {
        type: { enum: ["image"] },
        mediaType: { type: "string", minLength: 1 },
        dataUrl: { type: "string", minLength: 1 },
        detail: { enum: ["auto", "low", "high", "original"] },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "mediaType", "dataUrl"],
      additionalProperties: false,
      properties: {
        type: { enum: ["video"] },
        mediaType: { type: "string", minLength: 1 },
        dataUrl: { type: "string", minLength: 1 },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "mediaType"],
      additionalProperties: false,
      properties: {
        type: { enum: ["file"] },
        mediaType: { type: "string", minLength: 1 },
        name: { type: "string" },
        uri: { type: "string" },
        dataUrl: { type: "string" },
        text: { type: "string" },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "uri"],
      additionalProperties: false,
      properties: {
        type: { enum: ["resource_link"] },
        uri: { type: "string", minLength: 1 },
        name: { type: "string" },
        title: { type: "string" },
      },
    },
  ],
} satisfies JsonSchema;

export const modelMessageContentJsonSchema = {
  oneOf: [{ type: "string" }, { type: "array", items: modelMessageContentBlockJsonSchema }],
} satisfies JsonSchema;

export const modelInputMessageJsonSchema = {
  type: "object",
  required: ["role", "content"],
  additionalProperties: false,
  properties: {
    role: { enum: ["system", "user", "assistant", "tool"] },
    content: modelMessageContentJsonSchema,
    cacheControl: {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: {
        type: { enum: ["ephemeral"] },
        ttl: { enum: ["5m", "1h"] },
        scope: { enum: ["global", "org"] },
      },
    },
    // 拆分时额外收窄条目字段会拒绝官方 blockIndex；沿用原 array 合同。
    toolCalls: { type: "array" },
    toolCallId: { type: "string" },
    toolName: { type: "string" },
    isError: { type: "boolean" },
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
    signedReasoningReset: { type: "boolean" },
  },
} satisfies JsonSchema;

export const modelToolChoiceJsonSchema = {
  oneOf: [
    { enum: ["auto", "none", "required"] },
    {
      type: "object",
      required: ["type", "toolName"],
      additionalProperties: false,
      properties: { type: { enum: ["tool"] }, toolName: { type: "string", minLength: 1 } },
    },
  ],
} satisfies JsonSchema;

export const modelTextRequestJsonSchema = {
  type: "object",
  required: ["messages"],
  additionalProperties: false,
  properties: {
    messages: { type: "array", items: modelInputMessageJsonSchema },
    tools: { type: "array" },
    toolSearchEnabled: { type: "boolean" },
    toolChoice: modelToolChoiceJsonSchema,
    temperature: { type: "number" },
    maxOutputTokens: { type: "number" },
    topP: { type: "number" },
    topK: { type: "number" },
    presencePenalty: { type: "number" },
    frequencyPenalty: { type: "number" },
    stopSequences: { type: "array", items: { type: "string" } },
    seed: { type: "number" },
    responseJsonSchema: { type: "object" },
    providerOptions: { type: "object" },
    metadata: { type: "object" },
  },
} satisfies JsonSchema;
