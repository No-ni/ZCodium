import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { build } from "esbuild";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

const run = promisify(execFile);

for (const format of ["esm", "cjs"]) {
  test(`native kernel public tokenizer loads after ${format} bundling`, async () => {
    const sandbox = await createProjectTestSandbox(`native-kernel-${format}`);
    const outfile = await assertProjectPath(
      join(sandbox.root, `kernel.${format === "esm" ? "mjs" : "cjs"}`),
    );
    await build({
      stdin: {
        contents: `
          import { defaultCountTokens, createBpeTokenizer } from "acp-kernel";
          const fallback = createBpeTokenizer();
          process.stdout.write(JSON.stringify({
            empty: defaultCountTokens(""),
            cjk: defaultCountTokens("上下文压缩"),
            mixed: defaultCountTokens("上下文abcd"),
            optionalFallback: fallback("上下文abcd"),
          }));
        `,
        resolveDir: join(projectRoot, "apps/zcode-cli/packages/core"),
        sourcefile: "native-kernel-startup.ts",
      },
      outfile,
      bundle: true,
      format,
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    // 真实子进程求值能捕获 CJS 的 import.meta 初始化崩溃，源码类型检查不能证明可装载。
    const result = await run(process.execPath, [outfile], {
      cwd: sandbox.root,
      env: sandbox.env,
      windowsHide: true,
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      empty: 0,
      cjk: 5,
      mixed: 4,
      optionalFallback: 4,
    });
  });
}
