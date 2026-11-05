import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { normalizeFeatureBoundaryGraph } from "../src/data/featureBoundaryGraphSource.js";
import { parse as parseYaml } from "yaml";
import { type Plugin } from "vite";

export const FEATURE_BOUNDARY_GRAPH_MODULE_ID = "virtual:zcode-feature-boundary-graph";

export const FEATURE_BOUNDARY_GRAPH_RESOLVED_ID = `\0${FEATURE_BOUNDARY_GRAPH_MODULE_ID}`;

export const FEATURE_BOUNDARY_GRAPH_SOURCE_PATH = resolve(
  __dirname,
  "../../../.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml",
);

export async function buildFeatureBoundaryGraphModule() {
  const source = await readFile(FEATURE_BOUNDARY_GRAPH_SOURCE_PATH, "utf-8");
  const graph = normalizeFeatureBoundaryGraph(parseYaml(source));
  return `export default ${JSON.stringify(graph)};`;
}

export function featureBoundaryGraphPlugin(): Plugin {
  let moduleSource = "";
  return {
    name: "zcode-dev-docs-feature-boundary-graph",
    configureServer(server) {
      server.watcher.add(FEATURE_BOUNDARY_GRAPH_SOURCE_PATH);
    },
    async buildStart() {
      moduleSource = await buildFeatureBoundaryGraphModule();
    },
    resolveId(id) {
      return id === FEATURE_BOUNDARY_GRAPH_MODULE_ID
        ? FEATURE_BOUNDARY_GRAPH_RESOLVED_ID
        : undefined;
    },
    async load(id) {
      if (id !== FEATURE_BOUNDARY_GRAPH_RESOLVED_ID) {
        return undefined;
      }
      if (!moduleSource) {
        moduleSource = await buildFeatureBoundaryGraphModule();
      }
      return moduleSource;
    },
    async handleHotUpdate({ file, server }) {
      if (resolve(file) !== FEATURE_BOUNDARY_GRAPH_SOURCE_PATH) {
        return undefined;
      }
      moduleSource = await buildFeatureBoundaryGraphModule();
      const module = server.moduleGraph.getModuleById(FEATURE_BOUNDARY_GRAPH_RESOLVED_ID);
      if (module) {
        server.moduleGraph.invalidateModule(module);
        return [module];
      }
      return undefined;
    },
  };
}
