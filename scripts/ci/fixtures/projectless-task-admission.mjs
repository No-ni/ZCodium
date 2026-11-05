import { randomUUID } from "node:crypto";
import {
  acceptComposerRecentReceipt,
  prepareComposerRecentReceipt,
} from "../../../packages/ui/src/lib/composerRecent.ts";
import * as drafts from "../../../packages/ui/src/v4/composer/composerDraftStore.ts";
import { PendingCommandRegistry } from "../../../packages/ui/src/v4/pendingCommandRegistry.ts";
import { parseV4VisibleSlashCommand } from "../../../packages/ui/src/v4/slashCommands.ts";
import { loadComponentCallback } from "./component-callback.mjs";

// 仅替代运行时、配置屏障和导航端口，发送、回执及草稿交接使用当前生产源码。
export async function createProjectlessAdmission({
  workspacePath,
  workspaceState = () => ({ draftProjectId: null }),
  prewarm = true,
  barrier = { enqueue: (action) => action() },
  sendCommand,
  selection,
  isProviderNotReadyError = () => false,
}) {
  const registry = new PendingCommandRegistry({ storage: window.localStorage });
  const envelopes = [];
  const created = [];
  const binding = {
    sessionId: "fixture-prewarm-session",
    beginPromotion: () => true,
    promote() {},
  };
  const context = {
    ...drafts,
    sessionId: null,
    workspacePath,
    workspaceKey: workspacePath,
    workspaceIdentity: undefined,
    clientNamespace: "desktop",
    rootSessionId: undefined,
    selectionSideChat: false,
    lease: null,
    useZCodeSessionStore: { getState: () => ({ getWorkspaceState: workspaceState }) },
    baseWorkspaceServices: {},
    prepareComposerRecentReceipt,
    acceptComposerRecentReceipt,
    readGenUiModelContext: async () => "",
    captureAcceptedModelSelection: () => () => {},
    createCommandEnvelope: (params) => ({
      ...params,
      commandId: randomUUID(),
      clientId: "fixture-client",
      issuedAt: Date.now(),
    }),
    pendingCommandRegistry: registry,
    measureOperation: (_kind, action) => action(),
    sendCommand: async (envelope) => {
      envelopes.push(envelope);
      return sendCommand
        ? sendCommand(envelope, registry)
        : {
            commandId: envelope.commandId,
            status: "accepted",
            ...(envelope.type === "createSession"
              ? { result: { type: "createSession", sessionId: "fixture-created-session" } }
              : {}),
          };
    },
    handleDraftSessionCreated: async (sessionId) => created.push(sessionId),
    recordV4CommandAck() {},
    shouldResyncForStaleAuthority: () => false,
    isProviderNotReadyError,
    logger: { warn() {} },
    intl: { formatMessage: ({ id }) => id },
    toast() {},
    snapshotRef: { current: { inputRouting: { mode: "startNow" } } },
    prewarmBindingRef: { current: prewarm ? binding : null },
    ensureDraftPrewarmConfigBeforeSendRef: { current: async () => {} },
    ensureDraftModelReadyForSend: async () => true,
    draftConfigRef: { current: {} },
    appFollowupMode: undefined,
    appSlashCommands: [],
    availableSelectionSideSlashCommandNames: [],
    parseV4VisibleSlashCommand,
    configCommandBarrier: barrier,
    createSubmissionFromComposer: () => ({
      modelSelection: selection,
      mode: "guarded",
      planEnabled: false,
    }),
    settleCurrentQueueInputs() {},
    markDraftProviderNotReady() {},
  };
  const source = "packages/ui/src/v4/SessionPane.tsx";
  context.submissionConfigFromCommand = await loadComponentCallback(
    source,
    "submissionConfigFromCommand",
    {},
  );
  context.buildDraftCreateConfigPayload = await loadComponentCallback(
    "packages/ui/src/v4/composer/useDraftConfigControl.ts",
    "buildDraftCreateConfigPayload",
    {},
  );
  context.dispatchCommand = await loadComponentCallback(source, "dispatchCommand", context);
  context.dispatchSlashCommand = await loadComponentCallback(
    source,
    "dispatchSlashCommand",
    context,
  );
  context.dispatchSendTextAfterConfig = await loadComponentCallback(
    source,
    "dispatchSendTextAfterConfig",
    context,
  );
  const send = await loadComponentCallback(source, "dispatchSendText", context);
  return { send, registry, envelopes, created };
}
