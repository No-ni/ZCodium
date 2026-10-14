import { describe, expect, it } from "vitest";
import type { SessionDataLayer, SessionLease } from "./sessionDataLayer.js";
import { resolvePaneFileSearchRoot } from "./sessionWorkspacePath.js";
import { resolvePaneSessionProjectionLease } from "./useConversationProjection.js";

const workspacePath = "/conversation";
const snapshot = { sessionId: "same-id", workspacePath: "/conversation/2026-10-14/12345678" };
const layer = {} as SessionDataLayer;
const lease = {
  sessionId: snapshot.sessionId,
  store: { getState: () => ({ snapshot }) },
} as SessionLease;
const binding = { lease, layer, draftInvalidationVersion: 1 };

describe("pane projection source before lease effects commit", () => {
  it("rejects another workspace/Host layer even when the target session has the same id", () => {
    const currentLease = resolvePaneSessionProjectionLease(binding, {} as SessionDataLayer);
    expect(currentLease).toBeNull();
    expect(
      resolvePaneFileSearchRoot({
        snapshot: currentLease?.store.getState().snapshot ?? null,
        sessionId: snapshot.sessionId,
        prewarmSessionId: null,
        tabWorkspacePath: workspacePath,
      }),
    ).toEqual({ rootPath: workspacePath, resolved: false });
    expect(resolvePaneSessionProjectionLease(binding, layer)).toBe(lease);
  });

  it("rejects a retired prewarm generation before its mirrored session id clears", () => {
    const currentLease = resolvePaneSessionProjectionLease(binding, layer, 2);
    expect(currentLease).toBeNull();
    expect(
      resolvePaneFileSearchRoot({
        snapshot: currentLease?.store.getState().snapshot ?? null,
        sessionId: null,
        prewarmSessionId: snapshot.sessionId,
        tabWorkspacePath: workspacePath,
      }),
    ).toEqual({ rootPath: workspacePath, resolved: false });
    expect(resolvePaneSessionProjectionLease(binding, layer, 1)).toBe(lease);
    // 正式会话不再归草稿失效代管理；草稿转正仍复用原 lease 与目录。
    expect(resolvePaneSessionProjectionLease(binding, layer)).toBe(lease);
    expect(resolvePaneSessionProjectionLease(null, layer, 2)).toBeNull();
  });
});
