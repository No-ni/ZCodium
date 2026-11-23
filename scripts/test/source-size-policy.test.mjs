import ts from "typescript";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createProjectTestSandbox, projectRoot } from "../ci/project-test-sandbox.mjs";

const execute = promisify(execFile);

async function fixture(configPath) {
  const sandbox = await createProjectTestSandbox("source-size-policy");
  const { config } = ts.parseConfigFileTextToJson(
    configPath,
    await readFile(join(projectRoot, configPath), "utf8"),
  );
  if (config.extends) {
    const { config: rootConfig } = ts.parseConfigFileTextToJson(
      ".oxlintrc.json",
      await readFile(join(projectRoot, ".oxlintrc.json"), "utf8"),
    );
    Object.assign(config, rootConfig);
    delete config.extends;
  }
  // 用户确认优先官方基线；规则与准入入口恢复官方 800 行政策，不靠拆分源码消除行数诊断。
  config.ignorePatterns = [];
  const configFile = join(sandbox.root, "oxlint.json");
  await writeFile(configFile, JSON.stringify(config), { flag: "wx" });
  return async (file, lines, { comments = 0, blanks = 0 } = {}) => {
    const target = join(sandbox.root, file);
    await mkdir(dirname(target), { recursive: true });
    const source = [
      ...Array.from({ length: lines }, (_, i) => "export const value" + i + " = " + i + ";"),
      ...Array.from({ length: comments }, () => "// synthetic comment"),
      ...Array.from({ length: blanks }, () => ""),
    ].join("\n");
    await writeFile(target, source);
    let result;
    try {
      result = await execute(
        process.execPath,
        [
          join(projectRoot, "node_modules/oxlint/bin/oxlint"),
          "--config",
          configFile,
          "--format",
          "json",
          file,
        ],
        { cwd: sandbox.root, env: sandbox.env, windowsHide: true },
      );
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      result = error;
    }
    return JSON.parse(result.stdout).diagnostics.filter(
      (item) => item.code === "eslint(max-lines)",
    );
  };
}

for (const configPath of [".oxlintrc.json", "apps/zcode-cli/oxlint.config.json"]) {
  test(configPath + "：官方 800/801 边界，注释空行不计数，原有大文件仅降级行数诊断", async () => {
    const lint = await fixture(configPath);
    const regular = "packages/example/src/new.ts";
    assert.deepEqual(await lint(regular, 800, { comments: 30, blanks: 30 }), []);
    assert.equal((await lint(regular, 801))[0]?.severity, "error");
    assert.equal(
      (await lint("apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts", 801))[0]
        ?.severity,
      "warning",
    );
    assert.deepEqual(await lint("packages/example/test/new.test.mjs", 801), []);
  });
}

test("无测试后缀的精确夹具例外不覆盖相邻生产入口", async () => {
  const lint = await fixture(".oxlintrc.json");
  // 原因：上游按业务场景搬迁了精确夹具；测试必须使用现行路径，不能新增旧路径豁免。
  for (const file of [
    "packages/web/test/e2e/remote-control/transport/manual-review/pending/remote-large-rpc.mjs",
    "packages/desktop/test/e2e/helpers/project-sidebar.ts",
    "packages/desktop/scripts/mcp-apps-host-fixture/managed-renderer.tsx",
  ])
    assert.deepEqual(await lint(file, 801), []);
  assert.equal(
    (await lint("packages/desktop/scripts/mcp-apps-host-fixture/production.ts", 801))[0]?.severity,
    "error",
  );
});
