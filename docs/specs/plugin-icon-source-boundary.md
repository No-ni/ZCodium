# 插件图标来源门禁（默认本地，不自发官方请求）

状态：已实现（2026-11-08，对应缺陷 QA-BUG-004）
适用：`apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts` 的 Claude 市场图标补齐
（`enrichCachedClaudeMarketplaceIcons`）。

## 1. 背景与问题

本仓删除官方插件市场自动拉取后，`claude-plugins-official` 与 `zcode-plugins-official`
两个官方 ID 都由随包 seed 提供权威目录（`loadMarketplaceManifestSync` 走
`official-marketplace.ts`）。但 `enrichCachedClaudeMarketplaceIcons` 只做了 storageRoot
去重与非 null 前置，随后 `loadClaudePluginIconSources` 无条件请求固定官方图标地址
`https://cdn-zcode.z.ai/zcode/official-plugin/assets/icon-sources.json`。

结果：只要存在合法 bundled manifest，`plugins/overview` / reference catalog 的自动调用链
就会在用户未 opt-in 时产生一次官方 CDN GET（QA-BUG-004，P1，本 fork 官方网络依赖边界）。
图标本身是展示增强，这与"不依赖官方插件市场自动拉取、未配置自有来源不回退官方"的
维护边界冲突。

## 2. 产品规则（合同）

1. **默认只使用本地来源，严格 0 次请求。** 未显式配置自建来源时，图标补齐只读
   随包/本地数据与本地缓存（`<storageRoot>/icon-sources.json`），绝不发起任何官方或外部
   HTTP 请求；不得为了"让图标更全"恢复官方图标 CDN。
2. **本地图标可用性不受影响。** 内置市场插件的图标由 UI 随包资源提供
   （`packages/ui/src/lib/pluginIconSource.ts`），与本次网络门禁无关；本地缓存存在时
   仍按原语义应用到历史缓存 catalogue，manifest 未变化时零写入。
3. **外部增强必须显式、自建、fail-closed。** 若将来允许外部图标增强，唯一入口是用户
   显式配置的自建来源（见第 4 节）：不可达、响应非法、映射为空、超时或中止时回退本地
   缓存，**不得回退官方地址**，也不得把官方 CDN 当作"默认自建来源"。
4. **不新增环境变量、不新增持久化配置项。** 本改动只增加函数级可选参数；官方地址不作为
   任何默认值或回退值。需要持久化/UI 暴露时必须先更新本文档与设置页数据去向说明。
5. **官方标识不得因此获得远程图片。** 即使历史缓存或自建来源产生了官方域图标 URL，
   UI 的官方身份解析仍只使用随包资源；本规则不因图标来源变化而放宽。

## 3. 状态与数据流

```text
plugins/overview / reference catalog
  -> enrichCachedClaudeMarketplaceIcons(storageRoot, withWriteLock, options?)
       |
       |  options.selfHostedIconSourcesUrl 为空/非法/官方域
       |    -> 只读 <storageRoot>/icon-sources.json（本地缓存）
       |    -> 0 次 HTTP；映射为空时零写入
       |
       |  显式自建来源
       |    -> 1 次 GET 该自建地址（10s 超时，可中止）
       |    -> 校验映射；相对 icon 路径按自建来源目录解析
       |    -> 失败/空映射 -> 回退本地缓存，绝不回退官方地址
       v
applyClaudePluginIcons -> 仅在内容变化时写回缓存 catalogue
```

- 本地缓存 owner：`<storageRoot>/icon-sources.json`，只读消费；自建来源的结果不写入该
  官方格式缓存，避免相对路径在下次被官方基址重放（等于重新引入官方资源引用）。
- bundled 权威 owner：`official-marketplace.ts` 的 bundled partition；图标补齐不得改变它。
- 网络 owner：`requestMarketplaceJson`（唯一出口），仅在显式自建来源分支可达。

## 4. 接口

```ts
export interface ClaudeMarketplaceIconEnrichmentOptions {
  /** 用户显式配置的自建 icon-sources.json 地址；官方图标 CDN 不属于自建来源。 */
  selfHostedIconSourcesUrl?: string;
}

export async function enrichCachedClaudeMarketplaceIcons(
  storageRoot: string,
  withWriteLock?: (write: () => Promise<void>) => Promise<void>,
  options?: ClaudeMarketplaceIconEnrichmentOptions,
): Promise<void>;
```

- 缺省 `options`：本地缓存路径，0 次请求（生产调用方当前的唯一形态）。
- `selfHostedIconSourcesUrl`：必须是用户自建的 http(s) 地址；官方图标域（`cdn-zcode.z.ai`）
  会被当作"未配置"，空白/非法/非 http(s) 同样 fail-closed。
- `parsePluginIconSources(value, baseUrl?)`：默认基址保持历史官方 assets 路径（只用于解析
  历史缓存中的相对路径，不产生请求）；自建来源传入自己的目录基址。

## 5. 验收场景（source 级，strict fake HTTP adapter）

| 用例                  | 前置                                                | 断言                                                               |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| 未 opt-in（缺陷复现） | 合法 bundled manifest + 合法 known 文件，无本地缓存 | HTTP 端口请求数 0；bundled/known 字节不变；不产生历史缓存 manifest |
| 本地缓存路径          | 合法 bundled manifest + 本地 `icon-sources.json`    | 请求数 0；缓存映射仍被应用；bundled 权威不变                       |
| 自建来源成功          | 合法 bundled manifest + 显式自建 URL                | 恰好 1 次 GET，目标就是自建 URL；图标 URL 落在自建基址；无官方请求 |
| 自建来源失败          | 显式自建 URL 不可达/响应非法                        | 恰好 1 次请求后回退本地缓存；请求列表不含官方地址                  |
| 官方地址被拒          | `selfHostedIconSourcesUrl` 指向官方 CDN             | 请求数 0（按未配置处理），只走本地缓存                             |

原 ICR01/ICR02（无当前 bundled manifest 时早退）只覆盖"没有 catalog"的控制分支，
不作为本缺陷的回归证据。

## 6. 非目标与残余风险

- 不改 UI 图标解析、不改 bundled seed、不改 `plugins/overview` 协议。
- 本仓 `claude-plugins-official` 的权威目录来自 bundled partition，图标补齐只可能改写历史
  缓存路径；因此该功能在本仓实际是"历史数据兼容 + 可选增强"，不是官方目录的图标来源。
- 生产调用方目前不传 `selfHostedIconSourcesUrl`，生产路径恒为本地；要把它暴露给用户需要
  单独的设计（设置项、数据去向说明、失败提示），不在本次范围。

## 7. 验证记录

- `node --test scripts/ci/plugin-icon-source-gate.test.mjs`：5 个 source 用例全部通过
  （ICR04–ICR08，strict fake HTTP adapter 计数）。
- 原缺陷证据 `docs/testing/qa-2026-11-07/.../qa-plugin-icon-bundled-authority-20261107.test.mjs`
  （ICR03）修复后由 FAIL 转 PASS；同批控制组 ICR01/ICR02 仍 PASS。
- 反向验证：临时把无条件官方请求放回 `loadClaudePluginIconSources` 后重跑，ICR04/ICR05/ICR08
  失败、还原后恢复全绿，证明该回归确实覆盖本缺陷。
- `vitest run tests/plugins.test.ts`：改动前 28 failed / 56 passed；改动后 25 failed / 59 passed，
  减少的 3 项正是本次改写的旧图标用例，未新增失败（其余失败为本机沙箱/Windows 环境造成的既有失败）。
- `oxlint -c oxlint.config.json`（CLI 配置）：0 warning / 2 error，均为既有 `max-lines`
  （`plugins/index.ts`、`marketplace.ts` 改动前即超过 400 行）。
- `node scripts/check-format.mjs --check <改动文件>`：exit 0。
- 边界回归：`scripts/ci/bundled-plugin-marketplace.test.mjs` 9/9、`scripts/ci/audit-boundaries.test.mjs` 11/11。
- 未执行全仓 `tsc -b`（按任务约定由维护者统一执行），未执行完整 `pnpm lint`/E2E。
