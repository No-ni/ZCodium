import type { DocKind, DocumentInfo, ViewerSnapshot } from "#office/contract.ts";
import { TEXT_BUDGET } from "#office/contract.ts";
import { formatAnchor } from "#office/domain/anchor.ts";
import { truncateBytes } from "#office/domain/model.ts";
import { wellFormed, wellFormedDeep } from "#office/domain/text.ts";
import { TITLE } from "#office/wording.ts";

export const KIND_NAMES: Record<DocKind, string> = {
  docx: "Word document",
  xlsx: "Excel workbook",
  pptx: "PowerPoint presentation",
  pdf: "PDF",
};
const UNIT_NAMES: Record<DocKind, string> = {
  docx: "blocks",
  xlsx: "sheets",
  pptx: "slides",
  pdf: "pages",
};
const LOCATION_HELP: Record<DocKind, string> = {
  docx: "Locations: p:N (paragraph), p:N-M, t:N (table), t:N/rRcC (table cell).",
  xlsx: "Locations: Sheet, Sheet!A1, Sheet!A1:D20 (quote names with spaces: 'Q3 data'!A1).",
  pptx: "Locations: slide:N, slide:N-M, slide:N/shape:ID.",
  pdf: "Locations: page:N, page:N-M.",
};

export function describeDocument(info: DocumentInfo, outlineLimit = 60): string {
  const lines = [
    `${info.path}: ${KIND_NAMES[info.kind]}, ${info.units} ${UNIT_NAMES[info.kind]}, ${(info.bytes / 1024).toFixed(0)} KiB, revision ${info.revision}.`,
  ];
  if (info.title) lines.push(`Title: ${info.title}`);
  if (info.outline.length) {
    lines.push(info.kind === "xlsx" ? "Sheets:" : info.kind === "pptx" ? "Slides:" : "Outline:");
    for (const item of info.outline.slice(0, outlineLimit))
      lines.push(
        `${"  ".repeat(Math.min(8, Math.max(0, item.level - 1)))}- ${formatAnchor(info.path, item.at)}  ${item.label}`,
      );
    if (info.outline.length > outlineLimit)
      lines.push(`  … ${info.outline.length - outlineLimit} more`);
  }
  lines.push(LOCATION_HELP[info.kind]);
  return lines.join("\n");
}

export function describeSnapshot(snapshot: ViewerSnapshot, verb: string): string {
  if (!snapshot.document) return `The ${TITLE} viewer has no document open.`;
  const path = snapshot.document.path;
  const parts = [`${verb} ${path} in the ${TITLE} panel.`];
  if (snapshot.reveal?.targets.length)
    parts.push(
      `Showing: ${snapshot.reveal.targets.map((target) => formatAnchor(path, target.at) + (target.quote ? ` ("${target.quote}")` : "")).join(", ")}.`,
    );
  parts.push(
    "",
    describeDocument(snapshot.document),
    "",
    "Use read_document to read content; the user sees the rendered file in the panel.",
  );
  return parts.join("\n");
}

/** MCP 出口统一修复 UTF-16 并限制文本；大文档由 read_document 的 cursor 分页。 */
export function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: wellFormed(truncateBytes(text, TEXT_BUDGET)) }],
    ...(structuredContent ? { structuredContent: wellFormedDeep(structuredContent) } : {}),
  };
}
