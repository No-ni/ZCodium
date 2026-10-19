import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMobileAppStaticHandler } from "./mobileAppAssets.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-mobile-assets-"));
  await writeFile(join(root, "mobile.html"), "mobile fixture");
  vi.stubEnv("ZCODE_WEB_REMOTE_MOBILE_DIR", root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("mobile static request validation", () => {
  it.each(["/%", "/%E0%A4%A", "/%FF"])("损坏编码 %s 返回 400，后续请求仍正常", async (path) => {
    const handle = createMobileAppStaticHandler({ logger: { info() {}, warn() {}, error() {} } });
    await expect(handle(path)).resolves.toMatchObject({ status: 400 });
    const valid = await handle("/");
    expect(valid.status).toBe(200);
    expect(String(valid.body)).toBe("mobile fixture");
    expect((await handle("/remote/task/example")).status).toBe(200);
  });
});
