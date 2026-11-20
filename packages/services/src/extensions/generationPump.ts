import { Emitter, type Event } from "@zcode/rpc";
import {
  ESTIMATED_TOKEN_CHAR_DIVISOR,
  calculateOutputTps,
  isRemoteWorkspaceIdentity,
} from "@zcode/shared";
import {
  GENERATION_STREAMING_PUSH_INTERVAL_MS,
  workspaceScopeKey,
  type GenerationMetrics,
  type LocalGenerationFact,
  type WorkspaceRef,
} from "@zcode/shared/extension-host";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createWorkspaceSubscriptions,
  type WorkbenchState,
} from "#src/extensions/workbenchState.js";

interface StreamState {
  requestId: string;
  workspace: WorkspaceRef;
  model: { providerId: string; modelId: string };
  firstChunkAt?: number;
  chars: number;
  lastPushAt: number;
}
export interface GenerationPump {
  readonly onDidGenerate: Event<GenerationMetrics>;
  dispose(): void;
}

/** Window Host 是唯一聚合点；只消费本地 scalar，没有扩展订阅时不建立派生缓存。 */
export function createGenerationPump(deps: {
  agent: Pick<IZCodeAgentService, "onDynamicLocalGenerationFacts">;
  workbench: WorkbenchState;
  logger: Pick<ServiceLogger, "debug" | "info">;
  now?: () => number;
}): GenerationPump {
  const now = deps.now ?? Date.now;
  const streams = new Map<string, StreamState>();
  const seen = new Set<string>();
  const instances = new Map<string, string>();
  const handleFact = (workspace: WorkspaceRef, fact: LocalGenerationFact) => {
    const scope = workspaceScopeKey(workspace);
    const prefix = scope + "\0";
    if (instances.get(scope) !== fact.instanceId) {
      // Bug 根因：进程换代不会补造旧请求终态；新实例开始前释放该工作区旧派生状态。
      for (const key of streams.keys()) if (key.startsWith(prefix)) streams.delete(key);
      for (const key of seen) if (key.startsWith(prefix)) seen.delete(key);
      instances.set(scope, fact.instanceId);
    }
    const eventKey = prefix + fact.instanceId + "\0" + fact.eventId;
    if (seen.has(eventKey)) return;
    seen.add(eventKey);
    if (seen.size > 4096) seen.delete(seen.values().next().value!);
    const key = prefix + fact.instanceId + "\0" + fact.sessionId;
    const current = streams.get(key);
    if (fact.kind === "started") {
      streams.set(key, {
        requestId: fact.requestId,
        workspace,
        model: { providerId: fact.providerId, modelId: fact.modelId },
        chars: 0,
        lastPushAt: Number.NEGATIVE_INFINITY,
      });
      if (streams.size > 1024) streams.delete(streams.keys().next().value!);
      return;
    }
    if (fact.kind === "retry") {
      if (current?.requestId === fact.requestId) {
        delete current.firstChunkAt;
        current.chars = 0;
        current.lastPushAt = Number.NEGATIVE_INFINITY;
      }
      return;
    }
    if (fact.kind === "failed") {
      if (current?.requestId === fact.requestId) streams.delete(key);
      return;
    }
    if (fact.kind === "completed") {
      if (current?.requestId === fact.requestId) streams.delete(key);
      const firstContentMs = fact.timeToFirstContentMs;
      const generationMs =
        firstContentMs !== undefined && fact.durationMs > firstContentMs
          ? fact.durationMs - firstContentMs
          : null;
      const outputTokensPerSecond = calculateOutputTps(fact.outputTokens, generationMs);
      if (outputTokensPerSecond === null) return;
      emitter.fire({
        sessionId: fact.sessionId,
        workspace,
        requestId: fact.requestId,
        model: { providerId: fact.providerId, modelId: fact.modelId },
        phase: "final",
        outputTokensPerSecond,
        ...(fact.outputTokens !== undefined ? { outputTokens: fact.outputTokens } : {}),
        ...(firstContentMs !== undefined ? { timeToFirstTokenMs: firstContentMs } : {}),
      });
      deps.logger.debug(undefined, "generation final delivered");
      return;
    }
    if (fact.kind !== "chunk" || !current) return;
    current.firstChunkAt ??= fact.occurredAt;
    current.chars += fact.chars;
    const elapsedMs = fact.occurredAt - current.firstChunkAt;
    if (elapsedMs <= 0) return;
    const pushedAt = now();
    if (pushedAt - current.lastPushAt < GENERATION_STREAMING_PUSH_INTERVAL_MS) return;
    current.lastPushAt = pushedAt;
    emitter.fire({
      sessionId: fact.sessionId,
      workspace: current.workspace,
      requestId: current.requestId,
      model: current.model,
      phase: "streaming",
      outputTokensPerSecond: (current.chars / ESTIMATED_TOKEN_CHAR_DIVISOR / elapsedMs) * 1000,
    });
    deps.logger.debug(undefined, "generation streaming delivered");
  };
  const facts = createWorkspaceSubscriptions(
    (workspace) =>
      isRemoteWorkspaceIdentity(workspace.workspaceIdentity ?? "")
        ? undefined
        : deps.agent.onDynamicLocalGenerationFacts(workspace),
    handleFact,
  );
  let active = false;
  const clear = () => {
    facts.disposeAll();
    streams.clear();
    seen.clear();
    instances.clear();
  };
  const emitter = new Emitter<GenerationMetrics>({
    onWillAddFirstListener: () => {
      active = true;
      facts.sync(deps.workbench.workspaces());
      deps.logger.info(undefined, "generation pump started", { workspaces: facts.size() });
    },
    onDidRemoveLastListener: () => {
      active = false;
      clear();
      deps.logger.info(undefined, "generation pump stopped");
    },
  });
  const reportSubscription = deps.workbench.onDidChangeReport(() => {
    if (active) facts.sync(deps.workbench.workspaces());
  });
  return {
    onDidGenerate: emitter.event,
    dispose() {
      reportSubscription.dispose();
      clear();
      emitter.dispose();
    },
  };
}
