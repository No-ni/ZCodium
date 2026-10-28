import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ASSET_PREFIX,
  DOC_KINDS,
  FILE_PREFIX,
  HTML_MIME,
  OfficeError,
  PANEL_URI,
  SURFACE_ID,
  safeOfficeError,
} from "#office/contract.ts";
import type { DocumentOwner } from "#office/app/documents.ts";
import { createOfficeAssets } from "#office/adapters/assets.ts";
import { textResult } from "#office/adapters/tool-results.ts";

export interface OfficeToolConfig<Shape extends z.ZodRawShape> {
  description: string;
  input: Shape;
  visibility: ("model" | "app")[];
  panel?: boolean;
  openPanel?: boolean;
  readOnly?: boolean;
}

export function createToolRegistrar(server: McpServer) {
  return <Shape extends z.ZodRawShape>(
    name: string,
    config: OfficeToolConfig<Shape>,
    execute: (
      input: z.infer<z.ZodObject<Shape>>,
    ) => Promise<{ text: string; structured?: Record<string, unknown> }>,
  ) => {
    server.registerTool(
      name,
      {
        description: config.description,
        inputSchema: config.input,
        annotations: {
          readOnlyHint: config.readOnly ?? true,
          destructiveHint: false,
          openWorldHint: false,
        },
        _meta: {
          ui: config.panel
            ? { resourceUri: PANEL_URI, surface: SURFACE_ID, visibility: config.visibility }
            : { visibility: config.visibility },
          ...(config.openPanel ? { "openai/ui": { preferredModelDisplayMode: "fullscreen" } } : {}),
        },
      },
      (async (input: z.infer<z.ZodObject<Shape>>) => {
        try {
          const { text, structured } = await execute(input);
          return textResult(text, structured);
        } catch (error) {
          // 中文说明：MCP 是隐私出口，禁止打印解析器/IO 的 raw message、stack、路径或正文。
          const safe = safeOfficeError(error);
          return {
            isError: true,
            ...textResult(`[${safe.code}] ${safe.message}`, { error: safe }),
          };
        }
      }) as never,
    );
  };
}

export type RegisterOfficeTool = ReturnType<typeof createToolRegistrar>;

export function registerOfficeResources(
  server: McpServer,
  owner: DocumentOwner,
  assetRoot: string,
) {
  const assets = createOfficeAssets(assetRoot);
  const panelMeta = {
    ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } },
    ...(DOC_KINDS.some((kind) => kind === "pdf" || kind === "xlsx")
      ? { "zcode/csp": { wasmUnsafeEval: true } }
      : {}),
  };
  const resource = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      const safe = safeOfficeError(error);
      throw new OfficeError(safe.code, `[${safe.code}] ${safe.message}`);
    }
  };
  server.registerResource("panel", PANEL_URI, { mimeType: HTML_MIME, _meta: panelMeta }, async () =>
    resource(async () => ({
      contents: [{ uri: PANEL_URI, ...(await assets.read("panel.html")), _meta: panelMeta }],
    })),
  );
  server.registerResource(
    "assets",
    new ResourceTemplate(`${ASSET_PREFIX}{+name}`, { list: undefined }),
    {},
    async (uri) =>
      resource(async () => {
        if (!uri.href.startsWith(ASSET_PREFIX))
          throw new OfficeError("invalid_resource", "Invalid asset.");
        let name: string;
        try {
          name = decodeURIComponent(uri.href.slice(ASSET_PREFIX.length));
        } catch {
          throw new OfficeError("invalid_resource", "Invalid asset encoding.");
        }
        return { contents: [{ uri: uri.href, ...(await assets.read(name)) }] };
      }),
  );
  server.registerResource(
    "file",
    new ResourceTemplate(`${FILE_PREFIX}{token}/{index}`, { list: undefined }),
    {},
    async (uri, { token, index }) =>
      resource(async () => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/octet-stream",
            blob: owner.chunk(String(token), Number(index)),
          },
        ],
      })),
  );
}
