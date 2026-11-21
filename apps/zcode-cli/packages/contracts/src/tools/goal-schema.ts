// ============================================================
// Goal Tools - session-local long-running goal
// ============================================================
import { z } from "zod";
import type { SessionId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

export const GoalStatus = {
  Active: "active",
  Paused: "paused",
  BudgetLimited: "budget_limited",
  Complete: "complete",
} as const;

export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];

export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;

export const GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE = "target_completion_verification";

export const GOAL_COMPLETION_VERIFICATION_FALLBACK_REASON =
  "The completion verifier could not confirm that every goal requirement is complete.";

export const GoalStatusSchema = z.enum(["active", "paused", "budget_limited", "complete"]);

export const GoalTokenBudgetSchema = z
  .number()
  .int()
  .positive("goal token budget must be positive")
  .nullable();

export const GoalObjectiveSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "goal objective must not be empty")
  .refine(
    (value) => Array.from(value).length <= MAX_GOAL_OBJECTIVE_CHARS,
    `goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters`,
  );

export interface SessionGoal {
  sessionID: SessionId;
  // Compatibility: the persisted row and ACP wire payload still call this targetID.
  targetID: string;
  objective: string;
  summaryTitle: string | null;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  activeInputId?: string | null;
  activeRunStartedAtMs?: number | null;
  activeRunLastSeenAtMs?: number | null;
  time: {
    created: number;
    updated: number;
  };
}

export const SessionGoalSchema = z
  .object({
    sessionID: z.string(),
    targetID: z.string(),
    objective: z.string().min(1),
    summaryTitle: z.string().min(1).nullable(),
    status: GoalStatusSchema,
    tokenBudget: GoalTokenBudgetSchema,
    tokensUsed: z.number().int().nonnegative(),
    timeUsedSeconds: z.number().int().nonnegative(),
    activeInputId: z.string().min(1).nullable().optional(),
    activeRunStartedAtMs: z.number().int().nonnegative().nullable().optional(),
    activeRunLastSeenAtMs: z.number().int().nonnegative().nullable().optional(),
    time: z
      .object({
        created: z.number().int().nonnegative(),
        updated: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const GoalReadInputSchema = z.object({}).strict();

export type GoalReadInput = z.infer<typeof GoalReadInputSchema>;

export const GoalReadInputJsonSchema = toToolJsonSchema(GoalReadInputSchema);

export const GoalReadOutputSchema = z
  .object({
    goal: SessionGoalSchema.nullable(),
  })
  .strict();

export interface GoalReadOutput {
  goal: SessionGoal | null;
}

export const GoalReadOutputJsonSchema = toToolJsonSchema(GoalReadOutputSchema);

export const GoalCompletionVerificationOutputSchema = z
  .object({
    nextAction: z.string().optional(),
    passed: z.boolean(),
    reason: z.string(),
  })
  .strict();

export type GoalCompletionVerificationOutput = z.infer<
  typeof GoalCompletionVerificationOutputSchema
>;

export function normalizeGoalObjective(value: string): string {
  return GoalObjectiveSchema.parse(value);
}
