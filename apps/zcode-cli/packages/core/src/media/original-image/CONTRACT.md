# 原图持久化边界

Core 在附件、Read 与 MCP 的入口收到原始图片字节后，先调用既有 ToolArtifactStorePort 的 binary write，成功后才调用 ImageProcessorPort 生成兼容副本。写入使用当前 session 与 session retention，复制输入字节，保存实际 SHA-256、字节数、MIME 和来源种类；原图只能引用 zcode-artifact://，不能把可变文件路径当作原图。

没有 artifact store 或没有 session 时返回不可恢复状态：调用方保留原字节，不进行重编码，也不制造 originalImage。配置了 store 但缺少 binary write、写入失败或返回非 artifact URI 时失败，不能吞掉错误继续 prepare。实际 store 负责不可变写入，Core 不另建存储、缓存或原图写入路径。

source.originalImage 与 FilePart.metadata.image 使用同一溯源字段，hydration 只恢复完整、合法的已持久记录，并用真实 FilePart.id 绑定 canonicalPartId。历史记录只有发送副本时没有原图可用证明。artifact URI 本身不授权回取：Runtime 仍须确认当前会话持有该 canonical ref，包括合法 fork 继承的 ref。

MCP provenance 由 host 的不可枚举 Symbol 注入，只在 host 成功保存后有效。第三方 JSON、\_meta、名称与自报 artifact URI 不产生这个 Symbol，不授权可恢复或 exact-raster。可信 CUA 帧先通过既有 producer gate，原始栅格保留并标记 preserveRaster，后续请求投影禁止重编码。普通 Browser 截图归 mcp 来源；保存路径提示复用同一原图写入结果。

桌面 continuous 和手机 replayable 共用同一持久 FilePart；此模块不生成 snapshot、命令、队列、模型调用或跨任务读取。
