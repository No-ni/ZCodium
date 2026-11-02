import { expect, it } from "vitest";
import { shouldReuseDesktopE2EBuild } from "./e2e/helpers/e2e-build-reuse.js";

it("only an explicit test build reuse flag reuses desktop output", () => {
  expect(shouldReuseDesktopE2EBuild({})).toBe(false);
  expect(shouldReuseDesktopE2EBuild({ ZCODE_E2E_SKIP_BUILD: "0" })).toBe(false);
  expect(shouldReuseDesktopE2EBuild({ ZCODE_E2E_SKIP_BUILD: "1" })).toBe(true);
});
