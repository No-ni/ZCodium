import type { NativeContextPolicyInput } from "./contract.js";
import { createRecommendedNativeContextConfiguration } from "@zcode/shared/native-context-compression";
export const example: NativeContextPolicyInput = {
  configuration: createRecommendedNativeContextConfiguration("auto"),
  expectedPolicyVersion: 0,
};
