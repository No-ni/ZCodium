import type { PluginManagementState, SubagentsStoreState } from "./contract.js";

/** 消费者只读取原 Store 的状态，不在契约层创建副本或服务。 */
export function exampleStoreLoading(
  state: Pick<PluginManagementState | SubagentsStoreState, "loading">,
): boolean {
  return state.loading;
}
