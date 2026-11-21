/** 兼容公开入口；声明按职责由内部叶文件唯一提供。 */
export {
  GoalStatus,
  MAX_GOAL_OBJECTIVE_CHARS,
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  GOAL_COMPLETION_VERIFICATION_FALLBACK_REASON,
  GoalStatusSchema,
  GoalTokenBudgetSchema,
  GoalObjectiveSchema,
  SessionGoalSchema,
  GoalReadInputSchema,
  GoalReadInputJsonSchema,
  GoalReadOutputSchema,
  GoalReadOutputJsonSchema,
  GoalCompletionVerificationOutputSchema,
  normalizeGoalObjective,
} from "./goal-schema.js";
export type {
  SessionGoal,
  GoalReadInput,
  GoalReadOutput,
  GoalCompletionVerificationOutput,
} from "./goal-schema.js";
export {
  formatGoalStateForModel,
  formatGoalContinuationPrompt,
  formatGoalCompletionVerificationPrompt,
  formatGoalCompletionVerificationFailurePrompt,
  formatGoalCompletionVerificationPassedContent,
  escapeGoalPromptText,
} from "./goal-prompts.js";
export {
  parseGoalCompletionVerificationText,
  failedGoalCompletionVerification,
  failOpenGoalCompletionVerification,
} from "./goal-verification-parser.js";
export {
  TargetStatus,
  MAX_TARGET_OBJECTIVE_CHARS,
  TARGET_COMPLETION_VERIFICATION_QUERY_SOURCE,
  TargetStatusSchema,
  TargetTokenBudgetSchema,
  TargetObjectiveSchema,
  SessionTargetSchema,
  TargetReadInputSchema,
  TargetReadInputJsonSchema,
  TargetReadOutputSchema,
  TargetReadOutputJsonSchema,
  TargetCompletionVerificationOutputSchema,
  normalizeTargetObjective,
  formatTargetStateForModel,
  formatTargetContinuationPrompt,
  formatTargetCompletionVerificationPrompt,
  formatTargetCompletionVerificationFailurePrompt,
  formatTargetCompletionVerificationPassedContent,
  parseTargetCompletionVerificationText,
  failedTargetCompletionVerification,
  failOpenTargetCompletionVerification,
  escapeTargetPromptText,
} from "./target-compat.js";
export type {
  SessionTarget,
  TargetReadInput,
  TargetReadOutput,
  TargetCompletionVerificationOutput,
} from "./target-compat.js";
