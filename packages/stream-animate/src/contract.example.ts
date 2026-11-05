import { startStreamAnimateServer } from "./index.js";
import type { StreamAnimateContract } from "./contract.js";
const profiler: StreamAnimateContract = { startStreamAnimateServer };
/** 调用方显式提供获准的工作树root，关闭时等待同一server释放。 */
export async function exampleStartProfiler(packageRoot: string) {
  return profiler.startStreamAnimateServer({ packageRoot, dev: false, port: 5187 });
}
