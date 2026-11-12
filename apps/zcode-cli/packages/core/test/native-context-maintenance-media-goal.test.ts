import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { getModelUsageTotalTokens, type ToolPart } from "@zcode/contracts";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { kernelOf, writeNativeState } from "../src/runtime/native-context-compression/state.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";
import { nativeCountTokens } from "../src/runtime/native-context-compression/measurements.js";
import { nativeOutputCandidates } from "../src/runtime/native-context-compression/tool-views.js";
import { nativeMaintenanceRanges } from "../src/runtime/native-context-compression/candidates.js";
import { PARENT } from "./native-context-boundary-fixture.js";
import { USAGE, SUMMARY } from "./native-context-maintenance-fixture.js";
import { maintenanceGoalFixture } from "./native-context-maintenance-goal-fixture.js";
import { maintenanceMediaFixture } from "./native-context-maintenance-media-fixture.js";

test("image distillation carries the owned media through Model, Goal accounting and the real SQLite view commit", async (t) => {
  const media = maintenanceMediaFixture([1]);
  let offeredRef = "";
  const f = await maintenanceGoalFixture(t, {
    configure: (state) => {
      state.policy.parameters.summary.minRangeChars = 1_000_000;
      state.policy.parameters.tools.distill.enabled = true;
      state.policy.parameters.tools.distill.mediaOnly = true;
      state.policy.parameters.tools.distill.minContextPercent = 0;
      state.policy.parameters.tools.distill.excludeTools = [];
      state.policy.parameters.tools.simplify.enabled = false;
      state.policy.parameters.tools.reference.enabled = false;
      state.policy.parameters.history.protectedTools = [];
      state.policy.parameters.history.protectedLatestTools = [];
    },
    plan: ({ request }) => {
      const user = request.messages.findLast((item) => item.role === "user");
      assert.ok(Array.isArray(user?.content), "the actual Model request must contain the image");
      const content = user.content;
      const first = content[0];
      assert.equal(first?.type, "text");
      assert.ok(first?.type === "text");
      const offered = JSON.parse(first.text) as { ranges: unknown[]; outputs: { ref: string; source: string }[] };
      assert.equal(offered.ranges.length, 0);
      assert.equal(offered.outputs.length, 1);
      assert.equal(offered.outputs[0]!.ref, offeredRef);
      assert.ok(offered.outputs[0]!.source.includes("recoverable tool result"));
      const images = content.filter((block) => block.type === "image");
      assert.equal(images.length, 1);
      assert.equal(images[0]!.mediaType, "image/png");
      assert.ok(images[0]!.dataUrl.startsWith("data:image/png;base64,"));
      assert.ok(content.some((block) => block.type === "text" && block.text.includes('"outputRef":"' + offeredRef + '"')));
      return { text: JSON.stringify({ ranges: [], outputs: [{ ref: offeredRef, summary: SUMMARY }] }) };
    },
  });
  f.model.properties.inputFormat.supportsImage = true;
  const artifactPort = media.native.runtime.artifactStore;
  assert.ok(artifactPort?.readToolResultBinaryArtifact);
  const readBinary = artifactPort.readToolResultBinaryArtifact.bind(artifactPort);
  f.runtime.artifactStore = {
    ...artifactPort,
    async readToolResultArtifact(request) {
      const stored = await readBinary(request);
      return { uri: stored.uri, contentType: stored.contentType, bytes: stored.bytes.length,
        content: "data:" + stored.contentType + ";base64," + Buffer.from(stored.bytes).toString("base64") };
    },
  };
  f.runtime.imageProcessorPort = media.native.runtime.imageProcessorPort;
  const assistant = structuredClone(f.messages[1]!);
  const originalMessage = media.native.messages.values().next().value!;
  const sourceTool = originalMessage.parts.find((part) => part.type === "tool");
  assert.ok(sourceTool?.type === "tool" && sourceTool.state.status === "completed");
  const tool: ToolPart = { ...structuredClone(sourceTool), id: assistant.parts[0]!.id,
    messageID: assistant.info.id, sessionID: PARENT };
  assert.ok(tool.state.status === "completed");
  // 真实 hydration 只信完整持久 layout；旧 attachments 不能单独证明工具曾把图片提供给模型。
  tool.state.metadata.modelContentLayout = [
    { type: "text", text: "recoverable tool result ".repeat(100) },
    { type: "attachment", attachmentIndex: 0 },
  ];
  for (const attachment of tool.state.attachments ?? []) {
    attachment.messageID = assistant.info.id;
    attachment.sessionID = PARENT;
  }
  assistant.parts = [tool];
  f.messages[1] = assistant;
  await f.store.commitMessageBundle({ sessionID: PARENT, messages: [assistant] });
  const storedToolMessage = await f.store.messageWithParts({ sessionID: PARENT, messageID: assistant.info.id });
  assert.deepEqual(storedToolMessage?.parts, assistant.parts);
  f.runtime.messageHistory.reset();
  await hydrateMessageHistoryFromSession({ history: f.runtime.messageHistory, messages: f.messages,
    artifactStore: f.runtime.artifactStore });
  await writeNativeState(f.owner, (state) => syncNativeSources(state,
    f.runtime.messageHistory.borrowReadOnlyRuntimeEntries(), nativeCountTokens));
  const canonicalBefore = await f.store.messages({ sessionID: PARENT });
  const originalBefore = [...media.native.binaries].map(([uri, bytes]) =>
    [uri, createHash("sha256").update(bytes).digest("hex")] as const);
  const entries = f.runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  assert.equal(nativeMaintenanceRanges(entries, f.owner.state!, 100_000).length, 0);
  const outputs = nativeOutputCandidates(entries, f.owner.state!, 10_000, 32_768);
  assert.equal(outputs.length, 1);
  offeredRef = outputs[0]!.ref;
  assert.equal(outputs[0]!.source.kind, "tool-result");
  assert.equal(f.calls.length, 0);
  const ack = await f.manual("synthetic-image-goal-maintenance");
  assert.ok(ack.operation);
  const operation = await f.store.getNativeContextOperation(PARENT, ack.operation.operationId);
  assert.equal(operation?.status, "completed");
  const committed = await f.store.getNativeContextState(PARENT);
  assert.ok(committed);
  assert.equal(kernelOf(committed).views[outputs[0]!.rawId]?.kind, "distilled");
  assert.ok(kernelOf(committed).views[outputs[0]!.rawId]!.text.includes(SUMMARY));
  assert.equal(kernelOf(committed).projectionOperations?.views[outputs[0]!.rawId], operation!.operationId);
  assert.deepEqual(committed.imageReceipts, []);
  assert.equal(f.calls.length, 1);
  assert.equal(f.invocations[0]!.querySource, "native_context_maintenance");
  const observations = await f.observations();
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.status, "completed");
  assert.deepEqual(observations[0]!.operationIds, [operation!.operationId]);
  assert.equal(observations[0]!.actualInputTokens, USAGE.inputTokens);
  assert.equal(observations[0]!.outputTokens, USAGE.outputTokens);
  assert.deepEqual(operation!.observationIds, [observations[0]!.id]);
  assert.deepEqual(await f.store.messages({ sessionID: PARENT }), canonicalBefore);
  for (const [uri, hash] of originalBefore)
    assert.equal(createHash("sha256").update(media.native.binaries.get(uri)!).digest("hex"), hash);
  assert.ok(media.native.calls.length > 0, "the existing image port must prepare the sent copy");
  await f.replayManual("synthetic-image-goal-maintenance");
  assert.equal(f.calls.length, 1);
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(usage.modelRequestCount, 1);
  const goal = await f.store.readTarget({ sessionID: PARENT });
  assert.equal(goal?.targetID, f.goal.targetID);
  assert.equal(goal?.tokensUsed, getModelUsageTotalTokens(USAGE));
  assert.equal(f.runtime.runtimeCommandQueue.size(), 0);
  assert.equal(f.owner.phase, "idle");
  assert.deepEqual(await f.store.getNativeContextState(PARENT), committed);
});
