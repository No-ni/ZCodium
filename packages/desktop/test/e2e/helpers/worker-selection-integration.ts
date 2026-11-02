import type { ProjectRepositoryContract } from "../../../../services/src/project-storage/contract.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelSelectionViewInput } from "@zcode/provider";
import { NodeProviderRegistryRuntime, createNodeModelSelectionFacade } from "@zcode/provider-node";
import {
  createZCodeAgentService,
  createZCodeTaskServiceAdapter,
  getDataBaseDir,
  setDataBaseDir,
} from "@zcode/services/node";
import { TaskIndexRepo } from "../../../../services/src/session/taskIndexRepo.js";
import { createZCodeTaskIndexSyncer } from "../../../../services/src/zcode-agent/zcodeTaskIndexSyncer.js";
import { assertProjectPath } from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { getE2EAppDataPaths } from "./desktop-app.js";
import {
  seedPersonalDefaultModelSelection,
  seedPersonalProviderConfig,
} from "./model-provider-restart-config.js";
import { startUpstreamReplayServer } from "./upstream-replay-server.js";
import type { E2ENetworkCaptureArtifact } from "./network-capture-proxy.js";
import { disposeWorkerSelectionResources } from "./worker-selection-dispose.js";

/** 独立测试 Host + 真实 stdio Worker；模型 HTTP 只访问本轮 loopback 回放。 */
export async function createWorkerSelectionIntegration(
  directory = "worker-selection-host",
  options: {
    workspacePath?: string;
    cliNodeArgs?: string[];
    cliEntrypoint?: string;
    processLifecycleReporter?: NonNullable<
      Parameters<typeof createZCodeAgentService>[0]
    >["processLifecycleReporter"];
  } = {},
) {
  const home = await assertProjectPath(resolve(getE2EAppDataPaths().homeDir, directory));
  const workspacePath = await assertProjectPath(
    resolve(options.workspacePath ?? join(home, "workspace")),
  );
  const root = resolve(import.meta.dirname, "../../../../..");
  const cliEntrypoint = await assertProjectPath(
    resolve(options.cliEntrypoint ?? join(root, "apps/zcode-cli/packages/cli/dist/zcode.cjs")),
  );
  const temp = await assertProjectPath(join(home, "temp"));
  await mkdir(temp, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  const personalFilePath = await assertProjectPath(join(home, ".zcodium/v2/provider_config.json"));
  const cliRoot = await assertProjectPath(join(home, ".zcodium/cli"));
  await mkdir(cliRoot, { recursive: true });
  // 本 fork 没有账号 Registry。只播种正式 BYOK 文件，不模拟 Individual/Team 权益交付。
  const modelSelection = {
    providerId: "worker-local-byok",
    modelId: "GLM-5.3-Flash",
    options: { reasoningLevel: "high" },
  };
  const replay = await startUpstreamReplayServer({
    artifactPath: await assertProjectPath(join(home, "worker-provider-requests.json")),
    fixturePaths: [
      join(
        root,
        "packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-worker-byok.json",
      ),
      join(
        root,
        "packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-id-compatibility.json",
      ),
    ],
  });
  const previousDataDir = getDataBaseDir();
  let runtime: NodeProviderRegistryRuntime | undefined;
  let repo: TaskIndexRepo | undefined;
  let agent: ReturnType<typeof createZCodeAgentService> | undefined;
  let syncer: ReturnType<typeof createZCodeTaskIndexSyncer> | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= disposeWorkerSelectionResources({
      syncer,
      agent,
      repo,
      runtime,
      replay,
      restoreDataDir: () => setDataBaseDir(previousDataDir),
    }));
  try {
    await seedPersonalProviderConfig(personalFilePath, {
      id: modelSelection.providerId,
      label: "Worker Local BYOK",
      apiFormat: "anthropic-messages",
      apiKey: "synthetic-loopback-key",
      baseURL: `${replay.baseUrl}/anthropic`,
      models: [
        {
          id: modelSelection.modelId,
          reasoningLevel: {
            values: ["max", "high", "low"],
            map: '{"output_config":{"effort":reasoningLevel}}',
          },
        },
      ],
    });
    await seedPersonalDefaultModelSelection(personalFilePath, modelSelection);
    await writeFile(
      join(cliRoot, "config.json"),
      JSON.stringify({ network: { noProxy: "localhost,127.0.0.1,::1" } }),
    );
    setDataBaseDir(home);
    const runtimePaths = {
      zcodeBuiltinFilePath: join(root, "config/provider/zcode-builtin.json"),
      personalFilePath,
    };
    runtime = new NodeProviderRegistryRuntime({
      ...runtimePaths,
      watch: false,
      personalPollingIntervalMs: false,
    });
    await runtime.start();
    const facade = createNodeModelSelectionFacade(runtime.registryService);
    const modelSelectionService = {
      getView: async (input?: ModelSelectionViewInput) =>
        facade.getView(undefined, undefined, input),
      onDidChange: (listener: Parameters<typeof facade.onDidChange>[0]) => ({
        dispose: facade.onDidChange(listener),
      }),
    };
    repo = new TaskIndexRepo();
    const projects: ProjectRepositoryContract = await repo.getProjectRepository();
    agent = createZCodeAgentService({
      processLifecycleReporter: options.processLifecycleReporter,
      prepareSessionCreation: async (target) => {
        // 创建 owner 先预留归属；模型网络夹具不伪造 SQLite admission 或 ACK。
        const prepared = projects.reserveCreatedTask({
          task: { ...target, taskId: target.sessionId },
          projectId: target.projectId,
          creationCommand: target.creationCommand,
          additionalDirectories: target.additionalDirectories,
        });
        return {
          sessionId: prepared.taskId,
          additionalDirectories: prepared.additionalDirectories,
        };
      },
      commandResolver: () => ({
        command: process.execPath,
        args: [...(options.cliNodeArgs ?? []), cliEntrypoint, "app-server", "--stdio"],
        env: {
          HOME: home,
          USERPROFILE: home,
          ZCODE_DATA_BASE_DIR: home,
          TEMP: temp,
          TMP: temp,
          TMPDIR: temp,
          ZCODE_STORAGE_DIR: join(home, ".zcodium"),
          ZCODE_SESSION_DB_PATH: join(cliRoot, "db/db.sqlite"),
          ZCODE_SESSION_DB: join(cliRoot, "db/db.sqlite"),
          ZCODE_LOG_DIR: join(home, "logs"),
          ZCODE_HTTP_PROXY: "",
          ZCODE_NO_PROXY: "localhost,127.0.0.1,::1",
          ZCODE_RUNTIME_ENV: "development",
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: runtimePaths.zcodeBuiltinFilePath,
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalFilePath,
        },
      }),
      modelSelectionReadinessSource: modelSelectionService,
    });
    syncer = createZCodeTaskIndexSyncer({ agentService: agent, taskIndexRepo: repo });
    const task = createZCodeTaskServiceAdapter({
      zcodeAgentService: agent,
      taskIndexRepo: repo,
      taskIndexSyncer: syncer,
    });
    return {
      home,
      repo,
      projects,
      workspacePath,
      agent,
      task,
      modelSelectionService,
      modelSelection,
      async readProviderRequests() {
        const artifact: E2ENetworkCaptureArtifact = JSON.parse(
          await readFile(replay.artifactPath, "utf8"),
        );
        return artifact.records;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
