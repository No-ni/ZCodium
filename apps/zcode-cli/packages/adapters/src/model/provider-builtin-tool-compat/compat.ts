import {
  RENDERING_PREFIX,
  isProviderBuiltinServerToolUse,
  isUpstreamMcpToolUse,
  withServerName,
  isRenderedSummary,
  toMcpToolUseBlock,
  toMcpToolResultBlock,
  isRenderingText,
  asRecord,
} from "./contentBlocks.js";
export {
  PROVIDER_BUILTIN_TOOL_SERVER_NAME,
  isProviderBuiltinServerToolUse,
  toMcpToolUseBlock,
  toMcpToolResultBlock,
} from "./contentBlocks.js";

// ─── 流式响应 ────────────────────────────────────────────────────────────────

export interface SseFrame {
  frame: string;
  separator: string;
}

interface HeldTextBlock {
  index: number;
  frames: SseFrame[];
  text: string;
  /**
   * call：可能是调用头副本；result：紧跟服务端调用的第一个 text 块，可能是结果副本；
   * summary：紧跟配对 mcp_tool_result 的第一个 text 块，可能是新格式的结果摘要副本。
   */
  role: keyof typeof RENDERING_PREFIX;
  /** result 角色对应的服务端调用；只有紧跟其后的就是这次调用的配对结果时，才确认是副本。 */
  resultForCallId?: string;
  /** summary 角色对应的配对调用工具名；摘要标签必须是这个工具的，才确认是副本。 */
  summaryForToolName?: string;
  /** 前缀已匹配且整块已收完，call / result 等下一个块开始时按结构确认去留（summary 收完时就确认）。 */
  complete: boolean;
}

/**
 * 逐帧改写；按 message 维护状态。返回需要继续交给下游的帧（可能为空，也可能补发多帧）。
 * 只处理已解析出 JSON 的帧，其余原样返回。
 */
export class ProviderBuiltinToolStreamRewriter {
  /**
   * 本条消息里服务端调用的 id → 工具名，等待配对结果。旧格式改写出的调用和上游原生调用共用一个集合，
   * 服务端半迁移、两种格式混出时也能配上。工具名用来确认新格式的结果摘要；上游没给名字时为 undefined。
   */
  private readonly pendingResultIds = new Map<string, string | undefined>();
  /** 没有配对调用的 mcp_tool_result 所在 index：start、delta、stop 一并丢弃。 */
  private readonly suppressedIndexes = new Set<number>();
  private held: HeldTextBlock | undefined;
  /** 上一个开始的块是服务端调用时为其 id；只有紧跟其后的 text 才可能是结果副本。 */
  private afterServerToolUseId: string | undefined;
  /** 上一个开始的块是配对的 mcp_tool_result 时为其调用的工具名；只有紧跟其后的 text 才可能是结果摘要副本。 */
  private afterMcpToolResultName: string | undefined;

  push(input: SseFrame, parsed: Record<string, unknown> | undefined): SseFrame[] {
    // 非 JSON 帧（注释、keepalive）和 ping 不影响块边界，直接放行，不打断缓冲。
    if (!parsed) return [input];
    const type = typeof parsed.type === "string" ? parsed.type : undefined;
    const index = typeof parsed.index === "number" ? parsed.index : undefined;
    if (type === "ping") return [input];

    if (type === "message_start") {
      const flushed = this.flushHeld();
      this.pendingResultIds.clear();
      this.suppressedIndexes.clear();
      this.afterServerToolUseId = undefined;
      this.afterMcpToolResultName = undefined;
      return [...flushed, input];
    }

    if (index !== undefined && this.suppressedIndexes.has(index)) {
      if (type === "content_block_stop") this.suppressedIndexes.delete(index);
      return [];
    }

    if (this.held && index === this.held.index) {
      return this.pushHeld(input, parsed, type);
    }

    if (type === "content_block_start" && index !== undefined) {
      const block = asRecord(parsed.content_block);
      const afterServerToolUseId = this.afterServerToolUseId;
      const afterMcpToolResultName = this.afterMcpToolResultName;
      this.afterServerToolUseId = undefined;
      this.afterMcpToolResultName = undefined;
      if (isProviderBuiltinServerToolUse(block)) {
        // 调用头副本只有紧跟其后的就是服务端调用时才确认是副本。
        this.dropConfirmedCopy("call");
        const flushed = this.flushHeld();
        this.pendingResultIds.set(block!.id as string, block!.name as string);
        this.afterServerToolUseId = block!.id as string;
        return [
          ...flushed,
          rewriteFrame(input, { ...parsed, content_block: toMcpToolUseBlock(block!) }),
        ];
      }
      if (isUpstreamMcpToolUse(block)) {
        // 新格式原生块不改写；调用头副本同样要紧跟其后的就是服务端调用才确认。
        // 并行调用时调用后面紧跟下一个调用头，所以这里不把后续 text 当结果副本。
        this.dropConfirmedCopy("call");
        const flushed = this.flushHeld();
        this.pendingResultIds.set(
          block!.id as string,
          typeof block!.name === "string" ? block!.name : undefined,
        );
        const normalized = withServerName(block!);
        return [
          ...flushed,
          normalized === block
            ? input
            : rewriteFrame(input, { ...parsed, content_block: normalized }),
        ];
      }
      if (block?.type === "mcp_tool_result") {
        const flushed = this.flushHeld();
        // 修复原因：AI SDK 按 tool_use_id 直接取调用记录，取不到会抛 TypeError，整条流失败。
        // 服务端不一定保证配对，没配对的结果按 index 整块丢弃；调用一侧由 core 按中断收口。
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        if (toolUseId === undefined || !this.pendingResultIds.has(toolUseId)) {
          this.suppressedIndexes.add(index);
          return flushed;
        }
        // 只有紧跟配对结果的 text 才可能是结果摘要副本，摘要标签要对上这次调用的工具名。
        this.afterMcpToolResultName = this.pendingResultIds.get(toolUseId);
        this.pendingResultIds.delete(toolUseId);
        return [...flushed, input];
      }
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        const paired = this.pendingResultIds.delete(block.tool_use_id);
        // 结果副本只有紧跟其后的就是配对的 tool_result 时才确认是副本，否则原样放行。
        if (paired) this.dropConfirmedCopy("result", block.tool_use_id);
        const flushed = this.flushHeld();
        if (!paired) return [...flushed, input];
        return [
          ...flushed,
          rewriteFrame(input, { ...parsed, content_block: toMcpToolResultBlock(block) }),
        ];
      }
      const flushed = this.flushHeld();
      if (block?.type === "text") {
        this.held = {
          index,
          frames: [input],
          text: typeof block.text === "string" ? block.text : "",
          role: afterServerToolUseId ? "result" : afterMcpToolResultName ? "summary" : "call",
          ...(afterServerToolUseId ? { resultForCallId: afterServerToolUseId } : {}),
          ...(afterMcpToolResultName ? { summaryForToolName: afterMcpToolResultName } : {}),
          complete: false,
        };
        return [...flushed, ...this.decideHeldPrefix()];
      }
      return [...flushed, input];
    }

    return [...this.flushHeld(), input];
  }

  /** 流结束时补发仍在缓冲的帧。 */
  finish(): SseFrame[] {
    return this.flushHeld();
  }

  private pushHeld(
    input: SseFrame,
    parsed: Record<string, unknown>,
    type: string | undefined,
  ): SseFrame[] {
    const held = this.held!;
    held.frames.push(input);
    const delta = asRecord(parsed.delta);
    if (type === "content_block_delta" && delta?.type === "text_delta") {
      held.text += typeof delta.text === "string" ? delta.text : "";
    }
    if (type === "content_block_stop") {
      const decided = this.decideHeldPrefix(true);
      if (this.held !== held) return decided;
      held.complete = true;
      if (held.role !== "summary") return decided;
      // 新格式的结果摘要后面没有结构块：整块收完时按配对调用的摘要标签确认身份，确认不了立即放行，
      // 不等下一个块，正文顺序不变。
      this.held = undefined;
      return held.summaryForToolName !== undefined &&
        isRenderedSummary(held.text, held.summaryForToolName)
        ? []
        : held.frames;
    }
    return this.decideHeldPrefix();
  }

  /** 前缀不匹配就放行；匹配则继续缓冲，按结构确认（dropConfirmedCopy）。 */
  private decideHeldPrefix(stopped = false): SseFrame[] {
    const held = this.held!;
    const text = held.text.trimStart();
    // 服务端漏发摘要、结果后直接接下一个调用时，紧跟结果的是调用头：改按 call 等下一个块确认。
    // 原因：summary 只认 **Output:**，否则这个调用头会留在正文里，旧格式在同样的顺序下会去掉它。
    if (held.role === "summary" && text.startsWith(RENDERING_PREFIX.call)) held.role = "call";
    const prefix = RENDERING_PREFIX[held.role];
    const decidable = stopped || text.length >= prefix.length;
    if (!decidable) return [];
    if (!text.startsWith(prefix)) return this.flushHeld();
    return [];
  }

  /**
   * 下一个块按结构确认了缓冲块就是服务端渲染副本时丢弃它（call / result；summary 在 pushHeld 收完整块时确认）；
   * 其余情况由 flushHeld 原样放行。
   */
  private dropConfirmedCopy(role: "call" | "result", resultForCallId?: string): void {
    const held = this.held;
    if (!held?.complete || held.role !== role) return;
    if (role === "result" && held.resultForCallId !== resultForCallId) return;
    this.held = undefined;
  }

  private flushHeld(): SseFrame[] {
    const held = this.held;
    this.held = undefined;
    return held ? held.frames : [];
  }
}

function rewriteFrame(input: SseFrame, data: Record<string, unknown>): SseFrame {
  const lineEnding = input.frame.includes("\r\n")
    ? "\r\n"
    : input.frame.includes("\r")
      ? "\r"
      : "\n";
  const type = typeof data.type === "string" ? data.type : "message";
  return {
    frame: `event: ${type}${lineEnding}data: ${JSON.stringify(data)}`,
    separator: input.separator,
  };
}

// ─── 非流式 JSON 响应 ─────────────────────────────────────────────────────────

export function rewriteProviderBuiltinToolContent(content: readonly unknown[]): {
  changed: boolean;
  content: unknown[];
} {
  const output: unknown[] = [];
  const pendingResultIds = new Set<string>();
  let changed = false;
  let previousServerToolUseId: string | undefined;
  for (const [position, value] of content.entries()) {
    const block = asRecord(value);
    const afterServerToolUseId = previousServerToolUseId;
    previousServerToolUseId = undefined;
    if (isProviderBuiltinServerToolUse(block)) {
      const previous = asRecord(output.at(-1));
      if (isRenderingText(previous, RENDERING_PREFIX.call)) output.pop();
      pendingResultIds.add(block!.id as string);
      output.push(toMcpToolUseBlock(block!));
      previousServerToolUseId = block!.id as string;
      changed = true;
      continue;
    }
    // 新格式非流式没有 markdown 渲染，只做与流式相同的两条防护。
    if (isUpstreamMcpToolUse(block)) {
      pendingResultIds.add(block!.id as string);
      const normalized = withServerName(block!);
      if (normalized !== block) changed = true;
      output.push(normalized);
      continue;
    }
    if (block?.type === "mcp_tool_result") {
      if (typeof block.tool_use_id === "string" && pendingResultIds.delete(block.tool_use_id)) {
        output.push(value);
      } else {
        changed = true;
      }
      continue;
    }
    if (block?.type === "tool_result") {
      changed = true;
      if (typeof block.tool_use_id === "string" && pendingResultIds.delete(block.tool_use_id)) {
        output.push(toMcpToolResultBlock(block));
      }
      continue;
    }
    // 结果副本必须夹在服务端调用和它的配对 tool_result 之间，不能只凭加粗前缀判断。
    const next = asRecord(content[position + 1]);
    if (
      afterServerToolUseId !== undefined &&
      isRenderingText(block, RENDERING_PREFIX.result) &&
      next?.type === "tool_result" &&
      next.tool_use_id === afterServerToolUseId
    ) {
      changed = true;
      continue;
    }
    output.push(value);
  }
  return { changed, content: changed ? output : [...content] };
}
