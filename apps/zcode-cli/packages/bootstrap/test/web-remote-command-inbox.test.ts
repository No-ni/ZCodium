import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationInputIntentSchema,
  parseCommandEnvelope,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";

const sessionId = "mobile-command-inbox-test";
const revision = 7;

function makeInbox(): CommandInbox {
  return new CommandInbox({
    getRevision: (candidate) => (candidate === sessionId ? revision : null),
    getLogEpoch: (candidate) => (candidate === sessionId ? "epoch-1" : null),
    now: () => 1_000,
  });
}

function sendTextEnvelope(commandId: string): CommandEnvelope {
  const parsed = parseCommandEnvelope({
    commandId,
    clientId: "mobile-test-client",
    sessionId,
    baseRevision: revision,
    baseLogEpoch: "epoch-1",
    type: "sendText",
    payload: { text: `message ${commandId}` },
    issuedAt: 0,
  });
  assert.ok(parsed.ok, "fixture is a valid V4 sendText envelope");
  return parsed.envelope;
}

function assertExecute(outcome: Awaited<ReturnType<CommandInbox["handle"]>>) {
  assert.ok(outcome.kind === "execute");
  return outcome;
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("same command retry waits for settle and returns duplicate without a second execution", async () => {
  const inbox = makeInbox();
  const envelope = sendTextEnvelope("mobile-command-1");
  const first = assertExecute(await inbox.handle(envelope));
  let executeCount = 1;
  let retryResolved = false;
  const retryPromise = inbox.handle(envelope).then((outcome) => {
    if (outcome.kind === "execute") executeCount += 1;
    retryResolved = true;
    return outcome;
  });

  await nextEventLoopTurn();
  assert.equal(retryResolved, false, "same-key retry waits for the first command's final ACK");

  first.settle({ status: "accepted" });
  const retry = await retryPromise;
  assert.equal(retry.kind, "ack");
  if (retry.kind !== "ack") assert.fail("retry must not request another execution");
  assert.equal(retry.ack.status, "duplicate");
  assert.equal(retry.ack.revisionAtDecision, revision);
  assert.equal(executeCount, 1);
});

test("different commands in one session are admitted in settle order", async () => {
  const inbox = makeInbox();
  const first = assertExecute(await inbox.handle(sendTextEnvelope("mobile-command-1")));
  let secondResolved = false;
  const secondPromise = inbox.handle(sendTextEnvelope("mobile-command-2")).then((outcome) => {
    secondResolved = true;
    return outcome;
  });

  await nextEventLoopTurn();
  assert.equal(secondResolved, false, "second command waits for the session admission gate");

  first.settle({ status: "accepted" });
  const second = assertExecute(await secondPromise);
  assert.equal(second.admissionSeq, first.admissionSeq + 1);
  second.settle({ status: "accepted" });
});

test("query returns the settled ACK while the live input remains pinned", async () => {
  const inbox = makeInbox();
  const envelope = sendTextEnvelope("mobile-command-live");
  const outcome = assertExecute(await inbox.handle(envelope));
  const intent = conversationInputIntentSchema.parse({
    sourceCommandId: envelope.commandId,
    queueItemId: outcome.queueItemId,
    clientId: envelope.clientId,
    kind: "sendText",
    text: "message mobile-command-live",
    attachments: [],
    delivery: { requested: "queue", admitted: "queue" },
    order: { admissionSeq: outcome.admissionSeq, queuePosition: 0 },
    steer: { state: "notRequested" },
    dispatch: { state: "admitted" },
    admittedAt: outcome.admittedAt,
  });
  inbox.pinLiveInput(sessionId, intent);
  outcome.settle({ status: "accepted" });

  assert.equal(inbox.hasPinnedSessionState(sessionId), true);
  const [result] = await inbox.query([{ sessionId, commandId: envelope.commandId }]);
  assert.deepEqual(result, {
    key: { sessionId, commandId: envelope.commandId },
    result: {
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: revision,
    },
  });
});
