import type { ServerDockerArgumentsEntry1 } from "./contract.js";
/** 调用方持有既有入口；示例只转交一次相同意图，不装配进程或读真实目录。 */
export function exampleServerDockerArguments(
  api: ServerDockerArgumentsEntry1,
  ...args: Parameters<ServerDockerArgumentsEntry1["quotePosixShellArg"]>
): ReturnType<ServerDockerArgumentsEntry1["quotePosixShellArg"]> {
  return api.quotePosixShellArg(...args);
}
