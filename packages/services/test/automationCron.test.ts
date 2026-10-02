import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeAutomationScheduleRule } from "@zcode/shared";
import { computeScheduleRuleNextRunAt } from "../src/session/automationCron.js";

test("weekly schedule checks weekdays in Monday-first calendar order", () => {
  const from = new Date(2026, 9, 5, 8, 0, 0, 0).getTime();
  const rule: ZCodeAutomationScheduleRule = {
    unit: "weekly",
    interval: 1,
    hour: 9,
    minute: 0,
    weekdays: [0, 1],
    anchorAt: from,
  };

  assert.equal(
    computeScheduleRuleNextRunAt(rule, from),
    new Date(2026, 9, 5, 9, 0, 0, 0).getTime(),
  );
});
