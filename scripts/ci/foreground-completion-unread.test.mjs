import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("前台完成离开补写的判定回归用例可执行", async () => {
  const { tests } = await runSourceTests([
    "packages/ui/test/foregroundCompletionPlan.test.ts",
  ]);
  assert.equal(tests, 4);
});

test("flushOnLeave 走统一补写计划，并对每条记录复核是否仍在面前", async () => {
  const hook = await read("packages/ui/src/project-sidebar/useProjectUnreadSignals.ts");
  assert.match(
    hook,
    /const plan = planForegroundCompletionFlush\(foregroundCompletions, \(target\) =>\s*\n\s*isDesktopViewing\(target\) \|\| isRemoteViewing\(target\),/,
    "补写前必须带上查看状态校验",
  );
  assert.match(
    hook,
    /for \(const key of plan\.drop\) foregroundCompletions\.delete\(key\);/,
    "已导航离开的记录必须在离开事件里作废",
  );
  // 旧缺陷：不校验查看状态、无条件遍历所有未补写记录。
  assert.doesNotMatch(
    hook,
    /for \(const \[key, entry\] of foregroundCompletions\)/,
    "不允许绕过补写计划直接遍历补写",
  );
});

test("未读 spec 记录补写前的查看状态复核", async () => {
  const doc = await read("docs/ui/task-unread-state.md");
  assert.match(doc, /补写前必须\s*\n?\s*重新确认离开这一刻该任务仍在面前/);
  assert.match(doc, /新开会话[\s\S]{0,40}作废|直接作废/);
});
