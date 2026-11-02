import assert from "node:assert/strict";
import test from "node:test";
import { disposeWorkerSelectionResources } from "../../packages/desktop/test/e2e/helpers/worker-selection-dispose.js";

test("Worker 夹具任一资源释放失败仍收尾所有资源并恢复目录", async () => {
  const names = ["syncer", "agent", "repo", "runtime", "replay"];
  for (const failing of names) {
    const seen: string[] = [];
    const failure = new Error(`synthetic-${failing}`);
    const step = (name: string) => {
      seen.push(name);
      if (name === failing) throw failure;
    };
    await assert.rejects(
      disposeWorkerSelectionResources({
        syncer: { disposeAll: () => step("syncer") },
        agent: { disposeAllAndWait: async () => step("agent") },
        repo: { close: () => step("repo") },
        runtime: { dispose: () => step("runtime") },
        replay: { stop: async () => step("replay") },
        restoreDataDir: () => seen.push("restore"),
      }),
      (error) => error === failure,
    );
    assert.deepEqual(seen, [...names, "restore"]);
  }
});

test("多个释放错误完整返回，目录恢复仍执行一次", async () => {
  const failures = [new Error("synthetic-repo"), new Error("synthetic-replay")];
  let restored = 0;
  await assert.rejects(
    disposeWorkerSelectionResources({
      repo: {
        close: () => {
          throw failures[0];
        },
      },
      replay: {
        stop: async () => {
          throw failures[1];
        },
      },
      restoreDataDir: () => {
        restored += 1;
      },
    }),
    (error) =>
      error instanceof AggregateError && error.errors.every((item, i) => item === failures[i]),
  );
  assert.equal(restored, 1);
});
