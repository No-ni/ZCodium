import { prepareWebRemoteControlSessionEventsFixture } from "./web-remote-control-session-events-fixture.js";

const MOBILE_SESSION_SPECS = new Set([
  "conversation-session-virtual-project-mobile.test.ts",
  "conversation-session-composer-settlement.test.ts",
  "conversation-session-switch-stability.test.ts",
  "conversation-session-new-task-missing-root-mobile.test.ts",
  "command-center-history-search.test.ts",
  "conversation-session-web-remote-terminal.test.ts",
  "conversation-session-runtime-restart.test.ts",
  "conversation-session-shared-cli.test.ts",
  "conversation-session-r3-mobile.test.ts",
  "conversation-session-r3-mobile-permission.test.ts",
  "conversation-session-r3-soak-dual.test.ts",
  "conversation-session-web-remote-project-directory.test.ts",
  "conversation-session-web-remote-recovery.test.ts",
  "conversation-session-web-remote-unread.test.ts",
  "conversation-session-workspace-mcp-trust.test.ts",
  "conversation-session-id-compatibility.test.ts",
  "conversation-session-gen-ui-context.test.ts",
]);

/** 仅为现存手机会话用例准备匿名配对，不装配已退休的官方登录或推送分支。 */
export async function prepareWebRemoteControlSessionFixture(options: {
  specs: string[];
  credentialsFile: string;
  settingsFile: string;
  workspacePath: string;
  webUrl?: string;
}): Promise<(() => Promise<void>) | null> {
  const selected = options.specs.some((spec) =>
    MOBILE_SESSION_SPECS.has(spec.replaceAll("\\", "/").split("/").pop()!),
  );
  if (!selected) return null;
  return prepareWebRemoteControlSessionEventsFixture(options);
}
