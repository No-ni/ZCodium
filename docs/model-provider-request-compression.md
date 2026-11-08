# 渠道级模型请求压缩（Provider Request Compression）

> 来源：参考 `No-ni/dsh-plugin-model-request-accelerator` 的请求体压缩能力。
> 本仓只吸收「上传正文压缩」这一项；该插件的预热/预传输与分阶段耗时视图不引入。

## 产品规则

- 压缩是**渠道（provider）级**配置，不是全局开关：同一 endpoint 上的不同渠道各自独立。
- 取值三态：`off`（默认）/ `brotli` / `gzip`。
- 只作用于**模型请求的上传正文**（provider HTTP 请求的 JSON body），不影响响应解码、
  MCP、websearch 或其它任何 HTTP 调用。
- 只在正文是文本 JSON 时压缩；二进制、FormData 或流式正文原样发送，跳过而不报错。
- 调用方已经设置 `content-encoding`（正文已编码）时跳过压缩：二次编码会把正文写坏。
- `off` 时零开销：不读 body、不加头、不加载压缩实现。
- brotli 被网关拒绝（HTTP 400/415）时：本次请求改用 gzip **重发一次**，并把该渠道在当前进程内
  记为「brotli 不可用」，后续请求直接用 gzip。记忆不落盘，进程重启后可重新尝试 brotli。
- 拒绝既可能表现为**返回 400/415 响应**，也可能表现为**内层抛出携带状态码的错误**
  （`createProviderBusinessErrorFetch` 把非 2xx 转成 `ProviderBusinessError`），两者都必须触发降级。
- 生效边界：保存后由 Host 同步到 CLI 的渠道配置，**新建立的模型绑定**读取新值；运行中的请求
  不受影响（与既有的 endpoint/协议快照语义一致，见 `model-execution.ts` 的 `bindModel` 注释）。

## 状态所有者

| 状态                | 所有者                                                     | 说明                                                       |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| 压缩选择            | `ProviderApiConfig.requestCompression`（personal overlay） | 唯一真源；设置页写入，走既有 `savePersonalProviderOverlay` |
| 表单草稿            | `ProviderDraftValues.requestCompression`                   | UI 局部草稿，不构成第二份真源                              |
| 「brotli 被拒」记忆 | CLI 进程内 `AiSdkModelExecution` 的 per-provider Map       | 纯运行时事实，不落盘、不进配置                             |

## 接口

配置 schema（`packages/provider/src/config/provider-data-schema.ts`）：

```ts
providerRequestCompressionDataSchema = z.enum(["off", "brotli", "gzip"]);
// api.requestCompression?: "off" | "brotli" | "gzip"
```

传输层模块（`apps/zcode-cli/packages/adapters/src/model/request-compression/`，受管模块
`model-request-compression`）：

```ts
createRequestCompressionFetch({
  fetch,      // 内层 transport（已完成代理与证书；压缩层紧贴其上）
  providerId, // 只用于日志与记忆分桶
  algorithm,  // off 时直接返回 fetch 本体
  state,      // 跨请求共享的按渠道记忆
}): typeof fetch
```

装配顺序（`model-execution.ts` 的 `createFactory`，由内到外）：

```text
proxy/CA transport → 压缩层 → business-error → option-map → 协议兼容层 → SDK
```

压缩层必须位于 option map 与协议兼容层**之内**（更贴近 wire）：那两层要读写**明文** JSON 正文，
把压过的 `ArrayBuffer` 交给它们会 fail-closed（option map 直接抛
`Model option maps require a JSON text request body.`，请求发不出去）。
压缩只能发生在正文改写完成之后、真正上网之前。

设置页入口（`ProviderRequestCompressionSelect`，定义在
`packages/ui/src/settings/model-provider-section/ProviderApiFormatSelect.tsx`，在渠道卡片「连接」区块渲染）：
压缩是渠道属性，与 Base URL、API 格式并列，不新增顶层设置页。

## 事件顺序（一次请求）

```text
SDK 发起请求
  → option map / 协议兼容层按明文 JSON 改写正文（压缩层在其内侧，因此看到的是改写后的正文）
  → 压缩层读取正文（非文本则直接透传）
  → brotli/gzip 压缩 + 写 content-encoding，丢弃旧 content-length
  → 内层 transport 发送（返回 Response，或抛错）
  → 400/415 且当前为 brotli 且未重发过（状态码取自响应，或取自异常的 responseStatus/statusCode）：
        记录该渠道 brotli 不可用 → 用 gzip 重发一次 → 返回重发结果（响应或原样抛出 gzip 那次的错误）
  → 其余结果原样返回（不读取流式响应正文）
```

## 验收场景

1. `off`：请求不带 `content-encoding`，正文与未启用时字节一致。
2. `brotli`：正文被压缩，带 `content-encoding: br`，且不残留旧 `content-length`。
3. `gzip`：带 `content-encoding: gzip`。
4. 网关返回 415：自动以 gzip 重发一次；重发后仍失败则原样返回，不无限重试。
5. 非文本正文（FormData / 二进制 / 流式）：跳过压缩，请求照常发出。
6. 同一渠道第二次请求：直接使用 gzip，不再先试 brotli。
7. 关闭开关后：该渠道请求恢复未压缩，且不再产生压缩相关头。
8. 内层以 `ProviderBusinessError`（`statusCode: 415`）抛错时：仍先试 br、再以 gzip 重发一次，
   最终把 gzip 那次的错误原样抛出；该渠道同样被记为 brotli 不可用。
9. 调用方已带 `content-encoding`：正文与头部原样发送，不再叠加压缩。
10. 渠道同时配置 option map（如 `reasoningLevel.map`）与压缩：option map 仍能改写明文正文，
    改完的正文才被压缩上网；不会出现 `Model option maps require a JSON text request body.`。

## 已知限制

- 只压缩上传方向；响应本来就已由运行时协商压缩。
- 压缩并非越大越好：短请求（标题生成、compact 小报文）压缩收益有限，但成本也可忽略。
- 不校验网关是否真的解压：只以 HTTP 400/415 作为拒绝信号；某些网关可能返回 500 或静默 200 的
  错误体，此时需要用户自行降级到 `off` 或 `gzip`。
- 400 也包含与压缩无关的业务错误（参数非法、上下文超长等）：这类失败会额外重发一次，并把该渠道
  在本进程内降级为 gzip。这是有意识的取舍——不靠错误文案猜测拒绝原因，代价是一次多余上传与
  「压缩率退到 gzip」，不会丢功能。
