import { z } from "zod";
import { appToolSearchModeSchema } from "./tool-search.js";
export { appToolSearchModeSchema } from "./tool-search.js";
export type { AppToolSearchMode } from "./tool-search.js";
export const DEFAULT_APP_TOOL_SEARCH_MODE = "off" as const;

export const APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL = "settings:app-runtime-preferences";
export const ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV = "ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE";

export const appRuntimePreferencesChangedBroadcastPayloadSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    toolSearchMode: appToolSearchModeSchema.default("off"),
    pluginAutoRecommendationEnabled: z.boolean().default(false),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
