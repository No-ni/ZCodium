import type {
  ConversationRow,
  TimelineMarkerPayload,
  WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";
import { Lexer } from "marked";
import {
  findMarkdownCodeRanges,
  overlapsAssistantTextRanges,
} from "@/lib/assistantDirectiveParser.js";
import { extractZCodeFileCitationDirectives } from "@/lib/zcodeFileCitation.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { splitUserInputEpilogue } from "@/v4/ConversationUserInputEpilogue.js";
import { getPathLeaf, toFileUrl } from "@/lib/path.js";

/** 标题和文件名来自纯文本字段，不能被重新解释成 Markdown 或 HTML。 */
function plainText(text: string): string {
  return text.replace(/[\\`*_[\]<>&]/gu, "\\$&");
}

function closeOpenFence(text: string): string {
  if (!/(?:^|\n) {0,3}(?:`{3,}|~{3,})/u.test(text)) return text;
  // 用已有 Markdown lexer 判断顶层代码块，避免把列表中的围栏补成新的顶层代码块。
  const last = Lexer.lex(text).at(-1);
  if (last?.type !== "code") return text;
  const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(last.raw)?.[1];
  if (
    !marker ||
    new RegExp(`\\n {0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\r?\\n)?$`, "u").test(last.raw)
  )
    return text;
  // 流式消息可能没有关闭围栏；拼接下一条消息前必须补齐，否则后续回复会成为代码正文。
  return `${text}${text.endsWith("\n") ? "" : "\n"}${marker}\n`;
}

function fenced(text: string): string {
  let length = 3;
  for (const match of text.matchAll(/`{3,}/gu)) length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}\n${text}\n${fence}`;
}

function details(summary: string, body: string): string {
  const label = summary.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<details>\n<summary>${label}</summary>\n\n${body}\n\n</details>`;
}

function fileLink(name: string, ref: string): string {
  const label = plainText(name);
  // 内部附件引用不能在普通 Markdown 阅读器中打开；只保留名称，不导出无效协议。
  if (
    /[\r\n]/u.test(ref) ||
    (/^[a-z][a-z\d+.-]*:/iu.test(ref) && !/^(?:https?:|file:|[a-z]:[\\/])/iu.test(ref))
  )
    return label;
  // 路径中的 #/?/% 是文件名的一部分；已有 URL 的 query/fragment 则须原样保留。
  const destination = /^(?:https?:|file:)/iu.test(ref)
    ? ref.replaceAll(" ", "%20").replaceAll("<", "%3C").replaceAll(">", "%3E")
    : toFileUrl(ref);
  return destination ? `[${label}](<${destination}>)` : label;
}

function bodyMarkdown(text: string): string {
  const protectedRanges = findMarkdownCodeRanges(text);
  const citations = extractZCodeFileCitationDirectives(text).filter(
    (citation) => !overlapsAssistantTextRanges(citation.start, citation.end, protectedRanges),
  );
  let result = text;
  for (const citation of citations.reverse()) {
    const path = citation.path ?? "";
    const name = path ? getPathLeaf(path) : "";
    result = `${result.slice(0, citation.start)}${fileLink(name, path)}${result.slice(citation.end)}`;
  }
  return closeOpenFence(result);
}

function timelineText(marker: TimelineMarkerPayload): string {
  switch (marker.type) {
    case "compact":
      return `Context compaction: ${marker.status}`;
    case "modelChange":
      return `Model changed: ${marker.fromModel ? `${marker.fromModel} → ` : ""}${marker.toModel}`;
    case "goalSet":
      return `Goal: ${marker.objective}`;
    case "goalVerify":
      return `Goal verification: ${marker.outcome}${marker.detail ? `\n\n${marker.detail}` : ""}`;
    case "retryNotice":
      return `Retry ${marker.attempt}: ${marker.reasonCode}`;
    case "forkNotice":
      return "Conversation forked from an earlier conversation.";
    case "forkCreated":
      return "A new conversation was forked here.";
    case "checkpointRestored":
      return "Checkpoint restored.";
  }
}

function workflowSummary(launch: WorkflowLaunchMeta): string {
  const model = launch.amend?.subagentModel;
  const concurrency = launch.amend?.maxConcurrency;
  const parts = [
    launch.amend ? "Workflow settings updated." : "Workflow launched.",
    ...(launch.description ? [bodyMarkdown(launch.description)] : []),
    ...(launch.args ? [`### Arguments\n\n${fenced(JSON.stringify(launch.args, null, 2))}`] : []),
    ...(model
      ? [
          `Subagent model: ${plainText(model.from ?? "Session model")} → ${plainText(model.to ?? "Session model")}`,
        ]
      : []),
    ...(concurrency
      ? [
          `Max concurrency: ${concurrency.from ?? "Device limit"} → ${concurrency.to ?? "Device limit"}`,
        ]
      : []),
    ...(launch.amend?.ceiling !== undefined
      ? [`Concurrency ceiling: ${launch.amend.ceiling}`]
      : []),
  ];
  return details(`Workflow: ${launch.name ?? "Workflow"}`, parts.join("\n\n"));
}

/** 完整记录由调用方读取；这里复用时间线可见性，只生成可阅读的文本。 */
export function formatConversationMarkdown(
  title: string,
  rows: readonly ConversationRow[],
  showReasoning = true,
): string {
  const units = buildConversationTurnRenderUnits(rows);
  const launches = new Map(
    units.flatMap((unit) =>
      unit.workflowLaunch ? [[unit.turnId, unit.workflowLaunch] as const] : [],
    ),
  );
  const visible = new Set(units.flatMap((unit) => unit.renderRows.map((row) => row.rowId)));
  const firstReasoning = new Set(
    units.flatMap((unit) => {
      const first = unit.renderRows.find((row) => row.kind === "reasoning");
      return first ? [first.rowId] : [];
    }),
  );
  const sections = [`# ${plainText(title.trim().replace(/[\r\n]+/gu, " ") || "Conversation")}`];
  for (const row of rows) {
    if (row.kind === "turnHeader") {
      // 直接启动/配置轮只显示卡片，普通 renderRows 没有它的正文；必须从同一轮元数据导出摘要。
      const launch = launches.get(row.turnId);
      if (launch) sections.push(workflowSummary(launch));
      if (row.state === "completedInterrupted" || row.state === "failed") {
        sections.push(
          details("Session event", row.state === "failed" ? "Turn failed." : "Interrupted."),
        );
      }
      continue;
    }
    if (row.kind === "hookInvocation") {
      const executions = row.executions.filter((execution) => execution.didExecute);
      if (executions.length)
        sections.push(
          details(
            `Hook: ${row.hookEventName}`,
            executions
              .map(
                (execution) =>
                  `- ${execution.displayName}: ${execution.outcome ?? execution.state}${execution.blockReason ? ` — ${execution.blockReason}` : ""}`,
              )
              .join("\n"),
          ),
        );
      continue;
    }
    if (!visible.has(row.rowId)) continue;
    switch (row.kind) {
      case "userInput": {
        const { body, epilogue } = splitUserInputEpilogue(row.text, row.epilogueStart);
        const attachments = (row.attachments ?? []).map(
          (attachment) => `- ${fileLink(attachment.fileName, attachment.ref)}`,
        );
        const text = [
          bodyMarkdown(body),
          ...(attachments.length ? [`### Attachments\n\n${attachments.join("\n")}`] : []),
          ...(epilogue?.trim() ? [details("Additional context", fenced(epilogue))] : []),
        ]
          .filter((part) => part.trim())
          .join("\n\n");
        if (text)
          sections.push(
            row.origin === "realUser" ? `## User\n\n${text}` : details("Session context", text),
          );
        break;
      }
      case "assistantText": {
        // 引用投影可能清空原文；空内容不能仅凭原始字符串非空而生成角色标题。
        const text = bodyMarkdown(row.text);
        if (text.trim()) sections.push(`## Assistant\n\n${text}`);
        break;
      }
      case "reasoning": {
        if (showReasoning || firstReasoning.has(row.rowId)) {
          const text = bodyMarkdown(row.text);
          if (text.trim()) sections.push(details("Reasoning", text));
        }
        break;
      }
      case "toolCall": {
        const output = row.output?.text ?? row.outputPreview?.fullText ?? row.outputPreview?.text;
        const text = [
          `Status: ${row.status}`,
          `### Input\n\n${fenced(row.inputText)}`,
          ...(output ? [`### Output\n\n${fenced(output)}`] : []),
          ...(row.output?.truncated ? ["Output truncated in the conversation record."] : []),
          ...(row.error ? [`### Error\n\n${fenced(row.error.message)}`] : []),
        ];
        sections.push(details(`Tool: ${row.toolName}`, text.join("\n\n")));
        break;
      }
      case "artifact":
        sections.push(`### File\n\n${fileLink(row.displayName, row.ref)}`);
        break;
      case "subagent":
        sections.push(
          details(
            `Subtask: ${row.subagentType}`,
            `Status: ${row.status}${row.summaryText ? `\n\n${bodyMarkdown(row.summaryText)}` : ""}`,
          ),
        );
        break;
      case "timelineMarker":
        sections.push(details("Session event", timelineText(row.marker)));
        break;
    }
  }
  return sections.length > 1 ? `${sections.join("\n\n")}\n` : "";
}
