import { z } from "zod";
import { OFFICIAL_MCP_TOOL_ERROR_CODES } from "@zcode/shared";
import {
  MCP_APPS_RESOURCE_URI_MAX_CHARS,
  MCP_APPS_CONTENT_MAX_BYTES,
  MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  MCP_APPS_SURFACE_ID_MAX_CHARS,
  MCP_APPS_SURFACE_ID_PATTERN,
  MCP_APPS_WIDGET_META_MAX_BYTES,
} from "@zcode/shared/mcp-apps";
import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  CreateWorkflowCausalityGraphSchema,
  CreateWorkflowOutputSchema,
  createWorkflowToolResultDisplayDiagnosticSchema,
} from "./create-workflow.js";
import {
  evalWorkflowSnippetToolResultDisplayPayloadSchema,
  getWorkflowRunToolResultDisplayPayloadSchema,
  listModelsToolResultDisplayPayloadSchema,
  listWorkflowRunsToolResultDisplayPayloadSchema,
  resumeWorkflowRunToolResultDisplayPayloadSchema,
  savedWorkflowListToolResultDisplayPayloadSchema,
} from "./workflow-observation-display.js";
import { toolSearchToolResultDisplayPayloadSchema } from "./tool-search.js";

export const COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION = 1;

export const TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS = 64;

export const TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS = 2_000;

export const MCP_TOOL_DISPLAY_MAX_NAME_CHARS = 256;

export const MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS = 4 * 1024;

export const CUA_TARGET_APP_DISPLAY_META_KEY = "zcode.cua/target-app-display-v1" as const;

export const applicationIconLocatorSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("darwin-bundle-id"), value: z.string().trim().min(1).max(512) })
    .strict(),
  z
    .object({
      kind: z.literal("windows-executable-path"),
      value: z.string().trim().min(1).max(32_768),
    })
    .strict(),
  z.object({ kind: z.literal("windows-aumid"), value: z.string().trim().min(1).max(512) }).strict(),
]);

export const cuaTargetAppDisplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: z.string().trim().min(1).max(512).optional(),
    iconLocators: z.array(applicationIconLocatorSchema).max(3),
  })
  .strict();

export const cuaRequestAccessStatusDisplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.literal("darwin"),
    grantOwner: z.string().trim().min(1).max(512),
    accessibility: z.enum(["granted", "stale", "denied"]),
    screenRecording: z.enum(["granted", "denied", "unknown"]),
  })
  .strict();

// CreateWorkflow display 诊断的限长常量与条目 schema 已移至 create-workflow.ts
// （被 create_workflow 与 eval_workflow_snippet 两个 display payload 复用，放这里会成环）。

export const toolResultDisplayDiffHunkSchema = z
  .object({
    oldStart: z.number().int(),
    oldLines: z.number().int(),
    newStart: z.number().int(),
    newLines: z.number().int(),
    lines: z.array(z.string()),
  })
  .strict();

export const fileDiffToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("file_diff"),
    filePath: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    structuredPatch: z.array(toolResultDisplayDiffHunkSchema),
    truncated: z.boolean().optional(),
  })
  .strict();

export const localAgentMessageToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("local_agent_message"),
    status: z.enum(["success", "failed"]),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

export const taskStopToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("task_stop"),
    taskId: z.string().min(1),
    taskType: z.string().min(1),
    command: z.string().min(1).optional(),
    message: z.string().min(1),
    truncated: z.boolean().optional(),
  })
  .strict();

export const taskOutputToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS).optional(),
    output: z.string().min(1).max(TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS).optional(),
    truncated: z.literal(true).optional(),
  })
  .strict();

export const respondToCoordinatorToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  })
  .strict();

export const cuaToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("cua"),
    schemaVersion: z.literal(1),
    toolName: z.string().min(1),
    status: z.enum(["success", "failed"]),
    // 旧 v1 历史记录曾重复携带 ToolCallRow.input；只为回放兼容继续接受，新 producer 不再写入。
    input: z.string().optional(),
    structuredContent: z.string().optional(),
    text: z.string().optional(),
    errorCode: z.string().optional(),
    suggestedAction: z.string().optional(),
    targetApp: cuaTargetAppDisplaySchema.optional(),
    permissionStatus: cuaRequestAccessStatusDisplaySchema.optional(),
    media: z
      .array(
        z
          .object({
            mimeType: z.string().min(1),
            // 256 KiB 原始图片编码后的最大 base64 长度；总预算由投影器执行。
            data: z.string().min(1).max(349_528).optional(),
            artifactUri: z.string().min(1).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * node_repl cell 的目标应用身份（Computer Use）。`appKey` 是 producer 的形态：
 * `darwin:<bundleId>` / `windows-aumid:<aumid>` / `windows-exe:<path>` / `linux-exe:<path>`；
 * UI 按前缀派生 `ApplicationIconLocator` 再交给平台服务解析，协议不承载图标字节。
 */
export const nodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const nodeReplImageToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("node_repl_images"),
    // images 可选而不是 min(1)：CUA 的纯动作 cell（点击、输入）没有截图，但仍要投影 app 身份。
    // kind 名保留为 node_repl_images —— 改名会让已持久化的 row 在 strict union 里整段被剥掉。
    images: z
      .array(
        z
          .object({
            base64: z
              .string()
              .min(1)
              .max(200 * 1024),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .optional(),
    app: nodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

/**
 * 插件 UI 元数据。
 * contracts 仍在 zod v3，无法直接复用 `@zcode/shared/mcp-apps` 的 zod v4 schema 对象，这里按同一常量
 * 手写一份；字段集合与 `mcpToolDisplayUiSchema` 必须一致，由 core/tests/mcp-ui-display.test.ts 用同一
 * fixture 双侧 parse 锁住。
 */
export const mcpToolDisplayUiPayloadSchema = z
  .object({
    pluginId: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    resourceUri: z.string().min(1).max(MCP_APPS_RESOURCE_URI_MAX_CHARS),
    preferredDisplayMode: z.enum(["inline", "fullscreen", "pip"]).optional(),
    prefersBorder: z.boolean().optional(),
    csp: z
      .object({
        connectDomains: z.array(z.string().min(1).max(512)).optional(),
        resourceDomains: z.array(z.string().min(1).max(512)).optional(),
      })
      .strict()
      .optional(),
    structuredContent: z.string().max(MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES).optional(),
    widgetMeta: z.string().max(MCP_APPS_WIDGET_META_MAX_BYTES).optional(),
    // 原始 content 数组 JSON（≤ 32 KiB）与被省略字节数；与 shared mcpToolDisplayUiSchema 同步。
    content: z.string().max(MCP_APPS_CONTENT_MAX_BYTES).optional(),
    truncated: z.boolean().optional(),
    truncatedBytes: z.number().int().nonnegative().optional(),
    // MCP isError 结果（调用完成但工具报错），与 shared 同步。
    isError: z.literal(true).optional(),
    // 工具级强制常驻，与 shared 同步。
    showInline: z.literal(true).optional(),
    // 与 shared mcpToolDisplayUiSchema 同步；已删 widgetStateVisibility。
    surface: z
      .string()
      .min(1)
      .max(MCP_APPS_SURFACE_ID_MAX_CHARS)
      .regex(MCP_APPS_SURFACE_ID_PATTERN)
      .optional(),
  })
  .strict();

export const mcpToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    toolName: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    description: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS).optional(),
    /**
     * 官方 Server MCP 判定本次调用不可用时下发的结构化标识（额度耗尽 / 无 Coding Plan）。
     * 只在 tool result 为 isError 且该 MCP 为官方来源时出现，UI 据此在输入框上方提示。
     * 与 code 同源：`@zcode/shared` 的 OFFICIAL_MCP_TOOL_ERROR_CODES。
     */
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
    // 与 `@zcode/shared` v4 toolDisplay 的 mcp_tool.ui 同步；两侧都是 strict，缺一处会被 zod 静默 strip。
    ui: mcpToolDisplayUiPayloadSchema.optional(),
  })
  .strict();

/**
 * ⚠ 这个字段集合是**冻结**的。既有 kind 上多出来的键不是「旧客户端少读一个字段」，而是整块 display
 * 校验不过：两个真实的 strict 解析点（packages/ui 的 create-workflow renderer safeParse，
 * 与 legacy v3 的按 kind 查表）会连带把整条工具结果丢掉。gate 专属的事实一律走**工具入参**
 * 通道（那一侧对所有版本都无 schema），可复用工作流的 saved 来源就是这么做的。
 */
export const createWorkflowToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(createWorkflowToolResultDisplayDiagnosticSchema)
      .max(CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS),
    // 工具输出边界已限长（见 create-workflow.ts 的图 schema），display 直接复用同一契约。
    causalityGraph: CreateWorkflowCausalityGraphSchema.optional(),
    // fill 已在 shared strict display 中声明；producer 遗漏会导致成功/拒绝行整块 metadata 被拒收。
    // 复用输出的有界 strict 契约，保持 siteId/name/draftPath/line 与 shared 镜像一致。
    fill: CreateWorkflowOutputSchema.shape.fill,
    truncated: z.boolean().optional(),
  })
  .strict();

// contracts 使用 zod v3，App 使用 v4；与 shared/bash-output-display.ts 保持同一严格契约。
const bashOutputDisplaySchema = z
  .object({
    kind: z.literal("bash_output"),
    output: z.string().max(150_000),
    truncated: z.boolean(),
    outputPath: z.string().min(1).max(32_768).optional(),
  })
  .strict();

export const toolResultDisplayPayloadSchema = z.discriminatedUnion("kind", [
  bashOutputDisplaySchema,
  fileDiffToolResultDisplayPayloadSchema,
  localAgentMessageToolResultDisplayPayloadSchema,
  taskStopToolResultDisplayPayloadSchema,
  taskOutputToolResultDisplayPayloadSchema,
  toolSearchToolResultDisplayPayloadSchema,
  respondToCoordinatorToolResultDisplayPayloadSchema,
  cuaToolResultDisplayPayloadSchema,
  nodeReplImageToolResultDisplayPayloadSchema,
  mcpToolResultDisplayPayloadSchema,
  createWorkflowToolResultDisplayPayloadSchema,
  getWorkflowRunToolResultDisplayPayloadSchema,
  listWorkflowRunsToolResultDisplayPayloadSchema,
  evalWorkflowSnippetToolResultDisplayPayloadSchema,
  savedWorkflowListToolResultDisplayPayloadSchema,
  listModelsToolResultDisplayPayloadSchema,
  resumeWorkflowRunToolResultDisplayPayloadSchema,
]);

export type FileDiffToolResultDisplayPayload = z.infer<
  typeof fileDiffToolResultDisplayPayloadSchema
>;

export type LocalAgentMessageToolResultDisplayPayload = z.infer<
  typeof localAgentMessageToolResultDisplayPayloadSchema
>;

export type TaskStopToolResultDisplayPayload = z.infer<
  typeof taskStopToolResultDisplayPayloadSchema
>;

export type TaskOutputToolResultDisplayPayload = z.infer<
  typeof taskOutputToolResultDisplayPayloadSchema
>;

export type RespondToCoordinatorToolResultDisplayPayload = z.infer<
  typeof respondToCoordinatorToolResultDisplayPayloadSchema
>;

export type CuaToolResultDisplayPayload = z.infer<typeof cuaToolResultDisplayPayloadSchema>;

export type ApplicationIconLocator = z.infer<typeof applicationIconLocatorSchema>;

export type CuaTargetAppDisplay = z.infer<typeof cuaTargetAppDisplaySchema>;

export type CuaRequestAccessStatusDisplay = z.infer<typeof cuaRequestAccessStatusDisplaySchema>;

export type NodeReplImageToolResultDisplayPayload = z.infer<
  typeof nodeReplImageToolResultDisplayPayloadSchema
>;

export type McpToolResultDisplayPayload = z.infer<typeof mcpToolResultDisplayPayloadSchema>;

export type CreateWorkflowToolResultDisplayPayload = z.infer<
  typeof createWorkflowToolResultDisplayPayloadSchema
>;

export type NodeReplCuaAppDisplay = z.infer<typeof nodeReplCuaAppDisplaySchema>;

export type ToolResultDisplayPayload = z.infer<typeof toolResultDisplayPayloadSchema>;
