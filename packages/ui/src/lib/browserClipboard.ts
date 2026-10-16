export function isBrowserClipboardAvailable(): boolean {
  // 不安全上下文可能完全没有 Clipboard API；平台须据实际能力禁用菜单，而非点击后才报错。
  return (
    typeof navigator !== "undefined" &&
    (typeof navigator.clipboard?.writeText === "function" ||
      (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function"))
  );
}

/** 在用户点击的同步栈内提交写入；Safari 的用户激活不能跨历史读取的 await。 */
export async function writeBrowserClipboardText(text: string | Promise<string>): Promise<void> {
  if (!isBrowserClipboardAvailable()) throw new Error("clipboard_unavailable");
  if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
    const blob = Promise.resolve(text).then((value) => new Blob([value], { type: "text/plain" }));
    // 写入被浏览器提前拒绝时，它可能不再消费内容 Promise；读取失败仍须被收尾。
    void blob.catch(() => undefined);
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": blob,
      }),
    ]);
  } else {
    await navigator.clipboard.writeText(await text);
  }
}
