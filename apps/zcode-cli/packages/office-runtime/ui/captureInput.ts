import { z } from "zod";
import { OfficeError } from "#office/contract.ts";

export const CAPTURE_INPUT = {
  type: "object",
  properties: {
    anchor: {
      type: "string",
      minLength: 1,
      maxLength: 1200,
      description: "Location to capture; defaults to the visible view.",
    },
    maxWidth: {
      type: "integer",
      minimum: 320,
      maximum: 2000,
      description: "Maximum image width in pixels (default 1600).",
    },
  },
  additionalProperties: false,
} as const;
const captureSchema = z
  .object({
    anchor: z.string().trim().min(1).max(1200).optional(),
    maxWidth: z.number().int().min(320).max(2000).optional(),
  })
  .strict();

export function parseCaptureInput(input: unknown): { anchor?: string; maxWidth?: number } {
  const result = captureSchema.safeParse(input);
  if (!result.success) throw new OfficeError("invalid_anchor", "Invalid capture input.");
  return result.data;
}
