// ============================================================
// Identity Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import type { OutputStylePromptConfig } from "../types.js";
import { estimateTokens } from "../utils.js";

const DEFAULT_AGENT_IDENTITY =
  "You are an agent working with the user toward their goals, using your own judgment along the way.";

const OUTPUT_STYLE_AGENT_IDENTITY =
  'You are an interactive agent that helps users according to your "Output Style", which describes how you should respond to user queries.';

/**
 * `# Harness` 块：稳定运行时约束，不属于 output style 可替换的 coding instructions，
 * 也是工作流子代理身份（sections/workflow-actor.ts）逐字复用的那一段。
 */
export function buildHarnessBlock(midConversationSystem = true): string {
  // 第三条描述动态上下文的真实送达通道：不走 MCS 时这些内容包在 user 的
  // `<system-reminder>` 里，继续声称 "mid-conversation system turns" 会与请求体矛盾。
  const deliveryNotice = midConversationSystem
    ? "The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results."
    : "`<system-reminder>` tags in messages and tool results are injected by the harness, not the user.";
  return [
    "# Harness",
    " - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.",
    " - Tools run behind a user-selected permission mode; a denied call means the user declined it \u2014 adjust, don't retry verbatim.",
    ` - ${deliveryNotice} Hooks may intercept tool calls; treat hook output as user feedback.`,
    " - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
    " - Reference code as `file_path:line_number` \u2014 it's clickable.",
  ].join("\n");
}

// 产品决定（docs/specs/context-system-prompt.md）：默认提示不注入内置安全声明，
// 也不新增替代文案；身份介绍与 Harness 仍按原契约组装。
function buildIdentityPrompt(
  outputStyle: OutputStylePromptConfig | undefined,
  midConversationSystem: boolean,
): string {
  const intro = outputStyle ? OUTPUT_STYLE_AGENT_IDENTITY : DEFAULT_AGENT_IDENTITY;

  const identityLines = ["", intro].join("\n");

  return [identityLines, "", buildHarnessBlock(midConversationSystem)].join("\n");
}

export function buildIdentitySection(
  outputStyle?: OutputStylePromptConfig,
  midConversationSystem = true,
): ContextSection {
  const content = buildIdentityPrompt(outputStyle, midConversationSystem);

  return {
    name: "Agent Identity",
    source: "identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
