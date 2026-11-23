# cli-test-config

登记现有 CLI 根 Vitest 配置。Vitest 同时发现 `tests/` 与 colocated `src/` 回归，Node `test/` 仍通过包自身入口执行；各 runner 不互相替代。

配置没有业务状态、持久化、网络或平台安装职责。测试环境、路径、子进程和凭据由项目内隔离验证入口控制。本模块只覆盖配置及职责合同，不扩大 CLI 未受管源码范围。
