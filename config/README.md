# 内置默认配置

`config/default.json` 是随客户端发布的默认配置，必须保留。Desktop 从打包文件读取，
Web 在构建时导入；帮助入口只使用这份本地文件，不请求远端 `client/configs`，也没有
官方默认地址。

## 帮助配置来源

`config/default.json` 由 `packages/shared/src/helpAppConfig.ts` 校验：

- `community_urls["zh-CN" | "en-US"]`：只按当前语言选择，不跨语言回退；缺失时不展示入口。
- `feedback_url`：只接受 http/https；当前指向本仓 Issues。
- `feedback_use_external_form`：缺省为 `true`，使用外部浏览器打开。

Desktop 打包后读取 `resources/config/default.json`，开发态读取仓库
`config/default.json`；Web 构建时直接导入同一文件。字段缺失或非法时按 schema 回退：
URL 为空则不展示对应入口，`feedback_use_external_form` 默认 `true`，不会回退到官方地址。

旧 CDN default.json 仅为旧版客户端兼容保留；新版无请求或 URL 构造链路，
不要因此删除线上旧文件或本目录内置文件。内置文件的其他字段与既有消费者保持不变。

详细规则见 [helpAppConfig.ts](../packages/shared/src/helpAppConfig.ts)。
