// ============================================================
// CreateWorkflow Tool - typecheck a dynamic-workflow script and start a background run
// ============================================================
import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { CreateWorkflowCausalityGraphSchema } from "./create-workflow-graph.js";

export const CreateWorkflowDiagnosticSchema = z
  .object({
    code: z.number(),
    column: z.number(),
    line: z.number(),
    message: z.string(),
  })
  .strict();

export type CreateWorkflowDiagnostic = z.infer<typeof CreateWorkflowDiagnosticSchema>;

// CreateWorkflow display 是独立于模型文本的有界投影：诊断可能很多，必须在协议边界限长，
// 避免类型检查结果把 continuous/replayable 消息扩成无界载荷。
// 诊断的 display 条目形状同时被 create_workflow 与 eval_workflow_snippet 两个 display
// payload 复用（同一 TS 诊断形状、同一道限长），因此定义在这里而不是 tool-result-metadata.ts
// ——后者要反向引用本文件里的 schema，放那里会成环。
export const CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS = 100;

export const CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS = 2_048;

export const createWorkflowToolResultDisplayDiagnosticSchema = z
  .object({
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    code: z.number().int().nonnegative(),
    message: z.string().min(1).max(CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
  })
  .strict();

// 两个新字段只在「确认后真启动了一个 run」时出现；诊断-only 的结果保持原形状。
// 走显式 schema 而不是经 raw 夹带：.strict() 的意义就是形状变更必须是一次显式提交。
export const CreateWorkflowOutputSchema = z
  .object({
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    ok: z.boolean(),
    response: z.string(),
    causalityGraph: CreateWorkflowCausalityGraphSchema.optional(),
    /** 仅在启动了后台 run 时出现；不是通用状态字段，故只收这一个字面量。 */
    status: z.literal("backgrounded").optional(),
    /** 后台任务 id ≡ taskId ≡ runId（取消与状态查询都以它为键）。 */
    backgroundTaskId: z.string().min(1).optional(),
    /**
     * `FillWorkflowHole` 补的是哪处留白：站点 id 与**名字**，外加草稿路径与行号。成功与被拒都在场，
     * **跨 v4**——display 投影原样带上它，工具行靠它给自己起名。不能从行的入参读：transcript 存的是
     * 模型自己的入参，resolveInput 回填的 `hole` 块到不了行。
     */
    fill: z
      .object({
        siteId: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        /** 成功补全的 journal durable 顺序；被拒补全缺席。 */
        commitSequence: z.number().int().nonnegative().optional(),
        draftPath: z.string().min(1).max(1_024).optional(),
        line: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /**
     * `AmendWorkflow` 只改并发、就地生效时才在场（docs/dynamic-workflow/launch.md「Changing only
     * the parallelism of a live run」）：**没有**新 run，所以既没有 `status: "backgrounded"` 也没有
     * `backgroundTaskId`，run 还是调用里那一个。
     *
     * 是一个显式的块而不是让消费方按形状去猜：「ok 且没有 status」在这个工具上还有别的来路
     * （没有 run 端口时的「只 typecheck」）。数都是绝对值，`maxConcurrency === defaultConcurrency` 即
     * 「这个 run 没有自己的界」。
     *
     * ⚠ 这条事实**不跨 v4**：协议的 `toolOutputSchema` 只带 `text` / `display` / `truncated`，
     * 所以它服务的是 CLI/TUI、进程内消费方与契约测试，桌面 UI 读不到它。
     */
    retuned: z
      .object({
        runId: z.string().min(1),
        maxConcurrency: z.number().int().positive(),
        previous: z.number().int().positive(),
        defaultConcurrency: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CreateWorkflowOutput = z.infer<typeof CreateWorkflowOutputSchema>;

export const CreateWorkflowOutputJsonSchema = toToolJsonSchema(CreateWorkflowOutputSchema);
