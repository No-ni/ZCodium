import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { resolveEffectiveBashShellSelection } from "@zcode/adapters/exec";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import { createSessionId, type MessageWithParts, type SessionId } from "@zcode/contracts";
import { resolveDynamicWorkflowClientConfig } from "@zcode/shared";
import { getGenUiOutputDirectory } from "@zcode/shared/node";
import { assertProjectPath } from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { messages as readCanonicalMessages } from "../../adapters/src/storage/session-store/repositories/messages.js";
import { createSqliteNativeContextRepository } from "../../adapters/src/storage/session-store/native-context-compression/repository.js";
import { resolveBundledSkillRoots } from "../../bootstrap/src/app/bundled-skills.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "../../bootstrap/src/app/dynamic-workflow-gate.js";
import { getCliStorageRoot } from "../../bootstrap/src/app/paths.js";
import { resolveZCodePlugins } from "../../bootstrap/src/plugins.js";
import { collectDisabledPaths } from "../../bootstrap/src/skill-command-overrides.js";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { ContextBuilder } from "../src/context/builder.js";
import type { ContextBuilderConfig } from "../src/context/types.js";
import { buildContextHistoryEntries } from "../src/runtime/methods/context-history-entries.js";
import {
  buildShellEnvironmentResumeNotice,
  getShellEnvironmentResumeNoticeKind,
} from "../src/runtime/methods/shell-environment.js";
import {
  historyVersionOf,
  nativeHash,
} from "../src/runtime/native-context-compression/identity.js";
import type { NativeContextLedgerManifest } from "../../../../../packages/desktop/test/e2e/helpers/native-context-compression/ledger-fixture-contract.js";

export interface NativeContextLedgerHostPreferences {
  memoryEnabled: false;
  integratedTerminalShell?: { mode: "auto" };
  dynamicWorkflowMode?: "disabled" | "onDemand" | "alwaysOn";
}

/** 只复用当前版本的只读 repository；readOnly SQLite 连接不能补 migration 或改 seed。 */
export async function readNativeContextLedgerSnapshot(dbPath: string, sessionId: SessionId) {
  const db = new DatabaseSync(await assertProjectPath(dbPath), { readOnly: true });
  try {
    const messages = readCanonicalMessages(db, { sessionID: sessionId });
    const bundle = createSqliteNativeContextRepository(db).getForkBundle(sessionId);
    assert.ok(bundle, "NCTX-58 native seed bundle is absent");
    const physical = (
      table: "message" | "part" | "native_context_operation" | "native_context_observation",
    ) => db.prepare(`select * from ${table} where session_id=? order by rowid`).all(sessionId);
    return {
      messages,
      bundle,
      facts: {
        canonicalSha256: nativeHash(
          JSON.stringify({ messages: physical("message"), parts: physical("part") }),
        ),
        sourcesSha256: nativeHash(JSON.stringify(bundle.state.sources)),
        kernelSha256: nativeHash(JSON.stringify(bundle.state.kernel)),
        imageReceiptsSha256: nativeHash(JSON.stringify(bundle.state.imageReceipts)),
        observationsSha256: nativeHash(JSON.stringify(physical("native_context_observation"))),
        operationsSha256: nativeHash(JSON.stringify(physical("native_context_operation"))),
      },
    };
  } finally {
    db.close();
  }
}

/** 与实际 Host resume 独立的输入 recipe；不读取 Runtime status 或已恢复 native state。 */
export async function createNativeContextLedgerResumeRecipe(input: {
  homeDir: string;
  workspacePath: string;
  sessionId: string;
  hostPreferences: NativeContextLedgerHostPreferences;
  env?: NodeJS.ProcessEnv;
}) {
  assert.equal(input.hostPreferences.memoryEnabled, false);
  assert.ok(
    !input.hostPreferences.integratedTerminalShell ||
      input.hostPreferences.integratedTerminalShell.mode === "auto",
  );
  const env = input.env ?? process.env;
  const configResult = createConfig({ env, workingDirectory: input.workspacePath });
  const plugins = resolveZCodePlugins({ configResult, env, workingDirectory: input.workspacePath });
  const bundledRoots = await resolveBundledSkillRoots({
    cliStorageRoot: getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
  });
  const dynamicWorkflow = resolveDynamicWorkflowClientConfig({
    remote: undefined,
    env,
    userMode: input.hostPreferences.dynamicWorkflowMode,
  });
  const skillEnabled = configResult.config.features.skill && configResult.config.skills.enabled;
  const skillPort = skillEnabled
    ? createNodeSkillAdapter({
        extraRoots: configResult.config.skills.roots,
        extraResolvedRoots: [...plugins.skillRoots, ...bundledRoots],
        disabledPaths: [
          ...collectDisabledPaths(configResult.config.skillOverrides),
          ...(!dynamicWorkflow.enabled
            ? collectDynamicWorkflowDisabledSkillPaths(bundledRoots)
            : []),
        ],
      })
    : undefined;
  const skills = await skillPort?.discoverSkills({ workingDirectory: input.workspacePath });
  const shellSelection = resolveEffectiveBashShellSelection({
    env,
    platform: process.platform,
  }).selection;
  // Host 会覆盖进程继承的 Gen UI 根；不能拿 sandbox 通用 visualizations 根作为 expected。
  const genUiOutputRoot = await assertProjectPath(
    join(input.homeDir, ".zcodium", "v2", "visualizations"),
  );
  const contextConfig: ContextBuilderConfig = {
    workingDirectory: input.workspacePath,
    envInfo: {
      cwd: input.workspacePath,
      platform: process.platform,
      shell: shellSelection.display.name,
      osVersion: "synthetic",
      nodeVersion: process.version,
      isGitRepository: false,
    },
    presentationSurface: "zcode_desktop",
    genUiOutputDirectory: getGenUiOutputDirectory(genUiOutputRoot, {
      workspacePath: input.workspacePath,
      sessionId: input.sessionId,
    }),
    skills,
    guidanceToolNames: skillEnabled ? ["Skill"] : [],
  };
  const noticeKind = getShellEnvironmentResumeNoticeKind({
    persistedShell: undefined,
    restoreStatus: "missing",
    selection: shellSelection,
  });
  return {
    contextConfig,
    skillPort,
    shellSelection,
    genUiOutputRoot,
    dynamicWorkflow,
    shellNotice: noticeKind ? buildShellEnvironmentResumeNotice(noticeKind, shellSelection) : null,
  };
}

export async function calculateNativeContextLedgerResumeExpected(
  messages: MessageWithParts[],
  recipe: Awaited<ReturnType<typeof createNativeContextLedgerResumeRecipe>>,
) {
  const result = new ContextBuilder(recipe.contextConfig).build();
  const history = new MessageHistoryImpl();
  history.addEntries(buildContextHistoryEntries(result));
  await hydrateMessageHistoryFromSession({ history, messages });
  if (recipe.shellNotice) history.addAttachment("shell_environment_change", recipe.shellNotice);
  return {
    revision: 1 as const,
    generation: 0 as const,
    policyVersion: 0 as const,
    currentSegmentId: "initial" as const,
    historyVersion: historyVersionOf(history.borrowReadOnlyRuntimeEntries()),
    systemMessageSha256: result.systemMessages.map((message) =>
      nativeHash(JSON.stringify(message)),
    ),
    shellNoticeSha256: recipe.shellNotice ? nativeHash(recipe.shellNotice) : null,
    shellDialect: recipe.shellSelection.dialect,
    shellSource: recipe.shellSelection.source,
    skillGuidance: Boolean(recipe.skillPort && recipe.contextConfig.skills?.skills.length),
  };
}

export async function verifyNativeContextLedgerSnapshot(
  manifest: NativeContextLedgerManifest,
  phase: "seed" | "resume",
) {
  const sessionId = createSessionId(manifest.namespace);
  assert.equal(sessionId, manifest.sessionId);
  const snapshot = await readNativeContextLedgerSnapshot(manifest.dbPath, sessionId);
  const state = snapshot.bundle.state;
  const version = {
    revision: state.revision,
    generation: state.generation,
    historyVersion: state.historyVersion,
    policyVersion: state.policy.policyVersion,
    currentSegmentId: state.compactBoundaryId,
  };
  const expected = phase === "seed" ? { ...manifest, policyVersion: 0 } : manifest.resumeExpected;
  assert.deepEqual(version, {
    revision: expected.revision,
    generation: expected.generation,
    historyVersion: expected.historyVersion,
    policyVersion: expected.policyVersion,
    currentSegmentId: expected.currentSegmentId,
  });
  assert.deepEqual(
    snapshot.facts,
    manifest.seedFacts,
    "NCTX-58 canonical, source, view and every physical ledger row must remain exactly as seeded",
  );
  const counts = {
    messages: snapshot.messages.length,
    sources: state.sources.length,
    observations: snapshot.bundle.observations.length,
    operations: snapshot.bundle.operations.length,
    requestSeq: state.requestSeq,
  };
  assert.deepEqual(counts, {
    messages: 5940,
    sources: 5940,
    observations: 3000,
    operations: 15,
    requestSeq: 2970,
  });
  return { phase, version, facts: snapshot.facts, counts };
}
