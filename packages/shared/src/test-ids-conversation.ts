// V4 会话 pane（protocol-v4 竖切；定位协议带 paneId 维度：同 session 双 pane 时靠 paneId 后缀区分）
/** v4 会话 pane 容器（动态后缀为 paneId） */
export const TID_V4_SESSION_PANE = "v4-session-pane";
/** v4 消息时间线容器 */
export const TID_V4_TIMELINE = "v4-timeline";
/** v4 投影行（动态后缀为 rowId） */
export const TID_V4_ROW = "v4-row";
/** v4 composer 工作区 Hook 待审核入口与未读点 */
export const TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER = "v4-workspace-hook-pending-trigger";
export const TID_V4_WORKSPACE_HOOK_PENDING_UNREAD = "v4-workspace-hook-pending-unread";
/** v4 工作区 Hook 待审核点击浮层 */
export const TID_V4_WORKSPACE_HOOK_PENDING_POPOVER = "v4-workspace-hook-pending-popover";
/** v4 工作区 Hook 待审核浮层「去审核」按钮 */
export const TID_V4_WORKSPACE_HOOK_PENDING_REVIEW = "v4-workspace-hook-pending-review";
/** v4 工作区 Hook 待审核浮层「忽略」按钮 */
export const TID_V4_WORKSPACE_HOOK_PENDING_DISMISS = "v4-workspace-hook-pending-dismiss";
/** v4 composer 工作区 MCP 待审核入口、未读点与点击浮层 */
export const TID_V4_WORKSPACE_MCP_PENDING_TRIGGER = "v4-workspace-mcp-pending-trigger";
export const TID_V4_WORKSPACE_MCP_PENDING_UNREAD = "v4-workspace-mcp-pending-unread";
export const TID_V4_WORKSPACE_MCP_PENDING_POPOVER = "v4-workspace-mcp-pending-popover";
export const TID_V4_WORKSPACE_MCP_PENDING_REVIEW = "v4-workspace-mcp-pending-review";
export const TID_V4_WORKSPACE_MCP_PENDING_DISMISS = "v4-workspace-mcp-pending-dismiss";
/** v4 composer 容器 */
export const TID_V4_COMPOSER = "v4-composer";
/** v4 composer 文本输入 */
export const TID_V4_COMPOSER_INPUT = "v4-composer-input";
/** v4 composer 当前会话后台任务入口 */
export const TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER = "v4-composer-background-work-trigger";
/** v4 composer 电脑操作（CUA）常驻入口按钮 */
export const TID_V4_COMPOSER_CUA_ENTRY = "v4-composer-cua-entry";
/** v4 composer 发送按钮 */
export const TID_V4_COMPOSER_SEND = "v4-composer-send";
/** v4 暂停队列发送确认：清空队列并发送 */
export const TID_V4_COMPOSER_CLEAR_QUEUE_SEND = "v4-composer-clear-queue-send";
/** v4 暂停队列发送确认：保留队列并发送 */
export const TID_V4_COMPOSER_KEEP_QUEUE_SEND = "v4-composer-keep-queue-send";
/** v4 暂停队列发送确认弹窗 */
export const TID_V4_PAUSED_QUEUE_SEND_DIALOG = "v4-paused-queue-send-dialog";
/** V4 composer 附件 chip（动态后缀为附件 id） */
export const TID_V4_ATTACHMENT = "v4-attachment";
/** V4 composer 附件上传进度（动态后缀为附件 id） */
export const TID_V4_ATTACHMENT_UPLOAD_PROGRESS = "v4-attachment-upload-progress";
/** V4 composer 附件上传重试（动态后缀为附件 id） */
export const TID_V4_ATTACHMENT_UPLOAD_RETRY = "v4-attachment-upload-retry";
/** v4 stop 按钮 */
export const TID_V4_STOP = "v4-stop";
/** v4 assistant 行 fork 按钮（动态后缀为 rowId） */
export const TID_V4_FORK = "v4-fork";
/** v4 assistant 行 retry 按钮（动态后缀为 rowId） */
export const TID_V4_RETRY = "v4-retry";
/** v4 assistant 行点赞按钮（动态后缀为 rowId） */
export const TID_V4_FEEDBACK_LIKE = "v4-feedback-like";
/** v4 assistant 行点踩按钮（动态后缀为 rowId） */
export const TID_V4_FEEDBACK_DISLIKE = "v4-feedback-dislike";
/** v4 turn Hook 详情按钮（动态后缀为 product turnId） */
export const TID_V4_HOOK_DETAILS_TRIGGER = "v4-hook-details-trigger";
/** v4 turn Hook 详情 Popover（动态后缀为 product turnId） */
export const TID_V4_HOOK_DETAILS_CONTENT = "v4-hook-details-content";
/** v4 user 行 edit 按钮（动态后缀为 rowId） */
export const TID_V4_EDIT = "v4-edit";
/** v4 user query 编辑输入框（动态后缀为 rowId） */
export const TID_V4_EDIT_INPUT = "v4-edit-input";
/** v4 user query 编辑提交按钮（动态后缀为 rowId） */
export const TID_V4_EDIT_SUBMIT = "v4-edit-submit";
/** v4 user query 编辑取消按钮（动态后缀为 rowId） */
export const TID_V4_EDIT_CANCEL = "v4-edit-cancel";
/** v4 user query 编辑附件删除按钮（动态后缀为 rowId-index） */
export const TID_V4_EDIT_ATTACHMENT_REMOVE = "v4-edit-attachment-remove";
export const TID_V4_EDIT_REWIND_WORKSPACE = "v4-edit-rewind-workspace";
/** v4 edit 文件冲突弹窗 */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG = "v4-edit-workspace-conflict-dialog";
/** v4 edit 文件冲突后降级为仅裁剪对话 */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY =
  "v4-edit-workspace-conflict-conversation-only";
/** v4 queue 面板容器 */
export const TID_V4_QUEUE = "v4-queue";
/** v4 暂停队列原因/恢复提示条 */
export const TID_V4_QUEUE_PAUSED_BANNER = "v4-queue-paused-banner";
/** v4 暂停队列继续自动消费按钮 */
export const TID_V4_QUEUE_RESUME = "v4-queue-resume";
/** v4 queue 项行内编辑输入框（动态后缀为 queueItemId） */
/** v4 queue 项（动态后缀为 queueItemId） */
export const TID_V4_QUEUE_ITEM = "v4-queue-item";
/** v4 queue 项删除按钮（动态后缀为 queueItemId） */
export const TID_V4_QUEUE_ITEM_DELETE = "v4-queue-item-delete";
/** v4 queue 项编辑按钮（动态后缀为 queueItemId） */
export const TID_V4_QUEUE_ITEM_EDIT = "v4-queue-item-edit";
/** v4 queue 项立即发送按钮（动态后缀为 queueItemId） */
export const TID_V4_QUEUE_ITEM_SEND_NOW = "v4-queue-item-send-now";
/** v4 queue 项上移按钮（动态后缀为 queueItemId） */
export const TID_V4_QUEUE_ITEM_UP = "v4-queue-item-up";
/** v4 输入控制：queue autoDrain 开关按钮（setAutoDrain 命令） */
export const TID_V4_AUTODRAIN_TOGGLE = "v4-autodrain-toggle";
/** v4 输入控制：followup 路由模式开关按钮（setFollowupMode 命令） */
export const TID_V4_FOLLOWUP_TOGGLE = "v4-followup-toggle";
/** v4 会话标题显示（meta.title，空则显示占位） */
export const TID_V4_SESSION_TITLE = "v4-session-title";
/** v4 会话重命名输入框（renameSession 命令） */
export const TID_V4_RENAME_INPUT = "v4-rename-input";
/** v4 会话重命名提交按钮（renameSession 命令） */
export const TID_V4_RENAME_SUBMIT = "v4-rename-submit";
/** v4 goal 状态横幅（objective + status，sendGoalCommand/resumeGoal 效果投影） */
export const TID_V4_GOAL_BANNER = "v4-goal-banner";
/** v4 会话删除按钮（deleteSession 命令；删除后回 draft） */
export const TID_V4_DELETE_SESSION = "v4-delete-session";
/** v4 后台工作面板（backgroundWorks 投影） */
export const TID_V4_BACKGROUND_WORKS = "v4-background-works";
/** v4 后台工作项（动态后缀为 workId） */
export const TID_V4_BACKGROUND_WORK_ITEM = "v4-background-work-item";
/** v4 后台工作取消按钮（cancelBackgroundWork 命令；动态后缀为 workId） */
export const TID_V4_BACKGROUND_WORK_CANCEL = "v4-background-work-cancel";
/** v4 模型配置显示（data-provider/data-model/data-thought，switchModelConfig 效果投影） */
export const TID_V4_MODEL_CONFIG = "v4-model-config";
// v4-model-provider-input / v4-model-model-input / v4-model-thought-input /
// v4-model-apply（调试表单）已退役——模型切换由 composer 工具条的
// TID_CHAT_MODEL_SELECT_* / TID_CHAT_THOUGHT_LEVEL_SELECT_* 承载。
/** v4 订阅失败重连按钮 */
export const TID_V4_RETRY_SUBSCRIBE = "v4-retry-subscribe";
/** v4 userInput 交互弹窗容器 */
export const TID_V4_USER_INPUT_DIALOG = "v4-user-input-dialog";
/** v4 userInput 选项按钮（动态后缀为 optionId） */
export const TID_V4_USER_INPUT_OPTION = "v4-user-input-option";
/** v4 userInput 自由文本输入 */
export const TID_V4_USER_INPUT_TEXT = "v4-user-input-text";
/** v4 时间线「回到底部」按钮（解除底部跟随后出现，虚拟滚动锚定） */
export const TID_V4_TIMELINE_BOTTOM = "v4-timeline-bottom";
/** v4 pane 外壳（Layout/Focus 层包装，动态后缀为 paneId；data-focused 标记焦点 pane，分屏） */
export const TID_V4_PANE_SHELL = "v4-pane-shell";
/** v4 向右拆分窗格按钮（pane header；一期为「打开分屏」，二期语义泛化为拆分） */
export const TID_V4_SPLIT_OPEN = "v4-split-open";
/** v4 向下拆分窗格按钮（pane header，网格布局） */
export const TID_V4_SPLIT_DOWN = "v4-split-down";
/** v4 关闭窗格按钮（非 primary pane header；一期为「关闭分屏」） */
export const TID_V4_SPLIT_CLOSE = "v4-split-close";
/** v4 分屏拖拽分隔条（pointer 拖动调宽；data-split-id 标记分割节点） */
export const TID_V4_SPLIT_DIVIDER = "v4-split-divider";
/** v4 pane header 的 workspace 徽标（跨 workspace pane 显示归属） */
export const TID_V4_PANE_WORKSPACE_BADGE = "v4-pane-workspace-badge";
/** 侧栏会话项上下文菜单「在分屏打开」（仅桌面 shell，收尾） */
export const TID_V4_TASK_OPEN_IN_SPLIT = "v4-task-open-in-split";
/** v4 时间线「加载更早」按钮（游标分页；窗口首行未到全序首行时出现） */
export const TID_V4_TIMELINE_LOAD_OLDER = "v4-timeline-load-older";
/** v4 对话轮次全局导航 rail（宽屏 2+ 可导航 turn 时出现） */
export const TID_V4_TURN_NAVIGATOR = "v4-turn-navigator";
/** v4 对话轮次导航项（动态后缀为 render unit key） */
export const TID_V4_TURN_NAVIGATOR_ITEM = "v4-turn-navigator-item";
/** v4 对话轮次导航 HoverCard 预览（动态后缀为 render unit key） */
export const TID_V4_TURN_NAVIGATOR_TOOLTIP = "v4-turn-navigator-tooltip";
/** v4 subagent 行下钻开关（动态后缀为 rowId；有 childSessionId 才可点） */
export const TID_V4_SUBAGENT_TOGGLE = "v4-subagent-toggle";
/** v4 subagent 下钻迷你时间线容器（动态后缀为 childSessionId） */
export const TID_V4_SUBAGENT_DRILLDOWN = "v4-subagent-drilldown";
/** v4 subagent 下钻「在分屏打开」入口（动态后缀为 childSessionId） */
/** @deprecated subagent 详情已迁移到右侧 tabs；保留常量避免外部旧测试编译失败。 */
export const TID_V4_SUBAGENT_OPEN_SPLIT = "v4-subagent-open-split";
export const TID_V4_SUBAGENT_OPEN_SIDE_PANE = "v4-subagent-open-side-pane";
/** v4 userInput 行附件列表（动态后缀为 rowId） */
export const TID_V4_ROW_ATTACHMENTS = "v4-row-attachments";
