// ============================================================
// CreateWorkflow Tool - typecheck a dynamic-workflow script and start a background run
// ============================================================
import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { SAVED_WORKFLOW_MAX_NAME_CHARS, SavedWorkflowScopeSchema } from "./saved-workflow.js";
import {
  WorkflowAdjustableSettingsSchema,
  WorkflowModelBindingsSchema,
} from "./workflow-settings.js";

export const CREATE_WORKFLOW_TOOL_NAME = "CreateWorkflow";

/**
 * 教模型写工作流的内置技能名（apps/zcode-cli/packages/bundled-skills/skills/<name>/SKILL.md）。
 * 四个创作工具（Create/Amend/Save/EvalWorkflowSnippet）的 resolveInput 以它为门：会话里没有
 * 加载过这份技能就拒绝提交脚本（docs/dynamic-workflow/authoring.md「The authoring surface」）。
 * 住在 contracts 里是因为 core 的门与 bootstrap 的技能包都读它，而两者不能互相 import。
 */
export const DYNAMIC_WORKFLOW_SKILL_NAME = "dynamic-workflows";

/**
 * 「一个来源都没到」的共用尾句（CreateWorkflow 与 EvalWorkflowSnippet；两者字段全可选）。
 *
 * Bug 原因：参数不是合法 JSON 时，adapter 记 `model.tool_input.normalize_failed` 后把调用恢复成
 * `{}`（adapters/src/model/tool-input-normalization.ts），`{}` 能过 schema，于是在「恰好一个来源」
 * 上失败。旧文案把「多给」与「没给」并成一句「…or none, is ambiguous」，明明写了脚本的模型读不出
 * 原因，只会原样重发同一个坏调用。所以「没给」单独成句，并说出最常见的原因和绕开它的办法。
 */
export const WORKFLOW_SOURCE_MISSING_HINT =
  "If you did pass one, the call's arguments were not valid JSON, and a call that does not parse arrives empty. The usual cause is an unescaped backslash or double quote in the inline source: inside a JSON string a regex's `\\d` must be written `\\\\d`. Escape it, or write the source to a file and pass `path`.";

/** 多给了来源（选择要撤回）。写成常量是因为模型是它唯一的读者，三条路径同一句话。 */
export const CREATE_WORKFLOW_SOURCE_CONFLICT_ERROR =
  "Provide exactly one workflow source: `script` for a one-off script written inline, `saved` to run a workflow saved in this project, or `path` for a script file on disk (the file a previous result named). Passing more than one is ambiguous.";

/** 一个来源都没有：多半是参数没解析出来（见 {@link WORKFLOW_SOURCE_MISSING_HINT}）。 */
export const CREATE_WORKFLOW_SOURCE_MISSING_ERROR = `No workflow source arrived. Pass \`script\` for a one-off script written inline, \`saved\` to run a workflow saved in this project, or \`path\` for a script file on disk. ${WORKFLOW_SOURCE_MISSING_HINT}`;

/** `args` 只属于 `path` 来源的违规说明（`saved` 有自己的 `saved.args`，内联脚本没有声明）。 */
export const CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR =
  "`args` belongs to the `path` source: it carries values for the arguments a script file declares in its `/* zcode-workflow` block. For a saved workflow pass `saved.args`; an inline `script` declares no arguments, so it takes none.";

/**
 * `saved` 来源。模型填 `name`，可选 `args` 与 `scope`（消歧用）；`path` 是 `resolveInput`
 * 解析后**回填**的事实，`scope` 归一化后也变成命中的那一根，所以两者都可选。
 *
 * 归一化输入因此是一个 `script` 与 `saved` **同时在场**的合法执行态——这正是 XOR 不能写在
 * zod 上的原因（见 {@link CreateWorkflowInputSchema}）。
 */
export const CreateWorkflowSavedSourceSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(SAVED_WORKFLOW_MAX_NAME_CHARS)
      .describe("Name of a saved workflow (see ListSavedWorkflows)."),
    args: z
      .record(z.unknown())
      .optional()
      .describe("Values for the arguments the saved workflow declares."),
    /** 解析回填：保存文件的落点。模型不填。 */
    path: z.string().min(1).optional(),
    /**
     * 消歧：从哪一档取这个 workflow。缺省走既有查找顺序（同名时项目档遮蔽全局档）。
     * 归一化后 `scope` 变成**命中**的那一根，见 create-workflow-source.ts。
     */
    scope: SavedWorkflowScopeSchema.optional().describe(
      "Which archive to take it from; omit for the normal lookup order.",
    ),
  })
  .strict();

export type CreateWorkflowSavedSource = z.infer<typeof CreateWorkflowSavedSourceSchema>;

/**
 * 运行时的 `saved` 块：模型面那些字段 + `draft`。
 *
 * `draft` 是 `resolveInput` 写下那份工作副本之后回填的**落点**：保存的定义永远不因为一次 run 被改动，模型要改的是这份拷贝。它与
 * `AmendWorkflow.predecessor` 同一个姿态——事实由工具算，模型的 JSON schema 不列它，所以模型
 * 不会以为自己该填一个路径。写不下去时字段整个缺席（草稿是尽力而为）。
 */
export const CreateWorkflowResolvedSavedSourceSchema = CreateWorkflowSavedSourceSchema.extend({
  draft: z.string().min(1).optional(),
}).strict();

export type CreateWorkflowResolvedSavedSource = z.infer<
  typeof CreateWorkflowResolvedSavedSourceSchema
>;

/**
 * 执行体有三个来源，恰好给一个——但这条 XOR **刻意不写在 schema 上**。
 *
 * 理由是归一化：`resolveInput` 把保存的脚本（或 `path` 文件）解析出来之后，输入同时带着
 * `script`（要跑的字节）与 `saved` / `path`（它的来龙去脉）。一条 superRefine 会在两个地方炸掉
 * 这个合法形状——handler 自己的 `parse`，以及 hook 改写输入后 call-runner 的二次校验——而且
 * **只在非内联路径上**炸，属于那种测不到就上线的错误。XOR 因此由 `entry.validateInput` 在
 * **模型入参**上强制，那里正是它唯一为真的地方。JSON schema 本来也表达不了 refinement，
 * 模型侧靠字段描述引导。
 */
const CreateWorkflowModelInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Short run label in the user's language. Always pass it for an inline script; defaults to the saved workflow's name.",
      ),
    script: z
      .string()
      .optional()
      .describe("The whole workflow script, inline. Exactly one of `script`, `saved` and `path`."),
    saved: CreateWorkflowSavedSourceSchema.optional().describe(
      "A saved workflow to run, by name. Exactly one of `script`, `saved` and `path`.",
    ),
    /**
     * 第三条来源：
     * 盘上的一个脚本文件。它是内联提交的**回程**——工具写下草稿、结果点名那个文件，模型下一次
     * 只改一行再把同一个路径交回来。带 `/* zcode-workflow` 块的文件按保存定义解析（块剥掉、
     * 正文当脚本、`args` 按块里的声明校验）。
     */
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A script file on disk (relative or absolute), usually the file a previous result named. Exactly one of `script`, `saved` and `path`.",
      ),
    /**
     * `path` 文件声明的实参。`saved` 有自己的 `saved.args`（同一套校验规则），内联脚本没有声明，
     * 所以这个字段与 `path` 同进同退——`validateInput` 在模型入参上把这条钉住。
     */
    args: z
      .record(z.unknown())
      .optional()
      .describe("Values for the arguments a `path` file declares. Only with `path`."),
    /**
     * run 自己的并发上界（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）。高于或低于
     * 默认并发都行、没有上限：`resolveInput` 只向下取整到至少 1，确认窗与 handler 看到的就是将要生效的
     * 值。缺席即默认并发。只在用户要求时设——provider 限流由运行时自适应，模型不该拿它当保险。
     */
    max_concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Subagents working at once, above or below the default. Only when the user asks for more or less parallelism; never as a reaction to provider errors.",
      ),
    /**
     * 本 run 子代理跑在哪个模型上。与
     * `max_concurrency` 同族：模型面收一个宽松的字符串，`resolveInput` 经模型目录端口解析成
     * 规范形 `providerId/modelId[$reasoningLevel]`——确认窗与 handler 读到的就是将要生效的值，
     * 解不出来在开窗**之前**就作为业务失败退回。主代理自己恒留在会话模型上；缺席即子代理也是。
     */
    subagent_model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Model for the subagents (`providerId/modelId` or a model id). Only when the user asks, and never a model under another provider the user did not name — ask them first if one would help; you stay on the session model.",
      ),
    // 修订续跑不在这里：它是 `AmendWorkflow` 的工作（amend-workflow.ts）。`.strict()` 让旧写法 `resume_from` 成为可见的 schema 错误，
    // 而不是被静默忽略后变成一次全价重跑。
  })
  .strict();

/**
 * 运行时入参：模型面那些字段 + `resolveInput` 回填的事实。
 *
 * 回填项与 `AmendWorkflow.predecessor` 同一个姿态——模型的 JSON schema 不列它们，因为它们不是
 * 可填的参数而是解析结果；模型若硬填，归一化会无条件覆盖。
 */
export const CreateWorkflowInputSchema = CreateWorkflowModelInputSchema.extend({
  saved: CreateWorkflowResolvedSavedSourceSchema.optional(),
  /**
   * 正文行 → 文件行的偏移（`path` / `saved` 文件带元数据块时才非零）。诊断按文件行报出来时
   * 加它，好让行号能直接粘进一次对该文件的 `Edit`。
   */
  script_line_offset: z.number().int().nonnegative().optional(),
  /**
   * 确认窗可调的两项设置（docs/dynamic-workflow/launch.md「Adjusting the settings in the window」），
   * 端口在场时由 `resolveInput` 回填。同上：解析结果，模型的 JSON schema 不列它。
   */
  adjustable_settings: WorkflowAdjustableSettingsSchema.optional(),
  /**
   * 脚本点名的模型解析成的绑定表（docs/dynamic-workflow/launch.md「Models the script names」），
   * `resolveInput` 回填。同上：解析结果，模型的 JSON schema 不列它。
   */
  model_bindings: WorkflowModelBindingsSchema.optional(),
}).strict();

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInputSchema>;

/** 交给模型的 JSON schema：不含 `script_line_offset`、`adjustable_settings` 与 `model_bindings`，`saved` 里也不含 `draft`。 */
export const CreateWorkflowInputJsonSchema = toToolJsonSchema(CreateWorkflowModelInputSchema);
