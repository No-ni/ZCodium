import type { ProjectMemoryRuntimeEntry1 } from "./contract.js";
/** 调用方持有既有入口；示例只转交一次相同意图，不装配进程或读真实目录。 */
export function exampleProjectMemoryRuntime(api: ProjectMemoryRuntimeEntry1, ...args: Parameters<ProjectMemoryRuntimeEntry1["selectProjectDreamSessions"]>): ReturnType<ProjectMemoryRuntimeEntry1["selectProjectDreamSessions"]> {
return api.selectProjectDreamSessions(...args);
}
