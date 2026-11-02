# web-remote-control-ui

展示自建远控的设备导航与实际查看声明，不持有账号或认证状态。桌面弹窗入口沿用根目录的本仓实现。

宽窄屏共用 TaskViewReporter，从已提交的完整任务导航、实际聊天表面与 Page Visibility 派生查看声明；首页、草稿、后台、遮盖与卸载清空声明。查看 Reporter 和手机 Home/chat 状态由稳定的 Shell 持有，断点变化只替换布局内容；初始聊天意图不随断点重复执行。最后导航位置与瞬时查看分开，不保存另一份导航，也不写任务未读。Main 校验连接与 bridge 后交给桌面唯一 writer。详见 [任务列表刷新语义](../../../../docs/task-list-refresh-semantics.md)。

身份比较继续使用本仓根入口，同时检查 workspaceKey 与 remoteSessionId。DeviceHeader 和 TaskViewReporter 分别通过已声明的公开入口使用；不恢复官方 OAuth、账号 relay 或原生手机日志。

完整语义见 [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md)。
