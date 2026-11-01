export interface ZCodeStreamingToolInputState {
  deltaCount?: number;
  lastPreviewAt?: number;
  lastPreviewRawInputLength?: number;
  rawInput: string;
}

export interface ZCodeStreamingToolInputPreview {
  complete: boolean;
  input: unknown;
  rawInput: string;
}

export type ZCodeStreamingToolInputPreviewMode = "active-live" | "background-summary";

export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_EAGER_DELTA_COUNT = 1;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS = 750;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH = 8 * 1024;
export const ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS = 1_000;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_TIME_BUDGET_MAX_RAW_INPUT =
  ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH;

const PARTIAL_JSON_STRING_FIELD_KEYS = [
  "file_path",
  "filePath",
  "path",
  "target_path",
  "targetPath",
  "filename",
  "file",
  "content",
  "new_string",
  "newString",
  "new_text",
  "newText",
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "command",
  "description",
  "title",
  "pattern",
  "replacement",
  // ExitPlanMode 的正文位于 plan 字段。把它纳入半截 JSON 预览后，计划卡片与
  // 侧边详情才能从首个流式 chunk 开始更新，而不是等 input_end 才突然出现。
  "plan",
  // CreateWorkflow 的脚本与名字：流式草稿
  // 要在模型还在写脚本时就把站扫出来，半截 script 必须从首个 chunk 起就进预览。
  "name",
  "script",
] as const;
const PARTIAL_JSON_STRING_FIELD_KEY_SET = new Set<string>(PARTIAL_JSON_STRING_FIELD_KEYS);

export function appendZCodeStreamingToolInputDelta(
  state: ZCodeStreamingToolInputState | undefined,
  delta: string,
): ZCodeStreamingToolInputState {
  return {
    ...state,
    deltaCount: (state?.deltaCount ?? 0) + 1,
    rawInput: `${state?.rawInput ?? ""}${delta}`,
  };
}

export function buildZCodeStreamingToolInputPreview(
  rawInput: string,
  completeInput?: unknown,
): ZCodeStreamingToolInputPreview {
  if (completeInput !== undefined) {
    return {
      complete: true,
      input: completeInput,
      rawInput,
    };
  }

  const parsed = parseCompleteJson(rawInput);
  if (parsed.ok) {
    return {
      complete: true,
      input: parsed.value,
      rawInput,
    };
  }

  return {
    complete: false,
    input: readPartialJsonObjectPreview(rawInput) ?? {},
    rawInput,
  };
}

export function shouldMaterializeZCodeStreamingToolInputPreview(
  state: ZCodeStreamingToolInputState,
  options: {
    mode?: ZCodeStreamingToolInputPreviewMode;
    now?: number;
    toolName?: string;
  } = {},
): boolean {
  if (options.mode === "background-summary") {
    return false;
  }
  const deltaCount = state.deltaCount ?? 0;
  if (deltaCount <= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_EAGER_DELTA_COUNT) {
    return true;
  }
  const lastPreviewAt = state.lastPreviewAt ?? 0;
  if (isZCodeFileStreamingToolInputPreviewTool(options.toolName)) {
    // 性能修复：Write/Edit 的半截 JSON 会触发全量内容恢复和行级 diff。
    // 大字节 chunk 不能绕过一秒窗口，否则模型输出越快，UI 反而更新越频繁。
    return (
      (options.now ?? Date.now()) - lastPreviewAt >=
      ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
    );
  }
  const lastPreviewRawInputLength = state.lastPreviewRawInputLength ?? 0;
  const rawGrowth = state.rawInput.length - lastPreviewRawInputLength;
  if (rawGrowth >= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH) {
    return true;
  }
  const intervalElapsed =
    (options.now ?? Date.now()) - lastPreviewAt >=
    ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS;
  if (!intervalElapsed) {
    return false;
  }
  // 性能修复：大 Write/Edit 参数通常会被 provider 以 4KB 左右的慢速 chunk 推送。
  // 若只按时间预算，active 任务仍会每个 chunk 解析累计 JSON；超过小输入范围后改由 raw growth 控制。
  return state.rawInput.length <= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_TIME_BUDGET_MAX_RAW_INPUT;
}

export function isZCodeFileStreamingToolInputPreviewTool(toolName?: string): boolean {
  const normalized = toolName?.trim().toLowerCase();
  return normalized === "write" || normalized === "edit";
}

export function markZCodeStreamingToolInputPreviewMaterialized(
  state: ZCodeStreamingToolInputState,
  now = Date.now(),
): void {
  state.lastPreviewAt = now;
  state.lastPreviewRawInputLength = state.rawInput.length;
}

function parseCompleteJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function readPartialJsonObjectPreview(rawInput: string): Record<string, string> | null {
  const preview: Record<string, string> = {};
  let index = skipJsonWhitespace(rawInput, 0);
  if (rawInput[index] !== "{") return null;
  index += 1;
  // 逐字段扫描顶层 object，避免嵌套路径外溢及每个白名单字段重复扫描整段大输入。
  while (index < rawInput.length) {
    index = skipJsonWhitespace(rawInput, index);
    if (rawInput[index] !== '"') break;
    const keyEnd = readJsonStringEnd(rawInput, index + 1);
    if (!keyEnd.closed) break;
    const key = decodeJsonStringSegment(rawInput.slice(index + 1, keyEnd.index), true);
    index = skipJsonWhitespace(rawInput, keyEnd.index + 1);
    if (rawInput[index] !== ":") break;
    index = skipJsonWhitespace(rawInput, index + 1);
    const known = PARTIAL_JSON_STRING_FIELD_KEY_SET.has(key);
    if (rawInput[index] === '"') {
      const valueEnd = readJsonStringEnd(rawInput, index + 1);
      if (known) {
        preview[key] = decodeJsonStringSegment(
          rawInput.slice(index + 1, valueEnd.index),
          valueEnd.closed,
        );
      }
      if (!valueEnd.closed) break;
      index = valueEnd.index + 1;
    } else {
      if (known && index < rawInput.length) delete preview[key];
      index = skipJsonValue(rawInput, index);
    }
    index = skipJsonWhitespace(rawInput, index);
    if (rawInput[index] !== ",") break;
    index += 1;
  }
  return Object.keys(preview).length > 0 ? preview : null;
}

function readJsonStringEnd(rawInput: string, start: number): { index: number; closed: boolean } {
  for (let index = start; index < rawInput.length; index += 1) {
    const char = rawInput[index];
    if (char === '"') {
      return { index, closed: true };
    }
    if (char === "\\") index += 1;
  }
  return { index: rawInput.length, closed: false };
}

function skipJsonWhitespace(rawInput: string, start: number): number {
  let index = start;
  while (
    rawInput[index] === " " ||
    rawInput[index] === "\t" ||
    rawInput[index] === "\r" ||
    rawInput[index] === "\n"
  )
    index += 1;
  return index;
}

function skipJsonValue(rawInput: string, start: number): number {
  let depth = 0;
  for (let index = start; index < rawInput.length; index += 1) {
    const char = rawInput[index];
    if (char === '"') {
      const end = readJsonStringEnd(rawInput, index + 1);
      if (!end.closed) return rawInput.length;
      index = end.index;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return index;
    }
  }
  return rawInput.length;
}

function decodeJsonStringSegment(encoded: string, closed: boolean): string {
  const normalized = closed ? encoded : trimDanglingJsonEscape(encoded);
  try {
    return JSON.parse(`"${normalized}"`) as string;
  } catch {
    return decodeJsonStringSegmentBestEffort(normalized);
  }
}

function trimDanglingJsonEscape(value: string): string {
  const tail = /\\(?:u[0-9a-fA-F]{0,3})?$/.exec(value);
  if (!tail) return value;
  let backslashes = 1;
  for (let index = tail.index - 1; value[index] === "\\"; index -= 1) backslashes += 1;
  // 偶数反斜杠已完成转义，尾部的字面 u12 不能被当作半截 Unicode 丢弃。
  return backslashes % 2 === 0 ? value : value.slice(0, tail.index);
}

function decodeJsonStringSegmentBestEffort(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}
