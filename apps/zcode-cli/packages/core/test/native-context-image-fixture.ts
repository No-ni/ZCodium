import assert from "node:assert/strict";
import {
  createRootTraceContext,
  createSessionId,
  type MessageId,
  type PartId,
  type FilePart,
  type ImagePrepareForModelRequest,
  type ImagePrepareForModelResult,
  type MessageWithParts,
  type Model,
  type ModelImageContentBlock,
  type ToolPart,
} from "@zcode/contracts";
import {
  createRecommendedNativeContextConfiguration,
  nativeContextCommitSchema,
  nativeContextObservationSchema,
  type NativeContextCommit,
  type NativeContextObservation,
  type NativeContextOperation,
  type NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import type { RuntimeMessageMessageEntry } from "../src/agent/message-history.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { originalImageToStorageMetadata } from "../src/media/original-image/index.js";
import {
  initialNativeState,
  nativeOwner,
} from "../src/runtime/native-context-compression/state.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";
import { nativeHash } from "../src/runtime/native-context-compression/identity.js";
import {
  nativeEntriesWithImageIdentity,
  projectNativeEntries,
} from "../src/runtime/native-context-compression/projection.js";
import type { NativeContextImagesRequest } from "../src/runtime/native-context-compression/images.js";

export const countTokens = (text: string) => Math.ceil(text.length / 4);
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
// 根因：构造器再次加 msg_/part_ 前缀，导致持久 FilePart 与已指定的 canonical 身份不一致。
const fixtureMessageId = (id: string): MessageId => id as MessageId;
const fixturePartId = (id: string): PartId => id as PartId;
/** 仅用于独立预算/身份测试的编码头，不冒充真实图像编解码器或视觉 E2E。 */
export function pngHeaderBytes(size = 4096, width = 1024, height = 512): Buffer {
  const data = Buffer.alloc(Math.max(size, 24), 61);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.write("IHDR", 12);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}
export function imageModel(id = "fixture-image-model", supportsImage = true): Model {
  return {
    providerId: "fixture-provider",
    modelId: id,
    properties: {
      contextWindow: 64000,
      inputFormat: { supportsImage, supportsPdf: false, supportsVideo: false },
    },
    optionSpecs: { maxOutputTokens: { max: 4096 } },
    options: {},
  } as unknown as Model;
}
export function textEntry(
  id: string,
  role: "user" | "assistant" | "tool",
  text = id,
  entryIndex = 0,
): RuntimeMessageMessageEntry {
  return {
    message: { role, content: text },
    canonical: { messageId: id, createdAt: 10, entryIndex },
  };
}
export function fixtureImageBlock(
  data: Uint8Array,
  partId: string,
  preserveRaster = false,
): ModelImageContentBlock {
  const hash = nativeHash(data);
  return {
    type: "image",
    mediaType: "image/png",
    dataUrl: "data:image/png;base64," + Buffer.from(data).toString("base64"),
    source: {
      id: partId,
      kind: "resource",
      canonicalPartId: partId,
      uri: "zcode-artifact://native-image-fixture/original-" + hash,
      originalImage: {
        artifactUri: "zcode-artifact://native-image-fixture/original-" + hash,
        sha256: hash,
        bytes: data.byteLength,
        mediaType: "image/png",
        sourceKind: "attachment",
        ...(preserveRaster ? { preserveRaster: true } : {}),
      },
    },
  };
}
export function imageFixture(mode: "auto" | "manual" = "auto") {
  const sessionId = createSessionId("native-image-fixture");
  const entries: RuntimeMessageMessageEntry[] = [],
    messages = new Map<string, MessageWithParts>(),
    binaries = new Map<string, Uint8Array>();
  const writes: Uint8Array[] = [],
    calls: ImagePrepareForModelRequest[] = [],
    commits: NativeContextStoredState[] = [],
    commitRequests: NativeContextCommit[] = [],
    events: unknown[] = [];
  const operations = new Map<string, NativeContextOperation>(),
    observations = new Map<string, NativeContextObservation>();
  let failCommit = false,
    failPublish = false;
  let encode = (request: ImagePrepareForModelRequest): ImagePrepareForModelResult => ({
    data: pngHeaderBytes(1024, 512, 256),
    mediaType: "image/png",
    resized: true,
    compressed: true,
    originalSizeBytes: request.data.byteLength,
    transformedSizeBytes: 1024,
    strategy: "resized",
    width: 512,
    height: 256,
  });
  const runtime = {
    branchGeneration: 0,
    sessionId,
    config: {},
    sessionPersisted: true,
    sessionModelSelection: { providerId: "fixture-provider", modelId: "fixture-image-model" },
    messageHistory: { borrowReadOnlyRuntimeEntries: () => entries },
    rootTraceContext: createRootTraceContext({ sessionId }),
    createEvent: (type: string, payload: unknown) => ({ type, payload }),
    appendEvent: async (event: unknown) => {
      if (failPublish) {
        failPublish = false;
        throw new Error("synthetic publish rejection");
      }
      events.push(event);
    },
    artifactStore: {
      async readToolResultBinaryArtifact({ uri }: { uri: string }) {
        const data = binaries.get(uri);
        if (!data) throw new Error("synthetic missing binary");
        return { uri, bytes: Uint8Array.from(data), contentType: "image/png" };
      },
      async writeToolResultBinaryArtifact(request: { content: Uint8Array; contentType: string }) {
        const data = Uint8Array.from(request.content),
          uri = "zcode-artifact://native-image-fixture/copy-" + nativeHash(data);
        writes.push(data);
        binaries.set(uri, data);
        return {
          id: "copy",
          uri,
          bytes: data.byteLength,
          contentType: request.contentType,
          createdAt: new Date(0),
        };
      },
    },
    imageProcessorPort: {
      async prepareForModel(request: ImagePrepareForModelRequest) {
        calls.push(request);
        return encode(request);
      },
    },
    sessionStore: {
      async messageWithParts({ messageID }: { messageID: string }) {
        return messages.get(messageID) ?? null;
      },
      async commitNativeContext(_sessionId: string, request: NativeContextCommit) {
        if (failCommit) {
          failCommit = false;
          throw new Error("synthetic CAS rejection");
        }
        assert.equal(
          request.expectedRevision,
          nativeOwner(runtime as unknown as AgentRuntimeInternal).state!.revision,
        );
        assert.equal(
          request.expectedGeneration,
          (runtime as unknown as AgentRuntimeInternal).branchGeneration,
        );
        const committed = nativeContextCommitSchema.parse(request);
        // 图片记录与响应凭据必须来自同一次 CAS；完整保存事实，拒绝时不留下部分 ledger。
        commitRequests.push(committed);
        commits.push(committed.state);
        for (const operation of committed.operations ?? [])
          operations.set(operation.operationId, structuredClone(operation));
        for (const observation of committed.observations ?? [])
          observations.set(observation.id, structuredClone(observation));
      },
    },
  } as unknown as AgentRuntimeInternal;
  const owner = nativeOwner(runtime);
  owner.state = initialNativeState(runtime, createRecommendedNativeContextConfiguration(mode));
  owner.state.policy.parameters.history.preserveTurns = 0;
  owner.state.policy.parameters.history.preserveMessages = 0;
  owner.state.policy.parameters.history.preserveTokens = 0;
  const filePart = (messageId: string, block: ModelImageContentBlock): FilePart => ({
    id: fixturePartId(block.source!.canonicalPartId!),
    messageID: fixtureMessageId(messageId),
    sessionID: sessionId,
    type: "file",
    mime: block.mediaType,
    url: block.dataUrl,
    metadata: { image: originalImageToStorageMetadata(block.source!.originalImage) },
  });
  const assistantMessage = (id: string, model = imageModel()): MessageWithParts => ({
    info: {
      id: fixtureMessageId(id),
      sessionID: sessionId,
      role: "assistant",
      time: { created: 20, completed: 30 },
      parentID: fixtureMessageId("latest"),
      mode: "build",
      agent: "fixture",
      path: { cwd: "fixture-workspace", root: "fixture-workspace" },
      tokens,
      cost: 0,
      modelId: model.modelId,
      providerId: model.providerId,
      finish: "completed",
    },
    parts: [],
  });
  const api = {
    runtime,
    owner,
    entries,
    messages,
    binaries,
    writes,
    calls,
    commits,
    commitRequests,
    operations,
    observations,
    events,
    get state() {
      return owner.state!;
    },
    setEncoder(next: typeof encode) {
      encode = next;
    },
    rejectNextCommit() {
      failCommit = true;
    },
    rejectNextPublish() {
      failPublish = true;
    },
    seedObservation(observation: NativeContextObservation) {
      const fact = nativeContextObservationSchema.parse(observation);
      observations.set(fact.id, structuredClone(fact));
      owner.lastObservation = structuredClone(fact);
      owner.state!.requestSeq = Math.max(owner.state!.requestSeq, fact.requestSeq);
      return structuredClone(fact);
    },
    addImage(id: string, data = pngHeaderBytes(), partId = id + "-image", preserveRaster = false) {
      const block = fixtureImageBlock(data, partId, preserveRaster);
      const entry = textEntry(id, "user");
      entry.message.content = [{ type: "text", text: id }, block];
      entry.canonical!.imagePartIds = [partId];
      entries.push(entry);
      messages.set(id, {
        info: {
          id: fixtureMessageId(id),
          sessionID: sessionId,
          role: "user",
          agent: "fixture",
          time: { created: 10 },
        },
        parts: [filePart(id, block)],
      });
      binaries.set(block.source!.originalImage!.artifactUri, Uint8Array.from(data));
      return block;
    },
    addText(id: string, role: "user" | "assistant" | "tool" = "user", text = id) {
      const entry = textEntry(id, role, text);
      entries.push(entry);
      return entry;
    },
    sync() {
      syncNativeSources(owner.state!, entries, countTokens);
    },
    request(overrides: Partial<NativeContextImagesRequest> = {}): NativeContextImagesRequest {
      api.sync();
      const baseline = nativeEntriesWithImageIdentity(entries);
      const state = owner.state!;
      return {
        messages: projectNativeEntries(entries, state)
          .filter((entry) => entry.kind !== "attachment")
          .map((entry) => entry.message),
        model: imageModel(),
        assistantMessageId: "fixture-response-" + (commits.length + 1),
        traceContext: runtime.rootTraceContext,
        comparison: {
          baselineMessages: baseline.map((entry) =>
            entry.kind !== "attachment" ? entry.message : { role: "user", content: entry.content },
          ),
          baselineEntries: structuredClone(entries),
          generation: state.generation,
          historyVersion: state.historyVersion,
          policyVersion: state.policy.policyVersion,
          policy: structuredClone(state.policy),
          segmentId: state.compactBoundaryId,
          operationIds: [],
        },
        ...overrides,
      };
    },
    complete(
      input: NativeContextImagesRequest,
      options: {
        missingFinish?: boolean;
        incomplete?: boolean;
        error?: boolean;
        reason?: string;
      } = {},
    ) {
      const response = assistantMessage(input.assistantMessageId, input.model);
      assert.equal(response.info.role, "assistant");
      if (response.info.role === "assistant") {
        if (options.incomplete) delete response.info.time.completed;
        if (options.error) response.info.error = { name: "fixture-error" } as never;
        response.info.finish = options.reason ?? "completed";
      }
      if (!options.missingFinish)
        response.parts.push({
          id: fixturePartId(input.assistantMessageId + "-finish"),
          sessionID: sessionId,
          messageID: fixtureMessageId(input.assistantMessageId),
          type: "step-finish",
          reason: options.reason ?? "completed",
          tokens,
          cost: 0,
        });
      messages.set(input.assistantMessageId, response);
      entries.push(textEntry(input.assistantMessageId, "assistant", "completed fixture response"));
      return response;
    },
    addRestore(ref: string, validTool = true) {
      const source = owner.state!.sources.find((item) => item.ref === ref)!;
      const data = binaries.get(source.artifactUri!)!,
        id = "restore-" + entries.length,
        partId = id + "-image";
      const block = fixtureImageBlock(data, partId);
      block.source!.id = "context-original-" + ref;
      const call = textEntry(id, "assistant", "", 0);
      call.message.toolCalls = [{ id: id + "-call", name: "context_read_image", input: { ref } }];
      const result = textEntry(id, "tool", "", 1);
      result.message.content = [block];
      result.message.toolName = "context_read_image";
      result.message.toolCallId = id + "-call";
      result.canonical!.partId = id + "-tool";
      result.canonical!.imagePartIds = [partId];
      entries.push(call, result);
      const tool: ToolPart = {
        id: fixturePartId(id + "-tool"),
        sessionID: sessionId,
        messageID: fixtureMessageId(id),
        type: "tool",
        callID: id + "-call",
        tool: validTool ? "context_read_image" : "Read",
        state: {
          status: "completed",
          input: { ref },
          output: "",
          title: "",
          metadata: {},
          time: { start: 20, end: 25 },
          attachments: [filePart(id, block)],
        },
      };
      const message = assistantMessage(id);
      message.parts.push(tool);
      messages.set(id, message);
      owner.restoreImageRefs ??= new Set();
      owner.restoreImageRefs.add(ref);
      return block;
    },
  };
  return api;
}
