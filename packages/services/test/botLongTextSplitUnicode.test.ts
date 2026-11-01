import assert from "node:assert/strict";
import test from "node:test";
import type { BotConfig, BotOutboundMessage, SelectionPrompt } from "@zcode/shared";
import { createFeishuBotProvider } from "../src/bots/providers/feishuProvider.js";
import { createTelegramBotProvider } from "../src/bots/providers/telegramProvider.js";
import { extractBotAssistantResponseMessages } from "../src/bots/replyFormatter.js";

/**
 * Bot 长文本分片的 UTF-16 代理对回归（真实 provider.send 入口 + stub 全局 fetch）。
 *
 * Bug 原因：splitTelegramText（limit 3900）与 splitFeishuText（limit 1900）都是裸
 * 定长切片 text.slice(index, index + limit)。边界落在高低代理对中间时，前一块以
 * 孤立高位代理结尾、后一块以孤立低位代理开头，产出 ill-formed UTF-16 字符串；
 * JSON.stringify 只把孤立代理项转义为 \udXXX（转义而非替换，请求体里携带的仍是
 * ill-formed 文本）；接收端解码或显示时可能拒绝、替换或呈现乱码（U+FFFD 只是其中一种
 * 表现，不承诺必然发生），用户侧表现为两条各坏一个字符的消息（emoji 等非 BMP 字符）。Telegram 既有的“markdown 未闭合回退纯文本”
 * 不修复此项。
 *
 * 修复依据：游标循环 + 边界回退一格，让代理对整体进入下一块；只承诺分片顺序、单片
 * 上限、分片内容与既有空文本返回 [text] 的行为不变——边界退让可能使总片数比旧实现
 * 多一片，因此不断言总片数等于旧算法。
 *
 * 断言口径（与 spec 一致）：原本 well-formed 的输入不得产生新的孤立代理项；
 * 输入里原本就存在的孤立代理项必须原样保留，splitter 不做静默替换。
 *
 * 测试全程 hermetic：stub globalThis.fetch 捕获请求体并返回合成响应，
 * 不发出真实网络请求、不写文件系统、不使用真实用户数据；凭据经 loadCredential
 * stub 提供。Feishu 单行文本经 formatFeishuCardMarkdownContent 原样透传，
 * 因此卡片 markdown 元素内容即分片文本。
 */

const TELEGRAM_LIMIT = 3900;
const FEISHU_LIMIT = 1900;
const EMOJI = "\u{1F600}";
/** replyFormatter 的模块私有上限（splitLongReplyText 的 MAX_REPLY_MESSAGE_LENGTH）。 */
const MAX_REPLY_MESSAGE_LENGTH = 3500;

/** 旧实现的参考实现（差分基线）：优先换行/空格断点，否则硬切；逐片 trim。 */
function legacySplitLongReplyText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > MAX_REPLY_MESSAGE_LENGTH) {
    const breakpoint = Math.max(
      remaining.lastIndexOf("\n", MAX_REPLY_MESSAGE_LENGTH),
      remaining.lastIndexOf(" ", MAX_REPLY_MESSAGE_LENGTH),
    );
    const end = breakpoint > 0 ? breakpoint : MAX_REPLY_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function splitReply(text: string): string[] {
  return extractBotAssistantResponseMessages(text, true).messages;
}

interface CapturedRequest {
  url: string;
  body: string;
}

async function withCapturedFetch<T>(run: (requests: CapturedRequest[]) => Promise<T>): Promise<T> {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, body });
    const payload = url.includes("tenant_access_token")
      ? { code: 0, tenant_access_token: "synthetic-token", expire: 3600 }
      : { code: 0, msg: "ok", data: { message_id: "synthetic-message" } };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function telegramBot(): BotConfig {
  return {
    botId: "bot-telegram",
    provider: "telegram",
    credentialRef: "cred-telegram",
    enabled: true,
  } as unknown as BotConfig;
}

function feishuBot(): BotConfig {
  return {
    botId: "bot-feishu",
    provider: "feishu",
    credentialRef: "cred-feishu",
    feishuAppId: "cli_synthetic",
    enabled: true,
  } as unknown as BotConfig;
}

function outbound(text: string, provider: "telegram" | "feishu"): BotOutboundMessage {
  return {
    botId: `bot-${provider}`,
    provider,
    providerUserId: "user-synthetic",
    text,
  } as unknown as BotOutboundMessage;
}

async function sendTelegramText(text: string): Promise<string[]> {
  const provider = createTelegramBotProvider({ loadCredential: async () => "synthetic-token" });
  return withCapturedFetch(async (requests) => {
    await provider.send(telegramBot(), outbound(text, "telegram"));
    return requests
      .filter((request) => request.url.includes("api.telegram.org"))
      .map((request) => JSON.parse(request.body).text as string);
  });
}

async function sendFeishuText(text: string): Promise<string[]> {
  const provider = createFeishuBotProvider({ loadCredential: async () => "synthetic-secret" });
  return withCapturedFetch(async (requests) => {
    await provider.send(feishuBot(), outbound(text, "feishu"));
    return requests
      .filter((request) => request.url.includes("/open-apis/im/v1/messages"))
      .map((request) => {
        const body = JSON.parse(request.body) as { content: string };
        const card = JSON.parse(body.content) as {
          body: { elements: Array<{ tag: string; content?: string }> };
        };
        const markdown = card.body.elements.find((element) => element.tag === "markdown");
        return markdown?.content ?? "";
      });
  });
}

function loneSurrogateReports(chunks: string[]): string[] {
  const reports: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (/[\uD800-\uDBFF]$/u.test(chunk)) {
      reports.push(`chunk[${index}] 以孤立高位代理结尾`);
    }
    if (/^[\uDC00-\uDFFF]/u.test(chunk)) {
      reports.push(`chunk[${index}] 以孤立低位代理开头`);
    }
  }
  return reports;
}

test("telegram：代理对落在分片边界时整体进入下一块", async () => {
  const text = `${"a".repeat(TELEGRAM_LIMIT - 1)}${EMOJI}${"b".repeat(10)}`;
  const chunks = await sendTelegramText(text);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [TELEGRAM_LIMIT - 1, 12],
  );
  assert.deepEqual(loneSurrogateReports(chunks), []);
  assert.equal(chunks.join(""), text, "分片拼接必须回原文本");
});

test("telegram：第一处边界回退后第二处边界保持旧行为", async () => {
  const text = `${"a".repeat(TELEGRAM_LIMIT - 1)}${EMOJI}${"b".repeat(TELEGRAM_LIMIT - 1)}${EMOJI}${"b".repeat(10)}`;
  const chunks = await sendTelegramText(text);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [TELEGRAM_LIMIT - 1, TELEGRAM_LIMIT, 13],
  );
  assert.deepEqual(loneSurrogateReports(chunks), []);
  assert.equal(chunks.join(""), text);
});

test("telegram：代理对落在第二处边界时同样整体进入下一块", async () => {
  const text = `${"a".repeat(TELEGRAM_LIMIT)}${EMOJI}${"b".repeat(TELEGRAM_LIMIT - 3)}${EMOJI}${"b".repeat(10)}`;
  const chunks = await sendTelegramText(text);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [TELEGRAM_LIMIT, TELEGRAM_LIMIT - 1, 12],
  );
  assert.deepEqual(loneSurrogateReports(chunks), []);
  assert.equal(chunks.join(""), text);
});

test("telegram：非边界场景分片与旧行为一致", async () => {
  const midText = `${"a".repeat(1000)}${EMOJI}${"b".repeat(1000)}`;
  assert.deepEqual(await sendTelegramText(midText), [midText]);
  const exactText = "a".repeat(TELEGRAM_LIMIT);
  assert.deepEqual(await sendTelegramText(exactText), [exactText]);
  const allEmoji = EMOJI.repeat(2000);
  const emojiChunks = await sendTelegramText(allEmoji);
  assert.deepEqual(
    emojiChunks.map((chunk) => chunk.length),
    [TELEGRAM_LIMIT, 100],
  );
  assert.deepEqual(loneSurrogateReports(emojiChunks), []);
  assert.equal(emojiChunks.join(""), allEmoji);
});

test("telegram：空文本仍返回单块", async () => {
  assert.deepEqual(await sendTelegramText(""), [""]);
});

test("telegram：输入原本含孤立代理项时原样保留", async () => {
  const text = `head\uD83Dtail`;
  const chunks = await sendTelegramText(text);
  assert.deepEqual(chunks, [text], "既有孤立代理项必须原样保留，不做静默替换");
  assert.equal(chunks.join(""), text);
});

test("feishu：代理对落在分片边界时整体进入下一块", async () => {
  const text = `${"a".repeat(FEISHU_LIMIT - 1)}${EMOJI}${"b".repeat(10)}`;
  const chunks = await sendFeishuText(text);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [FEISHU_LIMIT - 1, 12],
  );
  assert.deepEqual(loneSurrogateReports(chunks), []);
  assert.equal(chunks.join(""), text, "卡片 markdown 文本拼接必须回原文本");
});

test("feishu：代理对落在第二处边界时同样整体进入下一块", async () => {
  const text = `${"a".repeat(FEISHU_LIMIT)}${EMOJI}${"b".repeat(FEISHU_LIMIT - 3)}${EMOJI}${"b".repeat(10)}`;
  const chunks = await sendFeishuText(text);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [FEISHU_LIMIT, FEISHU_LIMIT - 1, 12],
  );
  assert.deepEqual(loneSurrogateReports(chunks), []);
  assert.equal(chunks.join(""), text);
});

test("feishu：纯 BMP 长文本分片与旧行为一致", async () => {
  const text = "b".repeat(4000);
  const chunks = await sendFeishuText(text);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [FEISHU_LIMIT, FEISHU_LIMIT, 200],
  );
  assert.equal(chunks.join(""), text);
});

test("feishu：空文本仍返回单块", async () => {
  assert.deepEqual(await sendFeishuText(""), [""]);
});

test("feishu：输入原本含孤立代理项时原样保留", async () => {
  const text = `head\uD83Dtail`;
  const chunks = await sendFeishuText(text);
  assert.deepEqual(chunks, [text], "既有孤立代理项必须原样保留，不做静默替换");
  assert.equal(chunks.join(""), text);
});

test("telegram：长文本分片后按钮只挂在最后一片", async () => {
  const provider = createTelegramBotProvider({ loadCredential: async () => "synthetic-token" });
  const selection: SelectionPrompt = {
    id: "sel-model",
    title: "Choose model",
    action: "model.set",
    options: [{ id: "model-a", label: "Model A" }],
    showCancel: true,
  };
  await withCapturedFetch(async (requests) => {
    await provider.send(telegramBot(), {
      ...outbound("a".repeat(4000), "telegram"),
      selection,
    } as unknown as BotOutboundMessage);
    const telegramRequests = requests.filter((request) => request.url.includes("api.telegram.org"));
    assert.equal(telegramRequests.length, 2, "4000 字符应分 2 片");
    const bodies = telegramRequests.map(
      (request) => JSON.parse(request.body) as Record<string, unknown>,
    );
    assert.equal(bodies[0]?.reply_markup, undefined, "按钮不得挂在尚未发送完整正文的第一片");
    assert.notEqual(bodies[1]?.reply_markup, undefined, "按钮必须跟随最终决策上下文（最后一片）");
  });
});

test("splitLongReplyText：硬切边界代理对整体进入下一片", () => {
  const text = `${"a".repeat(MAX_REPLY_MESSAGE_LENGTH - 1)}${EMOJI}${"b".repeat(10)}`;
  const chunks = splitReply(text);
  assert.deepEqual(chunks, ["a".repeat(MAX_REPLY_MESSAGE_LENGTH - 1), `${EMOJI}${"b".repeat(10)}`]);
  assert.deepEqual(loneSurrogateReports(chunks), []);
});

test("splitLongReplyText：纯 BMP 输入与旧算法逐字节一致", () => {
  const withNewlines = `${"line of words here\n".repeat(300)}${"tail ".repeat(50)}`;
  const withSpaces = "word ".repeat(1200);
  const hardCut = "z".repeat(8000);
  const exactLimit = "q".repeat(MAX_REPLY_MESSAGE_LENGTH);
  const oneOverLimit = `${"q".repeat(MAX_REPLY_MESSAGE_LENGTH)}w`;
  for (const text of [withNewlines, withSpaces, hardCut, exactLimit, oneOverLimit]) {
    assert.deepEqual(splitReply(text), legacySplitLongReplyText(text), "纯 BMP 必须保持旧输出");
  }
});

test("splitLongReplyText：既有孤立代理项原样保留", () => {
  const text = `head\uD83Dtail`;
  assert.deepEqual(splitReply(text), [text], "既有孤立代理项必须原样保留，不做静默替换");
});

test("splitLongReplyText：空串返回空分片列表", () => {
  assert.deepEqual(splitReply(""), []);
});
