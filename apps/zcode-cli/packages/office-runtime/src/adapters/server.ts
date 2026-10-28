import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OfficeError, PLUGIN_VERSION, SERVER_NAME } from "#office/contract.ts";
import { formatAnchor } from "#office/domain/anchor.ts";
import { truncateBytes } from "#office/domain/model.ts";
import type { DocumentOwner } from "#office/app/documents.ts";
import { createToolRegistrar, registerOfficeResources } from "#office/adapters/server-resources.ts";
import { registerPanelTools } from "#office/adapters/panel-tools.ts";
import { KIND_NAMES, describeDocument, describeSnapshot } from "#office/adapters/tool-results.ts";
import {
  EXAMPLE_ANCHORS,
  EXAMPLE_LOCATIONS,
  EXTENSIONS_OR,
  FILE_NOUN,
  QUOTE_BEST_FOR,
  READ_FORMS,
  TARGET_NOUNS,
  TITLE,
} from "#office/wording.ts";

export { describeDocument } from "#office/adapters/tool-results.ts";

export function createOfficeServer({
  owner,
  assetRoot,
}: {
  owner: DocumentOwner;
  assetRoot: string;
}) {
  const server = new McpServer({ name: SERVER_NAME, version: PLUGIN_VERSION });
  const register = createToolRegistrar(server);
  const anchor = z
    .string()
    .min(1)
    .max(1200)
    .describe(
      `Document anchor: <workspace-relative path>#<location>, e.g. ${EXAMPLE_ANCHORS}. Omit #<location> for the whole document.`,
    );
  register(
    "open_document",
    {
      description: `Open a ${EXTENSIONS_OR} workspace file in the ${TITLE} viewer panel. Optionally jump to a location. Returns its outline and anchor syntax. Use when the user wants to view, review or discuss ${FILE_NOUN}.`,
      input: {
        path: z.string().min(1).max(1000).describe("Workspace-relative path of the file."),
        at: z
          .string()
          .max(300)
          .optional()
          .describe(`Optional location, e.g. ${EXAMPLE_LOCATIONS}.`),
      },
      visibility: ["model", "app"],
      panel: true,
      openPanel: true,
    },
    async ({ path, at }) => {
      const snapshot = await owner.open(path, at);
      return { text: describeSnapshot(snapshot, "Opened"), structured: { ...snapshot } };
    },
  );
  register(
    "read_document",
    {
      description: `Read the document or one location as text: ${READ_FORMS}. Blocks carry anchors for citation/reveal. Long results are paged; continue with the returned cursor.`,
      input: {
        anchor,
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Cursor from the preceding read result."),
      },
      visibility: ["model"],
    },
    async ({ anchor: target, cursor }) => {
      const { info, at, page } = await owner.read(target, cursor ?? 0);
      const head = `${formatAnchor(info.path, at)} (${KIND_NAMES[info.kind]}, revision ${info.revision})`;
      const tail =
        page.next === null
          ? "[end]"
          : `[more: call read_document with anchor "${formatAnchor(info.path, at)}" and cursor ${page.next}]`;
      return {
        text: `${head}\n\n${page.text || "(no text)"}\n\n${tail}`,
        structured: { path: info.path, at, revision: info.revision, next: page.next },
      };
    },
  );
  register(
    "search_document",
    {
      description:
        "Find document text case-insensitively. Returns matching anchors and snippets; use read_document or show_in_viewer on them.",
      input: {
        path: z.string().min(1).max(1000),
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(100).optional(),
      },
      visibility: ["model"],
    },
    async ({ path, query, limit }) => {
      const { info, hits } = await owner.search(path, query, limit ?? 20);
      const text = hits.length
        ? [
            `${hits.length} matches for "${query}" in ${info.path}:`,
            ...hits.map((hit) => `- ${formatAnchor(info.path, hit.at)}  ${hit.snippet}`),
          ].join("\n")
        : `No matches for "${query}" in ${info.path}.`;
      return {
        text,
        structured: {
          path: info.path,
          hits: hits.map((hit) => ({ ...hit, anchor: formatAnchor(info.path, hit.at) })),
        },
      };
    },
  );
  register(
    "show_in_viewer",
    {
      description: `Point the user at ${TARGET_NOUNS}: open the dedicated ${TITLE} Agent panel, scroll to the first target and highlight all. Anchors must be in one document. quote highlights exact text (best for ${QUOTE_BEST_FOR}). Other viewer reports are not retargeted.`,
      input: {
        targets: z
          .array(z.object({ anchor, quote: z.string().max(500).optional() }))
          .min(1)
          .max(20),
        note: z.string().max(500).optional().describe("Caption next to the highlighted location."),
      },
      visibility: ["model"],
      panel: true,
      openPanel: true,
    },
    async ({ targets, note }) => {
      const snapshot = await owner.show(targets, note);
      return { text: describeSnapshot(snapshot, "Showing"), structured: { ...snapshot } };
    },
  );
  register(
    "get_view",
    {
      description: `See the user's document, visible location and selected text in the ${TITLE} panel. Use for "this", "here" or "the selected …". Multiple reported viewers require disambiguation.`,
      input: {
        viewId: z
          .string()
          .max(300)
          .optional()
          .describe("Viewer ID from an ambiguous get_view result."),
      },
      visibility: ["model"],
    },
    async ({ viewId }) => {
      const views = owner.views();
      if (!viewId && views.length > 1)
        return {
          text:
            "Multiple document viewers have reported views. Ask which document the user means, then call get_view with its viewId.\n" +
            views.map((view) => `${view.viewId}: ${view.path}`).join("\n"),
          structured: { ambiguous: true, views },
        };
      if (viewId && !views.some((view) => view.viewId === viewId))
        throw new OfficeError("invalid_token", "Unknown viewer; list viewers with get_view.");
      const view = owner.view(viewId);
      const current = view.path ? await owner.info(view.path) : owner.current();
      if (!current && !view.path)
        return {
          text: `The ${TITLE} viewer has no document open. Use open_document to open one.`,
          structured: { view, document: null },
        };
      const path = view.path ?? current!.path;
      const lines = [`Open document: ${path}`];
      if (view.at) lines.push(`Visible location: ${formatAnchor(path, view.at)}`);
      if (view.selection) {
        lines.push(`User selection: ${formatAnchor(path, view.selection.at)}`);
        if (view.selection.text) lines.push(`Selected text: """${view.selection.text}"""`);
        if (view.kind === "xlsx") {
          const stored = await owner.read(formatAnchor(path, view.selection.at)).catch(() => null);
          if (stored)
            lines.push(
              "Selected cells as stored in the file:",
              truncateBytes(stored.page.text, 4096),
            );
        }
      } else lines.push("No selection.");
      if (view.updatedAt)
        lines.push(
          `(reported ${Math.max(0, Math.round((Date.now() - view.updatedAt) / 1000))} s ago)`,
        );
      if (current) lines.push("", describeDocument(current, 30));
      return { text: lines.join("\n"), structured: { view, document: current } };
    },
  );
  registerPanelTools(register, owner);
  registerOfficeResources(server, owner, assetRoot);
  return server;
}
