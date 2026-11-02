import type { TurnToolVisibilityEntry1 } from "./contract.js";
/** 调用方持有既有入口；示例只转交一次相同意图，不装配进程或读真实目录。 */
export function exampleTurnToolVisibility(api: TurnToolVisibilityEntry1, ...args: Parameters<TurnToolVisibilityEntry1["getTurnTools"]>): ReturnType<TurnToolVisibilityEntry1["getTurnTools"]> {
return api.getTurnTools(...args);
}
