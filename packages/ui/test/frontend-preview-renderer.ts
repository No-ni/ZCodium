// 浏览器回归只控制解析完成顺序；实际 DOM 提交、链接净化与回调来自生产 DOCX 组件。
const requests: Array<{ body: HTMLElement; className: string; finish: () => void }> = [];

export const frontendPreviewRenderer = {
  get renderCount() {
    return requests.length;
  },
  complete(index: number, label: string) {
    const request = requests[index];
    if (!request) throw new Error(`Missing DOCX render request: ${index}`);
    const wrapper = document.createElement("div");
    wrapper.className = `${request.className}-wrapper`;
    const page = document.createElement("section");
    page.className = request.className;
    page.style.width = "600px";
    page.style.height = "300px";
    const text = document.createElement("p");
    text.dataset.frontendDocxContent = "";
    text.textContent = label;
    const link = document.createElement("a");
    link.href = "https://example.com/docx";
    link.textContent = "Document link";
    page.append(text, link);
    wrapper.append(page);
    request.body.append(wrapper);
    request.finish();
  },
};

export function renderAsync(
  _buffer: ArrayBuffer,
  body: HTMLElement,
  _styles: HTMLElement,
  options: { className: string },
) {
  return new Promise<void>((finish) => {
    requests.push({ body, className: options.className, finish });
  });
}
