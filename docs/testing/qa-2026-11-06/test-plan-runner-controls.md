# 最后两项 QA runner 前置合同

本文件先于 QA runner/hook 改动记录合同。仅添加两个默认关闭的测试前置，不修改产品、正式用例或 timeout；root 是唯一 UI 执行者。所有路径都由现有 worktree/reparse guard 检查。

- `GroupedTarget` 只接受新 run `qa-menu-20261106-grp-pin-grouped`、唯一 canonical task-groups spec 及 GRP04/05/06 完整标题 grep。target-only beforeEach 在原 hook 后真实点击视图菜单和 grouped radio，核 checked、菜单退场、grouped view 与 add 可点击。前后独占 PNG/JSON；不写 localStorage/store、不 refresh、不预先造 group。原 case 完整保留。
- `SafeGit` 只接受新 run `qa-menu-20261106-local-supplement-retry`，现有 runtime 必须不存在。在 R/git-isolation 下独占创建空 global.gitconfig、system.gitconfig、attributes 文件和 templates/hooks 目录。先清当前进程继承的 GIT_*，再仅设置 GIT_CONFIG_GLOBAL、GIT_CONFIG_SYSTEM、GIT_CONFIG_NOSYSTEM=1、GIT_TEMPLATE_DIR；向 suite 提供 QA_SAFE_GIT_WORKTREE/ROOT。suite 仍必须审实际 Main 环境、Host 子进程继承、路径及本例 local core.hooksPath/core.attributesFile；不以 runner 预检替代真实继承核验。只 init/add/modify，无 commit、push、外部配置、签名或网络。

新开关要求源语法、精确目标正负例及参数前置检查后才准入。旧 run 的原文件、日志、PID 和 main=null 证据保留，不反写。新增前置的静态通过不计产品 test/UI PASS。每次执行保留 fresh build 和应用退出屏障，最后门禁再运行 typecheck/lint/architecture。
