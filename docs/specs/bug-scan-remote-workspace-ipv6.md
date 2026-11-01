# SSH IPv6 工作区身份还原

## 已确认问题

共享 `buildRemoteWorkspaceIdentity` 已接受 SSH IPv6 host，并保留既有身份格式；`parseRemoteWorkspaceIdentity` 固定消费 host/port/username 三个冒号段，把 IPv6 host 内的冒号误当分隔符，导致构造出的身份解析为 null。依赖解析结果还原远端 workingDirectory 的消费者因而无法拿到路径。

## 规则、接口与所有者

共享 remote-workspace-identity 工具是身份构造/解析的唯一入口；业务消费者不手写格式。保持现有公开签名和已存储的身份字符串，SSH authority 从路径前向右识别 port 与 username，host 可保留 IPv6 自带的冒号。身份路径总以 `/` 开头，因此第一个 `:/` 是 authority/path 边界，后续路径的冒号属于路径。

解析只还原身份中的路径，不进行网络地址鉴权或连接，不创建持久化/迁移/新的状态。缺 host、port、username 或绝对路径的结构继续返回 null；IPv6 的 host 段可以包含冒号，其中未指定地址 `::` 是合法 host，必须保留。继续由原连接入口验证实际地址，不在路径解析中新增地址格式校验。普通 hostname、IPv4、WSL 可选用户、Docker、Source Server 的行为保留。

```text
已选择 SSH target + workspacePath
  → shared builder（原身份字符串）
  → shared parser（IPv6 host / port / username / 完整路径）
  → 原消费者的 workingDirectory
Desktop continuous / 手机 replayable → 原 Host/runtime owner
```

## 验收

先用未修改源码运行以下构造→解析用例并确认 IPv6 失败，再修复：未加括号 IPv6、括号 IPv6、带 zone 的 IPv6、根路径、带多个冒号的路径。补充普通 SSH、WSL 默认/显式用户、Docker、Source 身份与缺失 authority/path 的用例。测试为纯内存断言，经项目内隔离 runner 执行，不建立真实远端连接。

实际执行 `scripts/ci/bug-scan-remote-workspace-ipv6.test.mjs`：固定 Node 24.14.0 下，修改前 5 个 IPv6 用例失败、其他 15 个通过；修改后 20 项全部通过。复核将此前误判的 `remote:ssh::::22:...` 更正为未指定地址 `::` 的 round-trip 边界，缺 host 边界由 `remote:ssh::22:...` 覆盖，最终 21 项全部通过。未执行真实 SSH 或 IPv6 网络连接。
