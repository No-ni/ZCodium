# 官方 3.16.2 收尾：Bash 注册表跨平台哈希

## 实证与边界

本轮隔离工作区的 CLI `check` 被 `registry:check` 阻断。原工作区同入口同样失败，generator、已提交生成文件及 `@withfig/autocomplete@2.692.3` 的 1489 个 build 文件两树逐字一致。独立 OS-temp 生成的 707 个命令根 payload 与原生成文件完全相同，只有 source hash 注释和常量不同。将源相对路径用正斜杠计算时恰好得到已提交 hash；Windows 的反斜杠得到另一个 hash。这是已复现的路径编码缺陷，不是 registry 内容过期、排序、依赖版本或 adoption 新增语义。

只在 `zcodium-adopt-3.16.2` 修改 generator 和定向回归。不写原工作区、不重生成或格式化 payload，不升级依赖、不改变 Fig pin，不放宽 `--check`、Lint 或 baseline，不调用真实模型、安装、发行、提交或推送。

## 一个 owner 与一条路径

`apps/zcode-cli/scripts/generate-bash-command-registry.mjs` 是生成文件和其 source hash 的唯一 owner。继续以原递归排序的相对文件路径、NUL 分隔、完整字节构造 SHA-256；仅在 hash 输入边界把本机 `sep` 归一为 `/`。实际文件读取仍用原生路径。文件内容、目录顺序、输出 schema、生成字节比较和大小上限不变，不添加第二份 registry 或平台专用生成物。

## 验收

先新增回归并在原 generator 上证实 Windows/POSIX 哈希不一致，再实施。直接从生产 generator AST 提取并执行 `hashBuildFiles`，用等价跨平台路径和字节验证 hash 相同；内容、相对路径或文件顺序改变仍改变 hash，不弱化完整性。真实已安装固定 Fig 包执行 `--check` 必须通过，生成文件前后 SHA-256 不变。fixture 只写 OS-temp，finally 清理；无产品构建或真实数据 IO。

检查使用 PowerShell 7、corepack pnpm、实际 Node 24.18.0（pin 24.14.0）。记录根/CLI 类型、Lint、格式、架构真实结果；既有 CLI 全包 max-lines 欠账仍如实列出。
