# 任务菜单「前往配置」：打开工作区 Provider 配置文件

## 背景与范围

上游语言表在 `appHeader` 域少了 8 个键，本 spec 只覆盖其中**被代码接线的那 1 个**。

核对方式：从官方 3.14.3 安装包全量解包 `app.asar`（27057 文件），在 `out/renderer/assets/*.js`
中查每个键的出现位置——只在 i18n chunk 出现即未接线。

| 键                                                           | 非 i18n chunk | 结论                     |
| ------------------------------------------------------------ | ------------- | ------------------------ |
| `appHeader.goToProviderConfig`                               | 1             | **已接线，本 spec 范围** |
| `appHeader.goToProviderConfigPrefix`                         | 0             | 上游死键                 |
| `appHeader.goToProviderConfigSuffix`                         | 0             | 上游死键                 |
| `appHeader.openProviderConfigWithEditorPrefix/Middle/Suffix` | 0             | 上游死键                 |
| `appHeader.openProviderConfigInEditorFailed`                 | 0             | 上游死键                 |
| `appHeader.copyClaudeJsonlPath`                              | 0             | 上游死键                 |

后 7 个键没有任何调用点，**本 spec 不补**。补进去只会得到永不显示的字符串，也会让
[upstream-parity-audit.md](upstream-parity-audit.md) 的缺口账失真。

## 上游行为（从 bundle 还原）

菜单项位于任务列表项的操作菜单，与「复制会话 ID」「复制日志路径」「反馈」并列：

```js
{
  jsx;
}
(Item,
  {
    disabled: s || o.loading || !o.path,
    title: s ? u : void 0, // 禁用原因
    onSelect: () => {
      s || D();
    },
    children: formatMessage({ id: `appHeader.goToProviderConfig` }),
  });
```

底层 hook 返回值（`useWorkspaceProviderConfigFile`）：

```js
{
  (taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile, // { path, exists, loading, error }
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig); // ← 「前往配置」的 onSelect
}
```

`providerConfigFile` 由 RPC `getWorkspaceProviderConfigFile(workspace, provider, scope, session)`
取得，日志前缀 `[useWorkspaceProviderConfigFile]`，带 request-id 竞态防护
（`_.current !== i` 时丢弃过期响应）。

语义要点：**按工作区解析 provider 配置文件路径**，不是全局内置配置；文件不存在时菜单禁用。

## 本仓库现状

已有但不匹配：

- `packages/provider-node/src/zcode-builtin-provider-config-materializer.ts`：
  `materializeZCodeBuiltinProviderConfig()` 把**随包内置**配置原子物化到
  `<environmentConfigRoot>/runtime/provider/bundled/zcode-builtin.json`。
  这是构建时派生的全局基线，与工作区无关，且路径不暴露给 renderer。
- `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`：`appHeader` 域已有 14 键
  （`copyPath`/`copyLogPath`/`copyTaskPath`/`copySessionId`/`openInEditor`/`selectOpenApp` 等），
  缺 `goToProviderConfig`。
- `packages/ui/src/hooks/useFileContextActions.ts`：提供 `copyPath`/`copyAbsolutePath`/
  `copyRelativePath`/`revealInFileManager`，经 `platform.openInEditor` / `platform.openInFileManager`
  落到平台层——「打开文件」的通道已具备。

缺失：把 provider 配置文件路径暴露给 renderer 的能力，以及任务菜单里的入口。

## 目标

在任务列表项菜单中增加「前往配置」：

1. 能取到 provider 配置文件路径时，点击用系统默认方式打开该文件；
2. 取不到（仍在加载 / 不存在 / 远端工作区不支持）时禁用，并把原因写进 `title`；
3. 只新增 1 个 i18n 键 `appHeader.goToProviderConfig`，避免引入上游那 7 个死键。

## 非目标

- 不补 `goToProviderConfigPrefix/Suffix` 等 7 个未接线键。
- 不新建按工作区的 provider 配置体系。当前实现是随包内置配置的全局物化，
  改为按工作区解析属于配置模型变更，超出「补全 i18n 缺口」的范围。
- 不引入「用指定编辑器打开配置文件」的编辑器选择器（对应上游未接线的那组键）。
- 不改 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的既有语义。

## 接口契约

### 1. Main / Server：暴露配置文件路径

新增一个只读查询，返回物化后的内置 provider 配置路径与存在性：

```ts
interface ZCodeBuiltinProviderConfigFileInfo {
  readonly path: string | null; // 未物化或不可用时为 null
  readonly exists: boolean;
}
```

- 复用 `materializeZCodeBuiltinProviderConfig` 已有的落点约定，**不重复计算路径**：
  由 owner 导出一个 `resolveZCodeBuiltinProviderConfigFilePath()`，从同一
  `environmentConfigRoot` 派生，确保与物化位置一致。
- 该查询**只读**，不触发物化；未启动过 server 时返回 `exists: false`。

### 2. Preload / RPC：透传到 renderer

经既有 `platform` 通道暴露（与 `openInEditor` / `openInFileManager` 同层），
方法名 `getBuiltinProviderConfigFile(): Promise<ZCodeBuiltinProviderConfigFileInfo>`。

### 3. Renderer：hook + 菜单项

新增 `packages/ui/src/hooks/useBuiltinProviderConfigFile.ts`：

- 复用上游的竞态防护形态：request-id 自增，过期响应丢弃；
- `loading` / `error` / `path` / `exists` 四态；
- 失败只 `logger.warn`，不抛到 UI。

任务菜单挂载点：与 `copySessionId` / `copyLogPath` 同级的菜单组件
（`packages/ui/src/TaskActionMenuContent.tsx` 或 `useTaskListItemContextActions.ts` 侧，
以现有菜单组装位置为准），新增一项：

- `disabled = loading || !path || !exists`
- `title` = 禁用原因（加载中 / 文件不存在 / 远端工作区不支持）
- `onClick` → `platform.openInEditor("default", path)`，失败沿用
  `appHeader.openInFileManagerFailed` 的 toast 模式

### 4. i18n

`zh-CN.ts` / `en-US.ts` 各增 1 键，位置与 `appHeader.copyLogPath` 相邻：

| 键                             | zh-CN    | en-US        |
| ------------------------------ | -------- | ------------ |
| `appHeader.goToProviderConfig` | 前往配置 | Go to config |

## 状态所有者

| 项                    | owner                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| provider 配置路径派生 | `packages/provider-node/src/zcode-builtin-provider-config-materializer.ts` |
| 查询与 RPC 暴露       | `packages/services` / `packages/server` 中既有的 platform 通道 owner       |
| renderer hook         | `packages/ui/src/hooks/`                                                   |
| 菜单入口              | 任务列表项菜单组件                                                         |
| i18n                  | `packages/ui/src/i18n/locales/`                                            |

## 验收场景

1. 本地工作区、内置配置已物化：菜单项可用，点击用系统默认程序打开 `zcode-builtin.json`。
2. 路径尚未物化（`exists: false`）：菜单项禁用，`title` 说明文件不存在。
3. 查询进行中（`loading`）：菜单项禁用，`title` 说明加载中。
4. 查询失败：菜单项禁用，`logger.warn` 记录，不弹错误 toast（不打断菜单）。
5. 远端工作区（SSH/WSL/Docker）：菜单项禁用，`title` 说明远端不支持。
6. 「复制日志路径」「复制会话 ID」等既有菜单项行为不变。
7. 中英两种语言下菜单文案分别为「前往配置」/ `Go to config`。
8. `useBuiltinProviderConfigFile` 在快速切换工作区时不出现旧工作区路径覆盖新工作区
   （request-id 竞态防护）。

## 风险

- **语义不完全等价**：上游按工作区解析，本仓库按环境全局物化。若用户期望看到
  「当前工作区生效的那份配置」，拿到的是全局基线。需在 `title` 或文档中说明差异，
  或在实现时确认全局基线就是当前唯一生效配置。
- 该菜单项在远端工作区下应禁用而非打开本机路径——打开本机文件会让用户误以为改的是远端配置。

## 未验证部分

- 上游 `getWorkspaceProviderConfigFile` 的 `scope` / `session` 参数语义未能从 bundle 完全还原，
  本 spec 不实现按工作区维度，只读全局物化路径。
- 「用编辑器打开配置文件」的上游交互无法还原（对应键未接线），本 spec 以
  `platform.openInEditor("default", ...)` 近似。
