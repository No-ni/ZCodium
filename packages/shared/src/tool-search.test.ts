import { describe, expect, it } from "vitest";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";
import { appRuntimePreferencesChangedBroadcastPayloadSchema } from "./app-runtime-preferences.js";
import { appToolSearchModeSchema } from "./tool-search.js";
import {
  zcodeInteractionPreferencesSchema,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
} from "./zcode-protocol/index.js";
import { toolCallDisplaySchema, toolOutputSchema } from "./zcode-protocol-v4/toolDisplay.js";

const display = {
  kind: "tool_search",
  query: "select:Read",
  matches: ["Read"],
  totalMatches: 1,
  totalDeferredTools: 4,
} as const;

describe("ToolSearch public preference contract", () => {
  it("keeps old settings and runtime responses off", () => {
    expect(appSettingsSchema.parse({}).toolSearchMode).toBe("off");
    expect(
      appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
        askUserQuestionAutoResolutionEnabled: true,
      }).toolSearchMode,
    ).toBe("off");
    expect(
      zcodeSessionRuntimePreferencesResultSchema.parse({
        nativeSearchEnhancementsEnabled: true,
      }).toolSearchMode,
    ).toBe("off");
    expect(
      zcodeInteractionPreferencesSchema.parse({
        askUserQuestionAutoResolutionEnabled: true,
      }).toolSearchMode,
    ).toBe("off");
    expect(
      zcodeWorkspaceUpdateInteractionPreferencesResultSchema.parse({
        workspace: { workspaceKey: "/fixture", workspacePath: "/fixture" },
        askUserQuestionAutoResolutionEnabled: true,
        snoozedInteractionCount: 0,
      }).toolSearchMode,
    ).toBe("off");
  });
  it("round trips each supported setting without enabling native", () => {
    for (const toolSearchMode of ["auto", "local", "off"] as const) {
      expect(appToolSearchModeSchema.parse(toolSearchMode)).toBe(toolSearchMode);
      expect(appSettingsSchema.parse({ toolSearchMode }).toolSearchMode).toBe(toolSearchMode);
      expect(appSettingsPatchSchema.parse({ toolSearchMode }).toolSearchMode).toBe(toolSearchMode);
    }
    for (const toolSearchMode of ["native", "AUTO", true, null]) {
      expect(appToolSearchModeSchema.safeParse(toolSearchMode).success).toBe(false);
      expect(appSettingsPatchSchema.safeParse({ toolSearchMode }).success).toBe(false);
    }
    expect(appSettingsPatchSchema.parse({})).not.toHaveProperty("toolSearchMode");
  });
});

describe("ToolSearch authoritative display contract", () => {
  it("preserves the same read-only display in toolCall and toolOutput", () => {
    expect(toolCallDisplaySchema.parse(display)).toEqual(display);
    expect(toolOutputSchema.parse({ text: "result", display }).display).toEqual(display);
  });
  it("validates UTF-8 bytes and bounded names independently of discovery", () => {
    expect(toolCallDisplaySchema.safeParse({ ...display, query: "界".repeat(1365) }).success).toBe(
      true,
    );
    expect(toolCallDisplaySchema.safeParse({ ...display, query: "界".repeat(1366) }).success).toBe(
      false,
    );
    expect(
      toolCallDisplaySchema.safeParse({ ...display, matches: ["界".repeat(170)] }).success,
    ).toBe(true);
    expect(
      toolCallDisplaySchema.safeParse({ ...display, matches: ["界".repeat(171)] }).success,
    ).toBe(false);
    expect(
      toolCallDisplaySchema.safeParse({
        ...display,
        matches: Array.from({ length: 101 }, () => "Read"),
      }).success,
    ).toBe(false);
  });
  it("rejects unknown display fields and degrades only the bad card", () => {
    const invalid = { ...display, permissionGranted: true };
    expect(toolCallDisplaySchema.safeParse(invalid).success).toBe(false);
    expect(toolOutputSchema.parse({ text: "kept", display: invalid })).toEqual({
      text: "kept",
      display: undefined,
    });
  });
});
