import finderIcon from "@/onboarding/assets/finder.png";
import terminalIcon from "@/onboarding/assets/terminal.png";
import feishuIcon from "@/onboarding/assets/feishu.png";
import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

export const defaultSuggestedPrompts: DraftSuggestedPromptItem[] = [
  {
    id: "office-organize",
    iconUrl: finderIcon,
    label: {
      cn: "帮我看看我现在电脑上什么文件占用了主要空间？",
      en: "Help me see which files are taking up the most space on my computer.",
    },
    prompt: {
      cn: "帮我看看我现在电脑上什么文件占用了主要空间？",
      en: "Help me see which files are taking up the most space on my computer.",
    },
  },
  {
    id: "office-clean",
    iconUrl: terminalIcon,
    label: {
      cn: "帮我使用 Mole CLI 清理下电脑的冗余文件",
      en: "Use Mole CLI to clean redundant files on my computer.",
    },
    prompt: {
      cn: "帮我使用 Mole CLI 清理下电脑的冗余文件",
      en: "Use Mole CLI to clean redundant files on my computer.",
    },
  },
  {
    id: "office-review",
    iconUrl: feishuIcon,
    label: {
      cn: "帮我用飞书 CLI 获取下我昨天的工作情况，梳理今日工作待办",
      en: "Use Feishu CLI to review my work from yesterday and organize today’s to-dos.",
    },
    prompt: {
      cn: "帮我用飞书 CLI 获取下我昨天的工作情况，梳理今日工作待办",
      en: "Use Feishu CLI to review my work from yesterday and organize today’s to-dos.",
    },
  },
];
