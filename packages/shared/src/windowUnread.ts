import { z } from "zod";

export const windowUnreadSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    count: z.number().int().nonnegative(),
    taskKeys: z.array(z.string().min(1).max(16_384)).max(100_000),
  })
  .strict()
  .refine((snapshot) => snapshot.count === new Set(snapshot.taskKeys).size);

export type WindowUnreadSnapshot = z.infer<typeof windowUnreadSnapshotSchema>;
export type WindowUnreadProjection = number | WindowUnreadSnapshot;
