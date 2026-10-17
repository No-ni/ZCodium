import { z } from "zod";

export const v4ConversationTurnDirectoryParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    beforeRowId: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const conversationTurnDirectoryEntrySchema = z
  .object({
    rowId: z.number().int().nonnegative(),
    turnId: z.string(),
    entityId: z.string().optional(),
    userPreview: z.string().max(220),
    assistantPreview: z.string().max(220),
    assistantPreviewKind: z.enum(["empty", "running", "text"]),
    isRunning: z.boolean(),
  })
  .strict();
export const v4ConversationTurnDirectoryResultSchema = z
  .object({
    entries: z.array(conversationTurnDirectoryEntrySchema).max(200),
    atSeq: z.number().int().nonnegative(),
    atLogEpoch: z.string().min(1),
    hasMore: z.boolean(),
  })
  .strict();
export type ConversationTurnDirectoryEntry = z.infer<typeof conversationTurnDirectoryEntrySchema>;
export type V4ConversationTurnDirectoryParams = z.infer<
  typeof v4ConversationTurnDirectoryParamsSchema
>;
export type V4ConversationTurnDirectoryResult = z.infer<
  typeof v4ConversationTurnDirectoryResultSchema
>;
