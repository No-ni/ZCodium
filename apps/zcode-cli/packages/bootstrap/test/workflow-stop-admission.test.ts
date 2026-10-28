import assert from "node:assert/strict";
import test from "node:test";
import { ModelErrorCode, ModelFailureReason } from "@zcode/contracts";
import { getWorkflowConcurrencyGovernor } from "../src/app/workflow-concurrency-governor.js";

function failure(providerErrorCode: string, reason = ModelFailureReason.RateLimited) {
  return {
    type: "model_request_failed" as const,
    reason,
    errorCode: ModelErrorCode.ModelRequestFailed,
    providerErrorCode,
    retryable: false,
    retryAfterMs: 3_600_000,
    attempt: 1,
    maxAttempts: 1,
    timestamp: new Date().toISOString(),
    requestId: "fixture-request",
    providerId: "fixture-provider",
    modelId: "fixture-model",
    message: "fixture failure",
  };
}

test("quota Stop settles the attempt without freezing a recovered workflow", () => {
  const governor = getWorkflowConcurrencyGovernor();
  const key = "fixture-quota/model";
  const ticket = governor.tryAdmit("fixture-run", key)!;
  const before = governor.snapshot(key)!;
  assert.ok(ticket);
  ticket.publish(failure("1308") as never);
  ticket.release();
  const after = governor.snapshot(key)!;
  assert.equal(after.cooldownUntil, undefined);
  assert.equal(after.cap, before.cap);
  const recovered = governor.tryAdmit("fixture-resumed-run", key);
  assert.ok(recovered);
  recovered.release();
});

test("real concurrency rejection still reduces capacity and respects Retry-After", () => {
  const governor = getWorkflowConcurrencyGovernor();
  const key = "fixture-concurrency/model";
  const ticket = governor.tryAdmit("fixture-run", key)!;
  const before = governor.snapshot(key)!;
  ticket.publish(failure("3008") as never);
  const after = governor.snapshot(key)!;
  assert.ok(after.cap < before.cap || before.cap === 1);
  assert.ok(after.cooldownUntil! > Date.now());
  assert.equal(governor.tryAdmit("fixture-next", key), undefined);
  ticket.release();
  assert.deepEqual(governor.snapshot(key), after);
});

test("authentication Stop ignores Retry-After and repeated ticket events", () => {
  const governor = getWorkflowConcurrencyGovernor();
  const key = "fixture-auth/model";
  const ticket = governor.tryAdmit("fixture-run", key)!;
  ticket.publish(failure("invalid_api_key", ModelFailureReason.AuthFailed) as never);
  ticket.publish(failure("3008") as never);
  ticket.release();
  assert.equal(governor.snapshot(key)!.cooldownUntil, undefined);
  const next = governor.tryAdmit("fixture-next", key);
  assert.ok(next);
  next.release();
});
