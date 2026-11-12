import type { FilePart, MessageId, PartId, ToolPart } from "@zcode/contracts";
import { originalImageToStorageMetadata } from "../src/media/original-image/index.js";
import {
  nativeEntryText,
  nativeRawId,
} from "../src/runtime/native-context-compression/identity.js";
import type { prepareNativeMaintenanceMedia } from "../src/runtime/native-context-compression/maintenance-media.js";
import {
  fixtureImageBlock,
  imageFixture,
  imageModel,
  pngHeaderBytes,
} from "./native-context-image-fixture.js";

/** 合成持久 completed ToolPart；不把用户 FilePart 冒充工具结果或真实视觉 E2E。 */
export function maintenanceMediaFixture(
  imageCounts: readonly number[] = [1],
  bytes: Uint8Array = pngHeaderBytes(),
  preserveRaster = false,
) {
  const native = imageFixture();
  for (const [outputIndex, imageCount] of imageCounts.entries()) {
    const id = "maintenance-output-" + outputIndex;
    const call = native.addText(id, "assistant", "tool call");
    call.message.toolCalls = [{ id: id + "-call", name: "Read", input: { file: "fixture-image" } }];
    const entry = native.addText(id, "tool", "recoverable tool result ".repeat(100));
    entry.canonical!.entryIndex = 1;
    entry.canonical!.partId = id + "-tool";
    entry.message.toolCallId = id + "-call";
    entry.message.toolName = "Read";
    const blocks = Array.from({ length: imageCount }, (_, imageIndex) => {
      const block = fixtureImageBlock(bytes, id + "-image-" + imageIndex, preserveRaster);
      block.source!.originalImage!.sourceKind = "read";
      native.binaries.set(block.source!.originalImage!.artifactUri, Uint8Array.from(bytes));
      return block;
    });
    entry.canonical!.imagePartIds = blocks.map((block) => block.source!.canonicalPartId!);
    entry.message.content = [
      { type: "text", text: "recoverable tool result ".repeat(100) },
      ...blocks,
    ];
    const attachments: FilePart[] = blocks.map((block) => ({
      id: block.source!.canonicalPartId! as PartId,
      messageID: id as MessageId,
      sessionID: native.runtime.sessionId,
      type: "file",
      mime: block.mediaType,
      url: block.source!.originalImage!.artifactUri,
      metadata: { image: originalImageToStorageMetadata(block.source!.originalImage) },
    }));
    const tool: ToolPart = {
      id: entry.canonical!.partId as PartId,
      messageID: id as MessageId,
      sessionID: native.runtime.sessionId,
      type: "tool",
      callID: id + "-call",
      tool: "Read",
      state: {
        status: "completed",
        input: { file: "fixture-image" },
        output: nativeEntryText(entry),
        title: "fixture result",
        metadata: {},
        time: { start: 10, end: 20 },
        attachments,
      },
    };
    native.messages.set(id, {
      info: {
        id: id as MessageId,
        sessionID: native.runtime.sessionId,
        role: "assistant",
        time: { created: 10, completed: 20 },
        parentID: "fixture-user" as MessageId,
        mode: "build",
        agent: "fixture",
        path: { cwd: "fixture-workspace", root: "fixture-workspace" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        modelId: imageModel().modelId,
        providerId: imageModel().providerId,
      },
      parts: [tool],
    });
  }
  native.sync();
  const entries = structuredClone(native.entries);
  const outputs = entries
    .filter((entry) => entry.message.role === "tool")
    .map((entry) => {
      const rawId = nativeRawId(entry)!;
      const source = native.state.sources.find((item) => item.rawId === rawId)!;
      return {
        rawId,
        ref: source.ref,
        text: nativeEntryText(entry),
        entry,
        source: structuredClone(source),
      };
    });
  const input: Parameters<typeof prepareNativeMaintenanceMedia>[1] = {
    state: structuredClone(native.state),
    model: imageModel(),
    safePoint: {
      entries,
      model: imageModel(),
      tools: [],
      traceContext: native.runtime.rootTraceContext,
    },
    outputs,
    messages: [
      { role: "system", content: "Summarize the offered recoverable tool outputs." },
      {
        role: "user",
        content: JSON.stringify({
          outputs: outputs.map((output) => ({ ref: output.ref, source: output.text })),
        }),
      },
    ],
    operationId: "maintenance-media-fixture-operation",
  };
  return { native, input };
}
