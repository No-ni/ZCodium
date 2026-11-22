# 手机窗口目录展示投影

本模块登记既有 `mergeMobileWindowDirectory`，不改变手机远控行为。

Host 的 `WindowProjectDirectorySnapshot` 是名称与连接状态的来源，手机 bootstrap 保留工作区列表和连接身份。只有 workspaceKey、路径、identity、remoteSessionId 与 kind 全部匹配时才合并名称/连接状态；身份不匹配不覆盖，不增加或删除工作区，不修改会话或连接 owner。

接口仍是 `windowDirectoryPresentation.ts` 的纯函数；不执行 IO、不持久化、不发事件。固定两份输入得到新的展示快照，输入保持不变。此登记修复推送范围内的 unmanaged-new-file 门禁，不新建产品能力或状态。
