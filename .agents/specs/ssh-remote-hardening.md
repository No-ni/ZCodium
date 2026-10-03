# SSH 远端连接的两项遗留缺陷

> **状态：未实现，待排期。** 本 spec 记录两项已在代码中核实的安全 / 并发缺陷、证据与候选修法，
> 不包含实现。按仓库「行为变更先写 spec」的规矩落档。

## 背景

`packages/server/src/remote/` 下的 SSH 远端连接有两项遗留问题，均在 `axiom-desu/ZCodium`
主线代码中核实过，尚未处理。

## 缺陷 1：SSH 不校验主机密钥（安全）

### 现状

`packages/server/src/remote/sshAuth.ts` 的 `buildSSHConnectConfig()` 构造 `ConnectConfig` 时
**没有设置 `hostVerifier`**：

```ts
return {
  host: input.host,
  port: input.port ?? 22,
  username: input.username,
  // …privateKey / passphrase / password / agent / readyTimeout / keepalive / tryKeyboard
};
```

全仓检索 `hostVerifier` 在 `packages/` 下 0 命中（`ssh2` 的类型定义见
`node_modules/ssh2/ssh2.d.ts:726`，确认这是可选字段）。

### 后果

`ssh2` 未提供 `hostVerifier` 时接受**任意**主机密钥，即连接不对服务端身份做任何校验。
中间人可以冒充目标主机完成密钥交换，用户输入的密码 / 私钥口令会直接交给冒充者。
对于会执行任意命令的远端 Agent 部署链路，这等同于把凭据暴露给主动攻击者。

### 候选修法

按 OpenSSH 默认策略做 TOFU（trust on first use）：

1. 新增 known_hosts 存储，键沿用 `buildSshRemoteHostKey()` 的归一化结果
   （`packages/shared/src/remoteSshHostKey.ts`），存算法 + 主机公钥指纹。
   注意**不要**把密码 / 私钥口令纳入存储键——该函数已刻意排除，保持这一约束。
2. 连接时三方判定：
   - 无记录 → 接受并落库（首次连接）；
   - 记录匹配 → 接受；
   - 记录不匹配 → **拒绝连接**，并把「主机密钥已变更」作为独立错误码透出，不得静默重连。
3. 首次连接与密钥变更都需要 UI 面：首连是信息性提示，密钥变更必须是阻断式确认。
   当前 `astrbotProvider` 之外的远端错误链路见 `packages/server/src/remote/` 的
   error 归一化处，需要新增一个可区分的错误类型。

### 未定

- 存储位置：数据根下新目录，需与 `.zcodium-exp` 的迁移策略一起考虑
  （见 [zcodium-data-dir.md](zcodium-data-dir.md)）。
- 是否允许用户显式关闭校验（逃生开关）。倾向不提供：关闭后等于回到现状，
  而现状正是缺陷本身；确有需要的用户可自行维护 `~/.ssh/known_hosts` 并用
  `ssh config alias` 连接。
- `sshConfigAlias` 场景（走 `~/.ssh/config` 的 Host）是否复用同一存储。

## 缺陷 2：跨窗口并发部署（并发）

### 现状

`packages/desktop/src/host/index.ts:1270` 对 SSH 目标使用 `caller-serialized` 锁模式：

```ts
params.target.kind === "ssh" ? "caller-serialized" : "remote",
```

该模式在 `packages/server/src/remote/deploy.ts:274` 中**跳过远端 install-root 锁**，
理由是「桌面 SSH 已由窗口级 shared Host readiness 保证同一 target 只有一个部署事务；
若仍创建 remote lock-holder，会为无额外互斥收益的路径长期占用 SSH channel」。

### 核实结论：该声明只在单窗口内成立

单飞机制确实存在，但作用域是**单个窗口**：

- `packages/desktop/src/host/windowRemoteConnectionRegistry.ts` 的 `resolveEntry()`
  对同 `buildConnectionKey()` 的 connecting / online 条目直接复用；
- 该 registry 由窗口各自持有，注释亦自陈「窗口级」。

因此两个窗口连接同一个 SSH 目标时，各自创建 host、各自进入部署，且因
`caller-serialized` 而**都没有远端锁**，可以并发上传同一 install-root。
WSL / Docker 走默认 `remote` 模式，不共享此问题。

同时核实：`caller-serialized` 的注释要求「必须由已具备 single-flight 的调用方显式注入」，
桌面 SSH 满足单窗口前提，但未覆盖跨窗口。

### 候选修法

1. **最小改动**：桌面 SSH 也改回默认 `remote` 模式，与 WSL/Docker 一致。代价是分配
   `caller-serialized` 注释里提到的「长期占用 SSH channel」，需要实测该代价是否显著。
2. **保留现模式 + 跨窗口互斥**：把部署互斥提到窗口之外（数据根下的文件锁，
   或主进程级的单例 registry）。成本更高，但不动现有 SSH channel 占用特性。
3. 折中：仅在检测到跨窗口同 target 时才退化到 `remote` 锁。

倾向方案 1——先量代价，若可接受则用一致性换正确性。

### 未定

- `caller-serialized` 规避 SSH channel 占用的收益究竟有多大（需实测）。
- 是否需要为「已有一个窗口在部署」的用户提供可见反馈，而非静默等待。

## 验证方式（实现时）

- 缺陷 1：用本地 sshd 构造密钥变更场景，断言第二次连接被拒且错误可区分；
  首连后 known_hosts 有记录。
- 缺陷 2：两个窗口连同一 SSH target，断言部署串行（任意一种方案都要能观测到等待）。
