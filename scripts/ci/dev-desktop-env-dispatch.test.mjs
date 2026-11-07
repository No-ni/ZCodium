import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const repoRoot = resolve(import.meta.dirname, "../..");
const source = await readFile(resolve(repoRoot, "scripts/dev-desktop-env.mjs"), "utf8");
const parsed = ts.createSourceFile("dev-desktop-env.mjs", source, ts.ScriptTarget.Latest, true);
const dispatch = parsed.statements.filter(ts.isTryStatement);
assert.equal(dispatch.length, 1, "开发入口必须保持唯一顶层调度及失败出口");

async function executeDispatch({ platform, helperAvailable, agentBytecode, failAt = -1 }) {
  const calls = [];
  const errors = [];
  const exits = [];
  // 直接执行实际调度源码，只替换副作用；不能重写条件而漏掉未声明变量读取。
  const execute = runInNewContext(
    `(async () => { ${dispatch[0].getText(parsed)} })`,
    {
      repoRoot,
      pnpmCommand: platform === "win32" ? "pnpm.cmd" : "pnpm",
      agentBytecode,
      hasComputerUseHelperProducer: helperAvailable,
      resolve,
      // 副作用替身与catch共用Error构造器，避免VM跨realm把同类失败误记为任意对象。
      Error,
      process: {
        platform,
        execPath: resolve(repoRoot, "synthetic-node.exe"),
        exit: (code) => exits.push(code),
      },
      console: { error: (message) => errors.push(message) },
      run: async (command, args) => {
        calls.push({ command, args: Array.from(args) });
        if (calls.length - 1 === failAt) throw new Error("synthetic stage failure");
      },
    },
    { timeout: 1000 },
  );
  await execute();
  return { calls, errors, exits };
}

function expectedCalls(platform, helperAvailable, agentBytecode) {
  const node = resolve(repoRoot, "synthetic-node.exe");
  const calls = [];
  if (platform === "darwin" && helperAvailable) {
    calls.push({
      command: node,
      args: [resolve(repoRoot, "scripts/build-cua-helper-app.mjs"), "--allow-unsigned-launcher-local-dev"],
    });
  }
  const pnpm = platform === "win32" ? "pnpm.cmd" : "pnpm";
  calls.push({ command: pnpm, args: ["--filter", "@zcode/desktop", "pre-dev"] });
  const agentNode = platform === "win32" ? "node" : node;
  calls.push({ command: agentNode, args: [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")] });
  if (agentBytecode) {
    calls.push({ command: agentNode, args: [resolve(repoRoot, "scripts/build-desktop-agent-bytecode.mjs")] });
  }
  calls.push({ command: pnpm, args: ["--filter", "@zcode/desktop", "dev:runtime"] });
  return calls;
}

for (const platform of ["darwin", "win32"]) {
  for (const helperAvailable of [false, true]) {
    for (const agentBytecode of [false, true]) {
      test(`${platform} Helper=${helperAvailable} bytecode=${agentBytecode} 按能力与显式选项串行调度`, async () => {
        const result = await executeDispatch({ platform, helperAvailable, agentBytecode });
        assert.deepEqual(result.errors, [], "开发入口不得读取未声明变量");
        assert.deepEqual(result.exits, []);
        assert.deepEqual(result.calls, expectedCalls(platform, helperAvailable, agentBytecode));
      });
    }
  }
}

test("任一准备阶段拒绝后停止调度并保留失败出口", async () => {
  for (const platform of ["darwin", "win32"]) {
    const expected = expectedCalls(platform, true, true);
    for (let failAt = 0; failAt < expected.length; failAt++) {
      const result = await executeDispatch({ platform, helperAvailable: true, agentBytecode: true, failAt });
      assert.deepEqual(result.calls, expected.slice(0, failAt + 1));
      assert.deepEqual(result.errors, ["synthetic stage failure"]);
      assert.deepEqual(result.exits, [1]);
    }
  }
});
