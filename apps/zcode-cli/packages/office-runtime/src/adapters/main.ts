import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OfficeError } from "#office/contract.ts";
import { createDocumentOwner } from "#office/app/documents.ts";
import { createWorkspaceFiles } from "#office/adapters/files.ts";
import { createOfficeServer } from "#office/adapters/server.ts";
import { PARSERS } from "#office/adapters/parsers.ts";

// 复用既有 plugin-host 调用导出的 main；import 时不能抢先启动第二个 executor/stdio。
export async function main(): Promise<void> {
  const dist = dirname(fileURLToPath(import.meta.url));
  const assetRoot = join(dist, "ui");
  const pdfAssets = {
    cMapUrl: `${join(assetRoot, "pdfjs/cmaps")}/`,
    standardFontDataUrl: `${join(assetRoot, "pdfjs/standard_fonts")}/`,
  };
  // 沿用已有 MCP 工作区上下文；不创建新环境变量或读取用户全局数据。
  const workspace = process.env.ZCODE_WORKSPACE_ROOT || process.cwd();
  const owner = createDocumentOwner({
    files: createWorkspaceFiles(workspace),
    async parse(file) {
      const parse = PARSERS[file.kind];
      if (!parse) throw new OfficeError("unsupported_type", "Unsupported document format.");
      return parse(file.bytes, file.path, pdfAssets);
    },
  });
  // 本仓 viewer 只读：启动和退出均无 importer、目录创建、过期文件清扫或写入。
  const server = createOfficeServer({ owner, assetRoot });
  let stopping = false;
  async function close() {
    if (stopping) return;
    stopping = true;
    owner.dispose();
    await server.close();
  }
  const shutdown = () =>
    void close().catch(() => {
      process.stderr.write("[office-runtime] shutdown_failed\n");
    });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.stdin.once("end", shutdown);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(() => {
    // 错误入口不输出 raw stack、用户路径或内容；宿主仍能观察到非零退出。
    process.stderr.write("[office-runtime] startup_failed\n");
    process.exitCode = 1;
  });
}
