import type { UserInstructionsEntry2 } from "./contract.js";
/** 调用方持有既有入口；示例只转交一次相同意图，不装配进程或读真实目录。 */
export function exampleUserInstructions(
  api: UserInstructionsEntry2,
  ...args: Parameters<UserInstructionsEntry2["createUserInstructionsPersistence"]>
): ReturnType<UserInstructionsEntry2["createUserInstructionsPersistence"]> {
  return api.createUserInstructionsPersistence(...args);
}
