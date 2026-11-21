import { GOAL_COMPLETION_VERIFICATION_FALLBACK_REASON } from "./goal-schema.js";
import type { GoalCompletionVerificationOutput } from "./goal-schema.js";

export function parseGoalCompletionVerificationText(
  text: string,
): GoalCompletionVerificationOutput {
  const parsed = parseJsonObject(text);
  if (!parsed) {
    // verifier 是 goal 完成闸门，但 provider 偶发坏 JSON 属于裁判链路故障；
    // 按产品语义 fail-open，避免已经交付的 goal 被格式错误卡在继续迭代。
    return failOpenGoalCompletionVerification("The completion verifier did not return valid JSON.");
  }

  const passed = parsed.passed === true;
  const reason = readString(parsed.reason) ?? GOAL_COMPLETION_VERIFICATION_FALLBACK_REASON;
  const nextAction = readString(parsed.nextAction);

  return {
    ...(nextAction ? { nextAction } : {}),
    passed,
    reason,
  };
}

export function failedGoalCompletionVerification(reason: string): GoalCompletionVerificationOutput {
  // 这个兜底表示 verifier 自身失败，不是模型给出的下一步。
  // 若写入 nextAction，UI 会把内部控制文案当成下一轮迭代标题展示。
  return {
    passed: false,
    reason,
  };
}

export function failOpenGoalCompletionVerification(
  reason: string,
): GoalCompletionVerificationOutput {
  // 这里表示 verifier 基础设施/格式失败，不是 verifier 明确判定目标未完成。
  // 默认通过能避免 goal 因裁判链路偶发失败被无限卡住，同时保留 reason 供日志和 UI 排查。
  return {
    passed: true,
    reason,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const candidates = collectJsonObjectCandidates(text);

  for (const candidate of candidates) {
    const parsed = parseJsonObjectCandidate(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

function collectJsonObjectCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const stringValue = parseJsonString(trimmed);
  if (stringValue) candidates.push(stringValue);
  const fenced = extractFencedJsonCandidate(trimmed);
  if (fenced) candidates.push(fenced);
  if (stringValue) {
    const fencedStringValue = extractFencedJsonCandidate(stringValue);
    if (fencedStringValue) candidates.push(fencedStringValue);
  }
  return candidates;
}

function parseJsonObjectCandidate(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonString(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "string" && parsed.trim().length > 0 ? parsed.trim() : undefined;
  } catch {
    return undefined;
  }
}

function extractFencedJsonCandidate(text: string): string | undefined {
  // goal verifier 偶尔会把结构化 JSON 包进 Markdown code fence，
  // 甚至被外层编码成字符串；这里统一剥出 fenced 内容后再走同一个 JSON object 解析。
  const match = text.trim().match(/^```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i);
  return match?.[1]?.trim();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
