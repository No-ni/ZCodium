import { appendRequestAnnouncements } from "./context-refresh.js";
import { getTurnTools } from "./turn-tool-visibility.js";
import { beginLocalTurnPreparation } from "@zcode/contracts";
import { CompactPhase, CompactReason, traceContextToLogContext, TurnMachineImpl } from "../deps.js";
import {
  buildRuntimeProviderRequestMessages,
  prepareRuntimeProviderRequest,
  createCompactRapidRefillError,
  throwIfTurnAborted,
} from "../helpers/index.js";
import { isRuntimeAttachmentEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import { isRealUserPrompt } from "../helpers/provider-entry-origins.js";
import {
  evaluateRapidRefill,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { consumeSettledProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import {
  appendTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";
import { recordPromptSnapshot } from "../helpers/prompt-snapshot.js";
import { isNewTurnInput, collectInputAttachments } from "./turn-input-attachments.js";

export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
    // guide 只允许由完整 tool result batch 设置这个一次性诊断；普通 queue 不在
    // model roundtrip 起点消费，避免把未来 turn 错并入当前 product turn。
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    // 通知只在带新输入的请求前取出：完整工具批次之后、文本回复后续上 guide，与输入附件同一时机。
    // 修复原因：每次迭代都取时，Stop hook 续跑、流重试、降级等重发同一份输入的请求也被插入通知；
    // 所以其余时候通知留在队列里，本轮结束后开新一轮。
    if (
      state.inputAttachmentCollectionPending &&
      state.modelStepCount > 0 &&
      !outputTokenRecoveryActive
    ) {
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
      }
    }

    const finishMcp = beginLocalTurnPreparation(state.turnTraceContext, "mcp");
    await this.initializeMcp(state.turnTraceContext);
    // tools/list_changed 只在回合开始前生效。
    await this.refreshMcpToolsIfChanged(state.turnTraceContext);
    finishMcp();
    throwIfTurnAborted(state.turnAbortSignal);
    const finishTools = beginLocalTurnPreparation(state.turnTraceContext, "tools");
    const tools = getTurnTools(this, state);
    finishTools();

    // 输入附件在 compaction 之前运行：本轮输入或上一批工具结果产生的项属于 compaction
    // 保留或摘要的历史。只在有新输入时收集（轮首、完整工具批次之后、文本回复后续上 guide）；
    // 新轮通知的首个请求跳过。
    // Stop hook 续跑、模型降级、流恢复、Start Plan 排队重试、上下文超限恢复、闲时换票
    // 都重发同一份输入，不收集：每次收集都会多出一条 output_style 等不去重的附件。
    const collectionReason = state.inputAttachmentCollectionPending;
    if (collectionReason) {
      state.inputAttachmentCollectionPending = false;
      // 收集只追加附件，最新的非附件 entry 在收集期间不变；只查一次，跳过规则和预算提醒共用。
      const latestMessage = state.turnRequestState.entries.findLast(
        (entry) => !isRuntimeAttachmentEntry(entry),
      );
      if (!isNewTurnInput(latestMessage)) {
        // 触发收集的输入是否出自用户本人：纯文本回复后看本次取出的 guide（历史 metadata 不可靠，
        // 见 isUserSteer），其余看最新输入。
        const fromUser =
          collectionReason === "text_guide"
            ? drainedSteerForNextRequest?.userSteered === true
            : latestMessage !== undefined && isRealUserPrompt(latestMessage);
        await collectInputAttachments(this, state, tools, collectionReason, fromUser);
      }
    }

    if (state.completedRealToolResultBatch && !outputTokenRecoveryActive) {
      state.completedRealToolResultBatch = false;
      // memory prefetch 排在输入附件之后。
      const recallEntry = consumeSettledProjectMemoryRecall(
        this,
        ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
      );
      appendTurnRequestEntries(state.turnRequestState, recallEntry ? [recallEntry] : []);
    }

    const compactPhase =
      state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
    await this.microcompactIfNeeded(state.turnTraceContext, state.events, state.turnAbortSignal, {
      model: state.model,
      modelStepIndex: state.modelStepCount,
      phase: compactPhase,
      turnRequestState: state.turnRequestState,
    });
    throwIfTurnAborted(state.turnAbortSignal);

    const rapidRefill = evaluateRapidRefill(state.compactTracking);
    const autoCompactOutcome = await this.autoCompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        requestTools: tools,
        getAgentListingTools: () => tools,
        compactReason: CompactReason.ContextLimit,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        rapidRefill,
        model: state.model,
        turnRequestState: state.turnRequestState,
        getContinuationTools: () => getTurnTools(this, state),
      },
    );
    if (autoCompactOutcome === "rapid_refill_blocked") {
      throw createCompactRapidRefillError({
        consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
        toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
        toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      });
    }
    if (autoCompactOutcome === "compacted") {
      recordCompactSuccess(state, rapidRefill);
      recordCompactHistoryRound(state);
    }
    throwIfTurnAborted(state.turnAbortSignal);

    // 请求前公告在 compaction 之后运行，
    // 不受输入附件跳过规则影响；按类型对历史去重，通常为空。
    await appendRequestAnnouncements(
      this,
      state.turnRequestState,
      state.turnTraceContext,
      state.turnAbortSignal,
    );
    const requestEntries = [...state.turnRequestState.entries];
    const prepared = prepareRuntimeProviderRequest(this, {
      model: state.model,
      tools,
      registry: this.getToolRegistry(),
      entries: requestEntries,
      // 本仓改写曾遗漏官方缓存准入，导致实际请求与记录投影失配；标记仍只写请求副本。
      applyCacheControl: true,
    });
    // 主会话没有可用的 prompt 快照时，按本次请求的前缀记录 system。
    await recordPromptSnapshot(this, {
      model: state.model,
      modelSelectionScope: state.modelSelectionScope,
      entries: requestEntries,
      traceContext: state.turnTraceContext,
    });
    this.logger?.debug("ToolSearch request exposure", {
      event: "tool.search.exposure",
      enabled: prepared.toolSearch.enabled,
      mode: prepared.toolSearch.mode,
      reason: prepared.reason,
      catalogSize: prepared.toolSearch.catalog.length,
      schemaCount: prepared.request.tools.length,
    });
    // 修复原因：provider-visible user ordering projection 会改变最终 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    const providerProjection = prepared.projection;
    const { messages } = prepared.request;
    const recordableEntries = filterOutputTokenContinuationEntries(prepared.entries);
    const recordableProjection =
      recordableEntries === prepared.entries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            loadedToolCallIds: prepared.loadedToolCallIds,
            applyCacheControl: true,
            model: state.model,
            toolSearchProjected: true,
          });
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(
        `${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages,
      ),
    );

    // 生产包需要知道 Turn 是否已经跨过 provider 边界；这里只记录请求元数据，
    // 不记录 prompt、消息内容或 streaming chunk，避免泄露内容并控制日志量。
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    });

    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
      messages,
      sourceEntries: providerProjection.sourceEntries,
      originEntries: providerProjection.originEntries,
      requestEntries,
      recordedMessages: recordableProjection.messages,
      tools: prepared.request.tools,
      toolSearch: prepared.toolSearch,
    });

    if (result === "break") {
      break;
    }
  }
}
