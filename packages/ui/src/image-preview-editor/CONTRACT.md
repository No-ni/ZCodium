# 图片预览编辑

图片原字节只读；transform 和标注历史由当前预览唯一持有，关闭或切图即销毁。
保存捕获 focused Composer receiver 后异步导出自然尺寸 PNG；接收方释放 scope 后必须拒绝旧 receiver。
`registerImageComposerTarget` 由 Composer 的附件 hook 注册，仍以既有 `addAttachmentFiles` 为唯一入队路径。
编辑器不持有上传队列，不发送消息，不调用主进程。缩放、选择和擦除均在自然像素坐标中进行。
详见 [spec](../../../../docs/ui/shared-image-preview-dialog.md)。

共享预览下载按平台结果区分本机保存和浏览器下载：`downloadStarted: true` 返回 started，真实 path 返回 saved，取消不提示成功。浏览器不提供本机 path，不能因其缺席把已经交付的下载误报失败。HTTP 和字节分支共用此判定语义。
