# 用户级数据根一次性迁移

> 实现：`packages/shared/src/node/userDataRootMigration.ts`（核心）、
> `packages/desktop/src/main/desktopEarlyUserDataRootMigration.ts`（桌面接线）。
> 本 spec 记录设计依据与 2026-10-03 的真实数据实测结论。

## 为什么需要

用户级数据根由 `.zcodium` 改为 `.zcodium-exp`（ZCodium-project/ZCodium 的 #13/#17 正把
`~/.zcodium` 收敛为它们的数据根，两个产品不能共用同一棵树）。常量改名后新构建只读新根，
若不搬一次，存量用户的凭据、配置、会话、日志全部留在旧根，表现为「升级后要重新登录、
机器人绑定丢失、历史会话消失」。

## 关键设计：复制 + 标记，而非移动

本仓库的旧根 `.zcodium` 是自己的数据、没有第三方读者，本可以 `renameSync` 直接搬。
仍选择复制的原因：**复制失败时旧根完好无损**，不会把用户数据置于「搬一半」的风险里。

与对方 #13 的差异：对方必须保留 `~/.zcode` 给官方 ZCode 客户端继续用，所以也只能复制。

## 三个不变量

1. **不覆盖**：新根已存在时返回 `skipped-both-exist`，保留现状，绝不向任一方向合并或删除；
2. **不重复灌入**：成功后旧根写 `.migrated-to-zcodium-exp` 标记，后续启动直接 noop；
3. **不阻断启动**：任何 IO 失败只返回 `failed`，由调用方记日志，不进抛出路径——
   启动阶段抛异常会让整个进程起不来，比数据没搬严重得多。

复制落在新根**同卷**的临时目录再 `renameSync`：同卷 rename 是原子操作，
跨设备也不会 EXDEV，并发启动的两个进程不会看到半棵树。
标记文件仅在新根落位之后写入——写标记前崩溃则下次重试，写标记后崩溃则旧根仍在但已判定完成。

## 时序约束（硬性）

桌面侧 `desktopEarlyUserDataRootMigration.ts` 必须在 `desktopEarlyDataBaseDirBootstrap`
**之后**执行：后者会用旧根里的 `dataBaseDir` 调 `setDataBaseDir`，之后的
`getDataBaseDir()` 才是用户真实的基目录。顺序反了，自定义数据目录的用户会被按默认 HOME 迁移，
数据搬错地方。

与 `desktopEarlyChromiumHardwareAccelerationBootstrap` 的先后无所谓——后者已改为
「新根优先、旧根回落」，两种时序都读得到。

CLI 侧迁移必须在 `--prepare-storage` 之前，否则它会先建一个空新根，迁移随即因
「两边都在」被跳过。

---

# 实测结论（2026-10-03）

对迁移做了一次真实数据测试，调用的是真实的 `migrateLegacyUserDataRoot()`，非重写的复现逻辑。

## 方法

沙箱隔离方式是 `ZCODE_DATA_BASE_DIR` 指向临时目录，迁移只在其下找 `.zcodium` / `.zcodium-exp`。
数据形态覆盖：多层嵌套、2MB DB、大日志、中文与空格文件名、只读文件、0 字节文件、
空目录、文件软链；目录结构对齐真实 `~/.zcodium`（`cli` / `v2` / `workspace` / `plugin-workspace`）。

## 已验证成立

| 不变量     | 实测结果                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| 内容完整   | `diff -r --no-dereference` 新旧根仅差标记文件；条目逐项一致，软链、只读文件、0 字节文件、空目录、中文与空格路径全部保留 |
| 幂等       | 第二次调用返回 `noop-already-migrated`，新根条目数不变                                                                  |
| 不覆盖     | 「两边都在」返回 `skipped-both-exist`，新根内用户已有数据未被触碰                                                       |
| 无旧根     | 返回 `noop-no-legacy`                                                                                                   |
| 不阻断启动 | 把 base 目录置为 0500 使 `cpSync` 失败 → 返回 `failed` 且**未抛出**，临时目录已清理、新根无半成品、旧根完好             |
| 迁移后可读 | 迁移后 `getZCodeDataRootDir()` 指向新根，`v2/config.json` 真实可读                                                      |

## 问题 1：`ZCODE_DATA_BASE_DIR` 必须在 import 之前赋值

`packages/services/src/paths.ts:15-16` 在**模块加载时**读取环境变量：

```ts
const envDataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || null;
const defaultDataBaseDir = process.env.HOME?.trim() || homedir();
```

任何在 `import ... paths` 之后才设置 `ZCODE_DATA_BASE_DIR` / `HOME` 的脚本或测试，
拿到的仍是加载那一刻的值。实测中一个脚本因此回落到真实 HOME，迁移动作落在了真实的
`~/.zcodium` 上（事后已完整恢复，见下）。

**对生产代码无影响**——真实进程的环境变量在启动前已确定。但这是编写迁移相关测试的必要知识：
先设环境变量，再 import。

## 问题 2：`applyEarlyDataBaseDirBootstrap` 不感知 `ZCODE_DATA_BASE_DIR`

`packages/desktop/src/main/desktopDataBaseDirBootstrap.ts` 的 `resolveBootstrapSettingsFile()`
只以 `homedir()` 为基准拼 `<root>/v2/setting.json`，不看 `ZCODE_DATA_BASE_DIR`。

实测推敲：该函数只影响「从 setting.json 里再读一层 dataBaseDir」这条链路。
`getDataBaseDir()` 因 `envDataBaseDir` 优先于 `defaultDataBaseDir` 仍会返回自定义目录，
**迁移本身不会搬错**。但两者基准不一致，建议实现时对齐或加注释说明，避免后来者误判为 bug。

## 事故记录（本次测试）

一个验证脚本只改了 `process.env.HOME` 而未设 `ZCODE_DATA_BASE_DIR`，而 `paths.ts` 的
`defaultDataBaseDir` 在该脚本 import 之前就捕获了真实 HOME，于是回落到真实 HOME，
迁移真实发生在 `~/.zcodium` 上：复制出 `~/.zcodium-exp`（8.8M，内容一致），
并在 `~/.zcodium` 写入标记。

已完整恢复：删除 `~/.zcodium-exp` 与标记文件，`~/.zcodium` 恢复为 8.8M 四子目录原状，
内容零损失（复制语义保证了旧根始终完好）。

教训固化：任何迁移测试必须同时满足「临时 baseDir」与「import 前赋值」两个条件。

## 建议补强

- 现有单测覆盖了契约分支，但缺同卷 / 异卷 rename 的真实文件系统测试；
- 缺「迁移后 `getZCodeDataRootDir()` 可读」的端到端断言；
- 上述测试需按问题 1 的方式先设环境变量再 import。
