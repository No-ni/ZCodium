# MCP Node fallback

为使用 Electron Node 的 MCP stdio 接入准备 Node/npm/npx shim。现有公开入口仍为上一级 node-fallback.ts，接口声明集中在 contract.ts，实现由 adapter.ts 承担。

provider 仅持有原有 resolve 准备 flight，同一 provider 的成功或不可用结果复用；不同 provider 共享按 shim 路径的文件锁。检查与原子发布在同一锁内完成，真实权限或写入错误继续沿既有不可用路径返回，不新增缓存、服务或执行入口。

shim 目录与 npm 候选由调用方提供。stdio 环境合并后追加一次 shim PATH，系统 Node/npm/npx 优先；Windows 只写一个 PATH 键。机器位置通过既有环境合同传入静态 shim，正文不写入安装路径。

规格和跨平台边界见 [MCP Node fallback](../../../../../docs/design/v2/mcp-node-fallback.md)，回归见 [mcp-node-fallback.test.ts](../../../tests/mcp-node-fallback.test.ts)。桌面发行平台继续由 Windows/macOS 构建政策约束，通用 shim 渲染不引入 Linux 分发依赖。
