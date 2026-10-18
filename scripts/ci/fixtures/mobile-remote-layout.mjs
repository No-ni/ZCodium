import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function captureMobile(page, name, evidenceDir) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) });
}

export async function assertScrollable(page, message) {
  const layout = await page.getByRole("main").evaluate((node) => ({
    height: node.clientHeight,
    content: node.scrollHeight,
    overflow: getComputedStyle(node).overflowY,
    bottom: node.getBoundingClientRect().bottom,
    viewport: innerHeight,
  }));
  assert.ok(
    layout.height > 0 && layout.content > layout.height,
    `${message}: ${JSON.stringify(layout)}`,
  );
  assert.ok(
    ["auto", "scroll"].includes(layout.overflow),
    `${message}: overflow=${layout.overflow}`,
  );
  assert.ok(layout.bottom <= layout.viewport, `${message}: 不能延伸到视口外`);
}

export async function swipeUp(page) {
  const cdp = await page.context().newCDPSession(page);
  const box = await page.getByRole("main").boundingBox();
  const x = Math.round(box.x + box.width / 2);
  const startY = Math.round(Math.min(box.y + box.height - 30, 650));
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: startY }],
  });
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: startY - step * 40 }],
    });
    await page.waitForTimeout(20);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

export async function scrollToLast(page, lastText) {
  const box = await page.getByRole("main").boundingBox();
  let reachedEnd = false;
  for (let gesture = 0; gesture < 60; gesture++) {
    reachedEnd = await page
      .getByRole("main")
      .evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 2);
    if (reachedEnd) break;
    await swipeUp(page);
  }
  assert.ok(reachedEnd, "连续触摸滑动应能到达末尾");
  const last = await page.getByText(lastText, { exact: true }).boundingBox();
  assert.ok(last.y >= box.y && last.y + last.height <= box.y + box.height + 1, "末项必须完整可见");
}

export async function assertMobileConversationLayout(page, longText) {
  await assertScrollable(page, "长会话必须能够在输入栏上方滚动");
  const textLayout = await page.getByText(longText, { exact: true }).evaluate((node) => ({
    whiteSpace: getComputedStyle(node).whiteSpace,
    width: node.getBoundingClientRect().width,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  assert.equal(textLayout.whiteSpace, "pre-wrap", "消息必须保留换行");
  assert.ok(textLayout.scrollWidth <= textLayout.clientWidth + 1, "连续长文本应在气泡内换行");
  assert.ok(textLayout.width <= 390 * 0.85, "消息气泡必须约束在手机宽度内");
  await swipeUp(page);
  assert.ok(await page.getByRole("main").evaluate((node) => node.scrollTop > 0), "触摸应滚动会话");
  await scrollToLast(page, "历史正文 69");
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await assertScrollable(page, "窄屏/横屏下会话仍可滚动");
    const layout = await page.evaluate(() => {
      const input = document.querySelector("input");
      const main = document.querySelector("main").getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      return {
        fontSize: Number.parseFloat(getComputedStyle(input).fontSize),
        inputBottom: inputRect.bottom,
        mainBottom: main.bottom,
        inputTop: inputRect.top,
        width: document.documentElement.scrollWidth,
      };
    });
    assert.ok(layout.fontSize >= 16, "手机输入不能触发 iOS 小字体自动缩放");
    assert.ok(layout.inputBottom <= viewport.height, "输入框必须位于当前视口内");
    assert.ok(layout.mainBottom <= layout.inputTop, "输入栏不能覆盖消息区域");
    assert.ok(layout.width <= viewport.width, "手机页面不能横向溢出");
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

export const longText = `多行正文第一行\n第二行\n${"long-path-without-spaces/".repeat(80)}`;

export function createMobileMessages() {
  // smoke 将 fixture 直接作为 readSessionMessages 返回值，消息必须符合 CLI 协议形状。
  const messages = [
    {
      info: {
        messageId: "fixture-user",
        sessionId: "fixture-task",
        role: "user",
        agent: "fixture",
        time: { created: 1 },
      },
      parts: [
        {
          type: "text",
          text: "历史测试消息",
          messageId: "fixture-user",
          sessionId: "fixture-task",
          partId: "fixture-part",
        },
      ],
    },
  ];

  messages.push(
    ...Array.from({ length: 70 }, (_, index) => ({
      info: {
        messageId: `history-${index}`,
        sessionId: "fixture-task",
        role: "assistant",
        time: { created: index + 2 },
        parentMessageId: "fixture-user",
        agent: "fixture",
        path: { cwd: "/fixture", root: "/fixture" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          type: "text",
          text: index === 0 ? longText : `历史正文 ${index}`,
          messageId: `history-${index}`,
          sessionId: "fixture-task",
          partId: `history-part-${index}`,
        },
      ],
    })),
  );
  return messages;
}

export async function assertViewScrollIsolation(page) {
  await page.getByRole("button", { name: "返回任务首页" }).click();
  assert.equal(
    await page.getByRole("main").evaluate((node) => node.scrollTop),
    0,
    "返回首页不能继承会话滚动位置",
  );
  await page.getByRole("button", { name: /运行中的置顶任务/ }).click();
  await page.getByText("重连后的权威历史", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("main").evaluate((node) => node.scrollTop),
    0,
    "进入会话不能继承首页滚动位置",
  );
}
