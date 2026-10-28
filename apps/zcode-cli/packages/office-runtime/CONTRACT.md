# office-runtime

内置文档插件（documents、pdf、presentations、spreadsheets）的查看面板共用这一份运行时。每个插件在自己的 package.json 里用 `office` 字段声明面板标题和格式，并把 `build` 脚本指向本包的 `scripts/build.mjs`；构建只保留该插件格式的解析器与查看器，输出到插件根目录的 `dist/`。面板、MCP 工具与锚点语法见 [src/CONTRACT.md](src/CONTRACT.md)。

不变量：

- 插件名取自插件的 `.zcodium-plugin/plugin.json`，它同时是 MCP 服务名、面板 surface id 和 `ui://<name>/` 资源前缀；不能从目录名推导（目录名带 `-plugin` 后缀）。
- 构建必定产出 `contract.ts` 的 `OFFICE_RUNTIME_OUTPUTS`（包括 MIT LICENSE 与第三方许可）。公共 seed、SEA 和 Windows/macOS 桌面准备链路将五项最小输出与 viewer 技能登记为必需资产，仍递归分发完整 `dist`（workers/WASM/字体/原数据许可）。公共接缝的临时编译与分发验证不等于产品发行验收；普通 dev 出口与缓存输入的未接边界见本项 spec §9。
- 产物自包含：`dist/server.mjs` 与面板脚本由 esbuild 打包全部依赖，运行时不读取 `node_modules`；第三方许可随产物写入 `dist/THIRD_PARTY_NOTICES.txt`。
- 查看器只读：面板和工具从不写工作区文件。
