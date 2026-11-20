import { z } from "zod";

const identifier = z.string().min(1).max(512);
const count = z.number().finite().nonnegative();
const base = {
  version: z.literal(1),
  instanceId: identifier,
  eventId: identifier,
  sessionId: identifier,
  occurredAt: count,
};
const request = { requestId: identifier, providerId: identifier, modelId: identifier };

/** 本机 live-only 白名单；不能把 SessionEvent 或 Provider 请求对象直接透传。 */
export const localGenerationFactSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("chunk"), chars: count.int() }),
  z.strictObject({ ...base, ...request, kind: z.enum(["started", "retry", "failed"]) }),
  z.strictObject({
    ...base,
    ...request,
    kind: z.literal("completed"),
    durationMs: count,
    timeToFirstContentMs: count.optional(),
    outputTokens: count.int().optional(),
  }),
]);
export type LocalGenerationFact = z.infer<typeof localGenerationFactSchema>;
