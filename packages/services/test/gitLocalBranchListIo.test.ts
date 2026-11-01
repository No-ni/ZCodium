import assert from "node:assert/strict";
import test from "node:test";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";
import type {
  GitCommandExecutionOptions,
  GitCommandExecutionResult,
  GitCommandProvider,
} from "../src/git/providers/gitCommandProvider.js";

/**
 * 分支列表读取的 IO 边界回归。
 *
 * Bug 原因：listLocalBranches 只消费 HEAD 的 branchName / headRefType，却调用完整
 * getStatus——每次打开分支切换下拉都会额外执行两次全仓 numstat diff，并按未跟踪条目
 * 逐个读文件数行数；这些结果从不进入 GitLocalBranchListResult。
 *
 * 修复依据：分支头记录（# branch.head）与 --untracked-files 模式无关，用同一条
 * status 分支头命令配 --untracked-files=no 取数即可得到逐位一致的分支字段。
 *
 * 测试全程 hermetic：假 GitCommandProvider 记录命令序列，不启动真实 git、
 * 不写文件系统、不使用系统临时目录或真实用户数据。
 */

const WORKSPACE_PATH = "C:\\synthetic\\workspace";
const REPO_ROOT = "C:\\synthetic\\repo";

function commandResult(
  options: GitCommandExecutionOptions,
  {
    stdout = "",
    exitCode = 0,
    stderr = "",
  }: { stdout?: string; exitCode?: number; stderr?: string } = {},
): GitCommandExecutionResult {
  return {
    binaryPath: "git-test-double",
    cwd: options.cwd,
    args: options.args,
    stdout,
    stderr,
    exitCode,
    signal: null,
    durationMs: 0,
    timedOut: false,
    outputTruncated: false,
  };
}

function resolveRepositoryResult(options: GitCommandExecutionOptions): GitCommandExecutionResult {
  return commandResult(options, { stdout: `${REPO_ROOT}\n\n${REPO_ROOT}\n${REPO_ROOT}\n` });
}

const BRANCH_HEAD_STATUS = [
  "# branch.oid 1111111111111111111111111111111111111111",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +1 -2",
  // 一条已跟踪修改：证明分支字段不依赖任何条目级状态。
  "1 .M N... 100644 100644 100644 2222222222222222222222222222222222222222 2222222222222222222222222222222222222222 src/file.ts",
  "",
].join("\u0000");

const FOR_EACH_REF_OUTPUT = [
  "main\u0000origin/main\u0000aaaaaaa\u00001600000000",
  "feature/x\u0000\u0000bbbbbbb\u00001500000000",
  "",
].join("\n");

function createRecordingProvider(handlers: {
  status: (options: GitCommandExecutionOptions) => GitCommandExecutionResult;
  forEachRef: (options: GitCommandExecutionOptions) => GitCommandExecutionResult;
  resolveRepository?: (options: GitCommandExecutionOptions) => GitCommandExecutionResult;
  resolveGitBinary?: () => Promise<string | null>;
}): { provider: GitCommandProvider; commands: GitCommandExecutionOptions[] } {
  const commands: GitCommandExecutionOptions[] = [];
  const provider: GitCommandProvider = {
    resolveGitBinary: handlers.resolveGitBinary ?? (async () => "git-test-double"),
    run: async (options) => {
      commands.push(options);
      const [command, ...args] = options.args;
      if (command === "rev-parse" && args[0] === "--show-toplevel")
        return (handlers.resolveRepository ?? resolveRepositoryResult)(options);
      if (command === "status") return handlers.status(options);
      if (command === "for-each-ref") return handlers.forEachRef(options);
      return commandResult(options);
    },
  };
  return { provider, commands };
}

test("分支列表只读取 HEAD 分支字段，不再触发全量状态快照的 numstat 与未跟踪统计", async () => {
  const { provider, commands } = createRecordingProvider({
    status: (options) => commandResult(options, { stdout: BRANCH_HEAD_STATUS }),
    forEachRef: (options) => commandResult(options, { stdout: FOR_EACH_REF_OUTPUT }),
  });

  const repo = createGitCliRepo({ commandProvider: provider });
  const result = await repo.listLocalBranches(WORKSPACE_PATH);

  // 行为不变：分支、当前分支标注与排序和旧实现一致。
  assert.deepEqual(result, {
    headRefType: "branch",
    currentBranchName: "main",
    branches: [
      {
        name: "main",
        isCurrent: true,
        upstreamName: "origin/main",
        commitHash: "aaaaaaa",
        commitTimestampMs: 1_600_000_000_000,
      },
      {
        name: "feature/x",
        isCurrent: false,
        upstreamName: null,
        commitHash: "bbbbbbb",
        commitTimestampMs: 1_500_000_000_000,
      },
    ],
  });

  // 多余 IO 消除：没有任何 diff 命令，status 也不再收集未跟踪条目。
  const commandNames = commands.map(({ args }) => args[0]);
  assert.deepEqual(commandNames, ["rev-parse", "status", "for-each-ref"]);
  assert.ok(
    commands.every(({ args }) => args[0] !== "diff"),
    "分支列表不得执行 numstat diff",
  );
  const statusArgs = commands.find(({ args }) => args[0] === "status")?.args ?? [];
  assert.ok(statusArgs.includes("--untracked-files=no"), "分支头读取必须显式跳过未跟踪条目收集");
  assert.ok(!statusArgs.includes("--untracked-files=all"));
});

test("detached HEAD 下当前分支标注与空上游保持原行为", async () => {
  const detachedStatus = [
    "# branch.oid 1111111111111111111111111111111111111111",
    "# branch.head (detached)",
    "",
  ].join("\u0000");
  const { provider, commands } = createRecordingProvider({
    status: (options) => commandResult(options, { stdout: detachedStatus }),
    forEachRef: (options) => commandResult(options, { stdout: FOR_EACH_REF_OUTPUT }),
  });

  const repo = createGitCliRepo({ commandProvider: provider });
  const result = await repo.listLocalBranches(WORKSPACE_PATH);

  assert.equal(result.headRefType, "detached");
  assert.equal(result.currentBranchName, null);
  assert.ok(result.branches.every((branch) => !branch.isCurrent));
  assert.equal(commands.filter(({ args }) => args[0] === "diff").length, 0);
});

test("非仓库工作区只执行仓库解析并返回空分支列表", async () => {
  const { provider, commands } = createRecordingProvider({
    resolveRepository: (options) =>
      commandResult(options, {
        exitCode: 128,
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      }),
    status: (options) => commandResult(options, { stdout: BRANCH_HEAD_STATUS }),
    forEachRef: (options) => commandResult(options, { stdout: FOR_EACH_REF_OUTPUT }),
  });

  const repo = createGitCliRepo({ commandProvider: provider });
  const result = await repo.listLocalBranches(WORKSPACE_PATH);

  assert.deepEqual(result, { headRefType: "branch", currentBranchName: null, branches: [] });
  assert.deepEqual(
    commands.map(({ args }) => args[0]),
    ["rev-parse"],
  );
});
test("unborn HEAD 返回分支名与空分支列表", async () => {
  // 新仓库没有提交：分支头仍给出 branch.head，refs/heads 为空。
  // 分支字段与提交是否存在无关，列表降级为空但不能丢分支名。
  const unbornStatus = [
    "# branch.oid (initial)",
    "# branch.head main",
    "# branch.upstream",
    "# branch.ab +0 -0",
    "",
  ].join("\u0000");
  const { provider, commands } = createRecordingProvider({
    status: (options) => commandResult(options, { stdout: unbornStatus }),
    forEachRef: (options) => commandResult(options, { stdout: "" }),
  });

  const repo = createGitCliRepo({ commandProvider: provider });
  const result = await repo.listLocalBranches(WORKSPACE_PATH);

  assert.deepEqual(result, { headRefType: "branch", currentBranchName: "main", branches: [] });
  assert.deepEqual(
    commands.map(({ args }) => args[0]),
    ["rev-parse", "status", "for-each-ref"],
  );
  assert.equal(commands.filter(({ args }) => args[0] === "diff").length, 0);
});

test("Git 二进制不可用按原契约降级或原样拒绝", async () => {
  // resolveGitBinary 返回 null：仓库解析降级为非仓库，只退空列表且不执行任何命令。
  const unavailable = createRecordingProvider({
    resolveGitBinary: async () => null,
    status: (options) => commandResult(options, { stdout: BRANCH_HEAD_STATUS }),
    forEachRef: (options) => commandResult(options, { stdout: FOR_EACH_REF_OUTPUT }),
  });

  const unavailableRepo = createGitCliRepo({ commandProvider: unavailable.provider });
  assert.deepEqual(await unavailableRepo.listLocalBranches(WORKSPACE_PATH), {
    headRefType: "branch",
    currentBranchName: null,
    branches: [],
  });
  assert.deepEqual(unavailable.commands, []);

  // resolveGitBinary 抛出：错误原样向上传播，不降级成空列表吞掉调用方。
  const thrown = createRecordingProvider({
    resolveGitBinary: async () => {
      throw new Error("Git binary is not available");
    },
    status: (options) => commandResult(options, { stdout: BRANCH_HEAD_STATUS }),
    forEachRef: (options) => commandResult(options, { stdout: FOR_EACH_REF_OUTPUT }),
  });

  const thrownRepo = createGitCliRepo({ commandProvider: thrown.provider });
  await assert.rejects(thrownRepo.listLocalBranches(WORKSPACE_PATH), {
    message: "Git binary is not available",
  });
  assert.deepEqual(thrown.commands, []);
});

test("status 或 for-each-ref 失败保持拒绝", async () => {
  // 分支头读取失败：必须拒绝，不能把半成品当分支列表返回。
  const statusFailure = createRecordingProvider({
    status: (options) =>
      commandResult(options, {
        exitCode: 128,
        stderr: "fatal: unable to read the git status output",
      }),
    forEachRef: (options) => commandResult(options, { stdout: FOR_EACH_REF_OUTPUT }),
  });

  const statusFailureRepo = createGitCliRepo({ commandProvider: statusFailure.provider });
  await assert.rejects(statusFailureRepo.listLocalBranches(WORKSPACE_PATH), /git status failed/);

  // for-each-ref 失败：同样拒绝，且不提前返回未完成的分支列表。
  const refFailure = createRecordingProvider({
    status: (options) => commandResult(options, { stdout: BRANCH_HEAD_STATUS }),
    forEachRef: (options) =>
      commandResult(options, {
        exitCode: 128,
        stderr: "fatal: unable to read refs/heads",
      }),
  });

  const refFailureRepo = createGitCliRepo({ commandProvider: refFailure.provider });
  await assert.rejects(
    refFailureRepo.listLocalBranches(WORKSPACE_PATH),
    /for-each-ref refs\/heads failed/,
  );
  assert.equal(refFailure.commands.filter(({ args }) => args[0] === "diff").length, 0);
});
