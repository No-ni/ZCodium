import {
  GoalStatus,
  MAX_GOAL_OBJECTIVE_CHARS,
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
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
import type {
  SessionGoal,
  GoalReadInput,
  GoalReadOutput,
  GoalCompletionVerificationOutput,
} from "./goal-schema.js";
import {
  formatGoalStateForModel,
  formatGoalContinuationPrompt,
  formatGoalCompletionVerificationPrompt,
  formatGoalCompletionVerificationFailurePrompt,
  formatGoalCompletionVerificationPassedContent,
  escapeGoalPromptText,
} from "./goal-prompts.js";
import {
  parseGoalCompletionVerificationText,
  failedGoalCompletionVerification,
  failOpenGoalCompletionVerification,
} from "./goal-verification-parser.js";

export const TargetStatus = GoalStatus;

export type TargetStatus = GoalStatus;

export const MAX_TARGET_OBJECTIVE_CHARS = MAX_GOAL_OBJECTIVE_CHARS;

export const TARGET_COMPLETION_VERIFICATION_QUERY_SOURCE =
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE;

export const TargetStatusSchema = GoalStatusSchema;

export const TargetTokenBudgetSchema = GoalTokenBudgetSchema;

export const TargetObjectiveSchema = GoalObjectiveSchema;

export type SessionTarget = SessionGoal;

export const SessionTargetSchema = SessionGoalSchema;

export const TargetReadInputSchema = GoalReadInputSchema;

export type TargetReadInput = GoalReadInput;

export const TargetReadInputJsonSchema = GoalReadInputJsonSchema;

export const TargetReadOutputSchema = GoalReadOutputSchema;

export type TargetReadOutput = GoalReadOutput;

export const TargetReadOutputJsonSchema = GoalReadOutputJsonSchema;

export const TargetCompletionVerificationOutputSchema = GoalCompletionVerificationOutputSchema;

export type TargetCompletionVerificationOutput = GoalCompletionVerificationOutput;

export const normalizeTargetObjective = normalizeGoalObjective;

export const formatTargetStateForModel = formatGoalStateForModel;

export const formatTargetContinuationPrompt = formatGoalContinuationPrompt;

export const formatTargetCompletionVerificationPrompt = formatGoalCompletionVerificationPrompt;

export const formatTargetCompletionVerificationFailurePrompt =
  formatGoalCompletionVerificationFailurePrompt;

export const formatTargetCompletionVerificationPassedContent =
  formatGoalCompletionVerificationPassedContent;

export const parseTargetCompletionVerificationText = parseGoalCompletionVerificationText;

export const failedTargetCompletionVerification = failedGoalCompletionVerification;

export const failOpenTargetCompletionVerification = failOpenGoalCompletionVerification;

export const escapeTargetPromptText = escapeGoalPromptText;
