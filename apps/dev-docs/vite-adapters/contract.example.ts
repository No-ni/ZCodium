import { stdioTrafficApiPlugin, featureBoundaryGraphPlugin } from "./index.js";
import type { DevDocsVitePlugins } from "./contract.js";
const plugins: DevDocsVitePlugins = { stdioTrafficApiPlugin, featureBoundaryGraphPlugin };
/** 只构造Vite插件，不启动server、不读取tap文件。 */
export function createDeveloperDocsPlugins() {
  return [plugins.stdioTrafficApiPlugin(), plugins.featureBoundaryGraphPlugin()];
}
