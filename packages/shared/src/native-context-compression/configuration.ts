import { z } from "zod";
import {
  createRecommendedNativeContextParameters,
  nativeContextParametersSchema,
} from "./parameters.js";
import type {
  NativeContextConfiguration,
  NativeContextMode,
  NativeContextPolicy,
} from "./types.js";

export const nativeContextConfigurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["auto", "manual"]),
    parameters: nativeContextParametersSchema,
  })
  .strict() satisfies z.ZodType<NativeContextConfiguration>;

export const nativeContextPolicySchema = nativeContextConfigurationSchema
  .extend({
    policyVersion: z.number().finite().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<NativeContextPolicy>;

export function createRecommendedNativeContextConfiguration(
  mode: NativeContextMode = "auto",
): NativeContextConfiguration {
  return nativeContextConfigurationSchema.parse({
    schemaVersion: 1,
    mode,
    parameters: createRecommendedNativeContextParameters(),
  });
}
