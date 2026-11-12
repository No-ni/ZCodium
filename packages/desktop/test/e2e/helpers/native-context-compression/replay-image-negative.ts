import { nativeContextReadImageToolSchema } from "@zcode/shared/native-context-compression";

export type NativeContextImageNegativeKind = "unsupported" | "capacity";
export const NATIVE_CONTEXT_IMAGE_NEGATIVE_REF_TOKEN = "{{nativeContextImageNegativeRef}}";
export const NATIVE_CONTEXT_IMAGE_NEGATIVE_CASES = {
  unsupported: {
    marker: "E2E_NCTX_IMAGE_UNSUPPORTED",
    inputPrefix: "E2E_NCTX_IMAGE_UNSUPPORTED_INPUT=",
    fixtureId: "native-image-unsupported-tool",
    toolCallId: "toolu_e2e_nctx_image_unsupported",
    inputTokens: 3700,
    outputTokens: 16,
  },
  capacity: {
    marker: "E2E_NCTX_IMAGE_CAPACITY",
    inputPrefix: "E2E_NCTX_IMAGE_CAPACITY_INPUT=",
    fixtureId: "native-image-capacity-tool",
    toolCallId: "toolu_e2e_nctx_image_capacity",
    inputTokens: 3800,
    outputTokens: 16,
  },
} as const;
export const NATIVE_CONTEXT_IMAGE_CAPACITY_SOURCE = {
  marker: "E2E_NCTX_IMAGE_CAPACITY_SOURCE",
  fixtureId: "native-image-capacity-source",
  inputTokens: 3750,
} as const;
export const NATIVE_CONTEXT_IMAGE_NEGATIVE_RECOVERY = {
  unsupported: {
    marker: "E2E_NCTX_IMAGE_UNSUPPORTED_RECOVERY",
    fixtureId: "native-image-unsupported-recovery",
    inputTokens: 3900,
  },
  capacity: {
    marker: "E2E_NCTX_IMAGE_CAPACITY_RECOVERY",
    fixtureId: "native-image-capacity-recovery",
    inputTokens: 3950,
  },
} as const;

export function buildNativeContextImageNegativePrompt(
  ref: string,
  kind: NativeContextImageNegativeKind,
): string {
  const fixture = NATIVE_CONTEXT_IMAGE_NEGATIVE_CASES[kind];
  const input = nativeContextReadImageToolSchema.parse({ ref });
  return [
    `${fixture.marker}: Call context_read_image exactly once for this current-session ref. Use no other tools.`,
    fixture.inputPrefix + JSON.stringify(input),
    "The original must retain its exact bytes. Do not substitute another Provider or a smaller image if it cannot be sent.",
  ].join("\n");
}

const rejected = () => new Error("E2E_NATIVE_CONTEXT_IMAGE_NEGATIVE_INPUT_REJECTED");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 仅这两个case-local tool fixture可展开；只解析真实最新用户输入，不从旧历史猜ref。 */
export function nativeContextImageNegativeReplayRef(request: unknown, fixtureId: string): string {
  const fixture = Object.values(NATIVE_CONTEXT_IMAGE_NEGATIVE_CASES).find(
    (item) => item.fixtureId === fixtureId,
  );
  if (
    !fixture ||
    !object(request) ||
    !Array.isArray(request.messages) ||
    !request.messages.length ||
    request.messages.length > 2000 ||
    !Array.isArray(request.tools) ||
    request.tools.length > 500 ||
    !request.tools.some((tool: unknown) => object(tool) && tool.name === "context_read_image")
  )
    throw rejected();
  const user = request.messages.findLast(
    (message: unknown) => object(message) && message.role === "user",
  );
  if (!object(user)) throw rejected();
  let text: string;
  if (typeof user.content === "string") text = user.content;
  else if (
    Array.isArray(user.content) &&
    user.content.every(
      (part: unknown) => object(part) && part.type === "text" && typeof part.text === "string",
    )
  )
    text = user.content.map((part: { text: string }) => part.text).join("\n");
  else throw rejected();
  if (!text || text.length > 64 * 1024) throw rejected();
  const lines = text.split("\n");
  if (lines.filter((line) => line.startsWith(fixture.marker + ":")).length !== 1) throw rejected();
  const inputs = lines.filter((line) => line.startsWith(fixture.inputPrefix));
  if (inputs.length !== 1) throw rejected();
  let value: unknown;
  try {
    value = JSON.parse(inputs[0]!.slice(fixture.inputPrefix.length));
  } catch {
    throw rejected();
  }
  const parsed = nativeContextReadImageToolSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.ref.trim() !== parsed.data.ref ||
    Array.from(parsed.data.ref).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    parsed.data.ref.includes("{{") ||
    parsed.data.ref.includes("}}")
  )
    throw rejected();
  return parsed.data.ref;
}
