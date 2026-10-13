import { createHash } from "node:crypto";

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import { ConversationShareServiceError } from "#src/conversation-share/conversationShare.js";

interface SharedContextFormatterInputV1 {
  share: { shareId: string; title: string };
  rows: ConversationRow[];
  installedArtifacts: Array<{
    artifactId: string;
    workspaceRelativePath: string;
    /**
     * 安装文件的绝对路径（= 工作区根 + workspaceRelativePath）。
     *
     * 为什么必须写绝对路径：导入会话的执行 cwd 不再是工作区根——对话工作区会话跑在
     * `<对话根>/<日期>/<id8>`，项目工作区会话才跑在工作区根。`- Path:` 是给模型读的，
     * 写相对对话根的 `.zcodium-share/...` 时两种 cwd 都解析不到（模型会按自己的 cwd 拼接），
     * 绝对路径在两种 cwd 下都指向同一份已安装文件。
     */
    absolutePath: string;
    displayName: string;
    mimeType: string;
    sha256: string;
  }>;
}

interface SharedContextDocumentV1 {
  formatterVersion: 1;
  markdown: string;
  markdownSha256: string;
  /** 本 build 认不出、没能进 Markdown 的 row kind；调用方负责记日志。 */
  unsupportedKinds: string[];
}

function fenced(value: string): string {
  const fence = value.includes("```") ? "````" : "```";
  return `${fence}\n${value}\n${fence}`;
}

export function formatSharedContextV1(
  input: SharedContextFormatterInputV1,
): SharedContextDocumentV1 {
  const paths = new Map(
    input.installedArtifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
  const sections = [`# Shared conversation: ${input.share.title}`];
  const unsupportedKinds = new Set<string>();
  for (const row of input.rows) {
    switch (row.kind) {
      case "turnHeader":
        break;
      case "userInput":
        {
          const attachmentLines = (row.attachments ?? []).flatMap((attachment) => {
            const artifactId = attachment.ref.startsWith("zcode-artifact://share/")
              ? attachment.ref.slice("zcode-artifact://share/".length)
              : "";
            const installed = paths.get(artifactId);
            return installed
              ? [
                  `- ${installed.displayName}`,
                  `  - Path: ${installed.absolutePath}`,
                  `  - MIME: ${installed.mimeType}`,
                  `  - SHA-256: ${installed.sha256}`,
                ]
              : [];
          });
          sections.push(
            `## User\n\n${row.text}${
              attachmentLines.length > 0
                ? `\n\n### Attachments\n\n${attachmentLines.join("\n")}`
                : ""
            }`,
          );
        }
        break;
      case "assistantText":
        sections.push(`## Assistant\n\n${row.text}`);
        break;
      case "reasoning":
        sections.push(`## Reasoning\n\n${row.text}`);
        break;
      case "toolCall":
        sections.push(
          `## Tool: ${row.toolName}\n\n### Input\n\n${fenced(row.inputText)}${
            row.output?.text ? `\n\n### Output\n\n${fenced(row.output.text)}` : ""
          }`,
        );
        break;
      case "timelineMarker":
        sections.push(`## Timeline\n\n${fenced(JSON.stringify(row.marker))}`);
        break;
      case "artifact": {
        const artifact = paths.get(row.artifactVersionId);
        if (!artifact) {
          throw new ConversationShareServiceError(
            "invalid_contract",
            "Shared context artifact was not installed",
          );
        }
        sections.push(
          [
            `## Artifact: ${artifact.displayName}`,
            `- Path: ${artifact.absolutePath}`,
            `- MIME: ${artifact.mimeType}`,
            `- SHA-256: ${artifact.sha256}`,
          ].join("\n"),
        );
        break;
      }
      case "subagent":
      case "hookInvocation":
        throw new ConversationShareServiceError(
          "invalid_contract",
          `Unsupported shared context row: ${row.kind}`,
        );
      default:
        // 未来新增的 row kind：不抛（一行认不出不该让整次导入失败），但也不能静默——
        // 模型侧少内容必须留痕，否则只能靠用户发现回答漏了东西。
        unsupportedKinds.add((row as { kind?: string }).kind ?? "unknown");
        break;
    }
  }
  const markdown = `${sections.join("\n\n")}\n`;
  return {
    // 保持 1：本字段是随 provenance 落盘/过协议的**信息字段**，没有任何消费方按它分支
    // （唯一出现处是 shared-context-import.ts 的 `formatterVersion: z.literal(1)` 形状校验）。
    // `- Path:` 由工作区相对改绝对只改变该行的取值，行的形状与 markdown 结构不变，且
    // markdownSha256 始终是这段真实 markdown 的哈希；升到 2 既不会让谁改变行为，还会让
    // 既存会话里 version=1 的 provenance 失去兼容，收益为零。
    formatterVersion: 1,
    markdown,
    markdownSha256: createHash("sha256").update(markdown, "utf8").digest("hex"),
    unsupportedKinds: [...unsupportedKinds],
  };
}
