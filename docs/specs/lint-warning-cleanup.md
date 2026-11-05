# 根 Lint 警告清理

2026-11-04，基于上一轮代码审查后的工作树，清理根 `pnpm lint` 的 157 条警告：144 条未使用绑定、6 条多余转义和 7 条可简化的数组/对象写法。

本次为保持运行行为的代码整理。保留上一轮尚未提交的修复，不更改 Lint 规则、忽略范围或公共接口，不删除功能或恢复官方云依赖。

## 清理边界

- 未使用的类型、局部纯常量、无调用私有函数及 import specifier 可删除；整条运行时 import 若可能承担初始化，保留其模块加载。
- 未使用的初始化结果只移除绑定，仍执行初始化；不删除 IO、服务构造、异步调用或 React hook 的副作用，不改变 hooks 调用顺序。
- 接口仍需要的未使用回调参数可以省略局部形参或明确用 `_` 表达未使用；不删公共 props、事件或协议字段。
- 简化 spread 与遍历时保留快照和执行顺序语义；若原集合会在迭代中变更，继续采用显式快照。
- 多余转义的清理保持字符串值不变；测试夹具仅整理源码，不更改断言或运行真用户环境。

## 验证

先核对受影响模块合同及引用，再运行固定 Node 24.14.0 的根 typecheck、lint、fmt:check 和 changed 架构检查；CLI 内的被选中夹具使用自身格式入口。上一轮定向回归保留并复跑必要范围。纯未使用绑定整理不增加镜像实现的测试，不把编译与定向测试称为真机 E2E。

定向回归同时核对夹具与当前接口：Docker 生命周期夹具模拟 `probeDockerDaemon(): Promise<void>`，不再沿用退役的 boolean 探测接口；原有 14 项断言及计数保持，迟到 exec 场景继续由同一探测 Promise 控制，不启动真实 Docker。

`output-style` 是本次首次修改的官方新增继承目录，脱离原样准入后必须满足 managed 模块规则。登记 `output-style` 为 adapters 模块，依赖现有 shared 协议与 services descriptor；合同复用 `IOutputStyleService`，保留既有 index、descriptor 和服务构造入口。读取、设置写入及文件持久化仍由原服务负责，不更改方法、路径、内建样式或激活规则，不扩大其调用权限。

## 实际结果与限制

- 固定 Node 24.14.0、corepack pnpm 10.33.2：根 Lint 检查 5574 个文件，0 warnings / 0 errors。原 157 条全部清理；规则、忽略范围及 400 行上限保持。
- 根 typecheck 与 changed 架构通过；架构为 0 violations / 0 baseline / 0 new。根格式与差异空白检查通过，未将 CLI 的独立格式欠账称为通过。
- Docker/HTTP/模型流/Registry/Observer/构建闭包/构建规格/审计合跑外层 40/40，0 skipped；Docker 14、模型流 14、Registry 5、Observer 5 的源场景分别由 wrapper 执行，不与外层重复累计。UI 六份相邻回归共 69/69。
- CLI 象棋 smoke 夹具只替换棋盘数组初始化，AST 核对除该已知替换外一致，原 smoke 中对应夹具分析、四项投影与 10 秒预算断言通过（选中 1 个用例，不代表整个 smoke corpus）。
- CLI 夹具的独立整文件格式检查有既有排版欠账。尝试按其配置格式化后非空代码增至 468 行，触发根 max-lines；最终撤回该整文件格式整理，保留原排版与单行等价替换，没有加 ignore、扩大例外或放宽规则。根 fmt:check 本就不覆盖 CLI，该限制保留在本记录。

证据位于项目内 `.run-logs/project-only-validation/`：`lint-cleanup-final-lint4-TXWhjT`、`lint-cleanup-final-typecheck3-r9KWSH`、`lint-cleanup-final-architecture4-xURBgC`、`lint-cleanup-final-fmt2-toRwRL`、`source-tests-yZ2DuD`、`lint-cleanup-smoke-9DajCm` 及对应 wrapper 沙箱。完整 Electron/原生平台、真实远端、真实 Provider、实体手机和全量业务语料未运行；未提交、推送、构建安装包或触发 Actions。
