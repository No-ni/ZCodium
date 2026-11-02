import { z } from "zod";
import type { RegisterOfficeTool } from "#office/adapters/server-resources.ts";
import { describeDocument, describeSnapshot } from "#office/adapters/tool-results.ts";
import { FILES_NOUN } from "#office/wording.ts";

/** All panel commands are workspace-read or in-memory reports; no import/write command exists. */
export function registerPanelTools(register: RegisterOfficeTool) {
  register(
    "list_documents",
    {
      description: `List ${FILES_NOUN} in the workspace for the viewer's file picker.`,
      input: { limit: z.number().int().min(1).max(1000).optional() },
      visibility: ["app"],
    },
    async ({ limit }, session) => {
      const documents = await session.list(limit ?? 500);
      return { text: `${documents.length} documents`, structured: { documents } };
    },
  );
  register(
    "load_document",
    {
      description:
        "Load a document for rendering: returns info and an in-memory handle for the bytes.",
      input: { path: z.string().min(1).max(1000) },
      visibility: ["app"],
    },
    async ({ path }, session) => {
      const loaded = await session.load(path);
      return { text: describeDocument(loaded.info, 10), structured: { ...loaded } };
    },
  );
  register(
    "check_document",
    {
      description:
        "Return the document revision and validate an optional viewer/capture location without returning text.",
      input: { path: z.string().min(1).max(1000), at: z.string().min(1).max(300).optional() },
      visibility: ["app"],
    },
    async ({ path, at }, session) => {
      const checked = await session.check(path, at);
      return {
        text: checked.info.revision,
        structured: { path: checked.info.path, revision: checked.info.revision, at: checked.at },
      };
    },
  );
  register(
    "get_viewer",
    {
      description: "Return the document assigned to the dedicated Agent surface.",
      input: {},
      visibility: ["app"],
    },
    async (_input, session) => {
      const snapshot = session.snapshot();
      return { text: describeSnapshot(snapshot, "Viewer has"), structured: { ...snapshot } };
    },
  );
  register(
    "report_view",
    {
      description:
        "Record this viewer's location and selection in memory only; never writes files.",
      input: {
        viewId: z.string().min(1).max(300).optional(),
        path: z.string().min(1).max(1000),
        at: z.string().max(300).nullable().optional(),
        selection: z
          .object({ at: z.string().min(1).max(300), text: z.string().max(20000) })
          .nullable()
          .optional(),
      },
      visibility: ["app"],
      readOnly: false,
    },
    async (input, session) => ({ text: "ok", structured: { view: await session.report(input) } }),
  );
  register(
    "release_view",
    {
      description: "Release this viewer's in-memory report when its page leaves.",
      input: { viewId: z.string().min(1).max(300) },
      visibility: ["app"],
      readOnly: false,
    },
    async ({ viewId }, session) => {
      session.releaseView(viewId);
      return { text: "ok" };
    },
  );
}
