export const SESSION_TITLE_SOURCES = ["default", "first_input", "generated", "custom"] as const;
export type SessionTitleSource = (typeof SESSION_TITLE_SOURCES)[number];

export const MESSAGE_VISIBILITIES = ["user-visible", "model-only"] as const;
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number];

export const SYNTHETIC_USER_MESSAGE_SOURCES = [
  "agent_listing_delta",
  "background_task",
  "fork",
  "goal_state_change",
  "goal-continuation",
  "plugin_reference",
  "bot_topic_context",
  "rewind",
  "selection_side_chat",
  "subagent",
  "subagent_message",
  "todo_reminder",
  // 中枢直接启动已保存工作流时落的那条 user 消息的来源。
  // 它虽是 synthetic（GUI 用元数据画启动卡而非显示文本），语义上却是用户真实动作：
  // origin=real_user、kind=user_prompt，与其余「运行时注入的提醒」类来源不同档。
  "workflow_launch",
  "shared_context",
] as const;
export type SyntheticUserMessageSource = (typeof SYNTHETIC_USER_MESSAGE_SOURCES)[number];
