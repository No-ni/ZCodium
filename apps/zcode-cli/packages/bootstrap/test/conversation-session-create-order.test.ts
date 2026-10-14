import assert from "node:assert/strict";
import { it } from "node:test";
import { runConversationSessionCreation } from "../src/app/conversation-session-create-order.js";

it("holds creation ownership through registration and releases failures without blocking another owner", async () => {
  const owner = {};
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const first = runConversationSessionCreation(owner, async () => {
    events.push("first-directory");
    entered.resolve();
    await release.promise;
    events.push("first-registered");
    throw new Error("fixture-create-failure");
  });
  const second = runConversationSessionCreation(owner, async () => events.push("second-directory"));
  const outcomes = Promise.allSettled([first, second]);
  await entered.promise;
  await runConversationSessionCreation({}, async () => events.push("other-owner"));
  assert.deepEqual(events, ["first-directory", "other-owner"]);
  release.resolve();
  const result = await outcomes;
  assert.equal(result[0]!.status, "rejected");
  assert.equal(result[1]!.status, "fulfilled");
  assert.deepEqual(events, [
    "first-directory",
    "other-owner",
    "first-registered",
    "second-directory",
  ]);
  assert.equal(
    await runConversationSessionCreation(owner, async () => "after-failure"),
    "after-failure",
  );
});
