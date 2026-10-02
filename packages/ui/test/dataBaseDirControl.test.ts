import assert from "node:assert/strict";
import test from "node:test";
import { shouldSyncDataBaseDirDraft } from "../src/settings/dataBaseDirControlState.js";

test("browse state changes do not replace a new draft with the effective directory", () => {
  assert.equal(shouldSyncDataBaseDirDraft("/data", "/data", "idle"), false);
  assert.equal(shouldSyncDataBaseDirDraft("/data", "/data", "error"), false);
  assert.equal(shouldSyncDataBaseDirDraft("/data", "/data-new", "idle"), true);
  assert.equal(shouldSyncDataBaseDirDraft("/data", "/data", "saved"), true);
});
