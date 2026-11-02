import { defineConfig } from "vitest/config";

// 根单测入口按固定项目清单加载；本文件缺失会让根 suites 在发现公共测试前直接终止。
// 旧后端（@trycua/cua-driver）的逐条行为测试仍走 `node --test test/*.test.mjs`（package.json#scripts.test），
// 这里只承载与宿主 runtime contract 相关的 vitest 回归，供根 suites 统一编排。
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "cua-driver",
    include: ["test/**/*.test.ts"],
    // 根项目已有普通与串行两组；独立分组避免不同 worker 数使整个单测入口退出。
    maxWorkers: 1,
    sequence: { groupOrder: 2 },
  },
});
