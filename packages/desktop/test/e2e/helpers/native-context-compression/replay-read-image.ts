import { nativeContextReadImageToolSchema } from "@zcode/shared/native-context-compression";

export const NATIVE_CONTEXT_READ_IMAGE_MARKER = "E2E_NCTX_READ_ORIGINAL";
export const NATIVE_CONTEXT_READ_IMAGE_INPUT_PREFIX = "E2E_NCTX_READ_ORIGINAL_INPUT=";
export const NATIVE_CONTEXT_READ_IMAGE_REF_TOKEN = "{{nativeContextReadImageRef}}";
export const NATIVE_CONTEXT_READ_IMAGE_REPLAY = {
  toolFixtureId: "native-read-original-tool",
  resultFixtureId: "native-read-original-main",
  toolCallId: "toolu_e2e_nctx_read_original",
  toolResponse: {
    statusCode: 200,
    toolUse: {
      id: "toolu_e2e_nctx_read_original",
      messageId: "native-read-original-tool",
      name: "context_read_image",
      input: { ref: NATIVE_CONTEXT_READ_IMAGE_REF_TOKEN },
      inputTokens: 3600,
      outputTokens: 16,
    },
  },
  resultResponse: {
    statusCode: 200,
    text: {
      id: "native-read-original-main",
      inputTokens: 3650,
      outputTokens: 12,
      text: "upstream-e2e-ok",
    },
  },
} as const;

const rejected = () => new Error("E2E_NATIVE_CONTEXT_READ_IMAGE_INPUT_REJECTED");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function buildNativeContextReadImagePrompt(ref: string): string {
  const input = nativeContextReadImageToolSchema.parse({ ref });
  return [
    `${NATIVE_CONTEXT_READ_IMAGE_MARKER}: Call context_read_image exactly once for this current-session image.`,
    NATIVE_CONTEXT_READ_IMAGE_INPUT_PREFIX + JSON.stringify(input),
    'After receiving the original image, reply with exactly "upstream-e2e-ok" and no other text. Use no other tools.',
  ].join("\n");
}

/** Only the exact case-local tool fixture may use this variable; Runtime proves ref ownership. */
export function nativeContextReadImageReplayRef(request: unknown): string {
  if (
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
  if (lines.filter((line) => line.startsWith(NATIVE_CONTEXT_READ_IMAGE_MARKER + ":")).length !== 1)
    throw rejected();
  const inputs = lines.filter((line) => line.startsWith(NATIVE_CONTEXT_READ_IMAGE_INPUT_PREFIX));
  if (inputs.length !== 1) throw rejected();
  let value: unknown;
  try {
    value = JSON.parse(inputs[0]!.slice(NATIVE_CONTEXT_READ_IMAGE_INPUT_PREFIX.length));
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
