import assert from "node:assert/strict";
import test from "node:test";
import {
  planForegroundCompletionFlush,
  type ForegroundCompletionRecord,
} from "../src/project-sidebar/foregroundCompletionPlan.js";

const record = (
  taskId: string,
  written = false,
): ForegroundCompletionRecord<{ taskId: string }> => ({ target: { taskId }, written });

test("仍在面前的前台完成才补写未读", () => {
  const plan = planForegroundCompletionFlush(
    [["a", record("a")]],
    () => true,
  );
  assert.deepEqual(
    plan.flush.map(([key]) => key),
    ["a"],
  );
  assert.deepEqual(plan.drop, []);
});

test("用户已导航离开的未补写记录直接作废，不再点亮未读", () => {
  // 回归：前台看着任务完成 → 窗口内新开会话 → 之后失焦/回窗口
  // 旧实现会把早已离开的任务补写成未读，且自动清除只对仍在面前的任务生效。
  const plan = planForegroundCompletionFlush(
    [["a", record("a")]],
    () => false,
  );
  assert.deepEqual(plan.flush, []);
  assert.deepEqual(plan.drop, ["a"]);
});

test("逐记录判定查看状态，同 workspace 的另一任务在前台不算仍在面前", () => {
  const viewing = new Set(["b"]);
  const plan = planForegroundCompletionFlush(
    [
      ["a", record("a")],
      ["b", record("b")],
    ],
    (target) => viewing.has(target.taskId),
  );
  assert.deepEqual(
    plan.flush.map(([key]) => key),
    ["b"],
  );
  assert.deepEqual(plan.drop, ["a"]);
});

test("已补写记录不参与补写或作废，仍交给回窗口的 CAS 清除", () => {
  const plan = planForegroundCompletionFlush(
    [
      ["a", record("a", true)],
      ["b", record("b", true)],
    ],
    () => false,
  );
  assert.deepEqual(plan.flush, []);
  assert.deepEqual(plan.drop, []);
});
