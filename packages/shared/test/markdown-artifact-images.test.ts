import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  decodeMarkdownArtifactImageSource,
  extractMarkdownArtifactImageRefs,
  rewriteMarkdownArtifactImageSources,
} from "../src/markdown-artifact-images.js";

const ref = "zcode-artifact://share/image.png";
const rendered = "/__zcode_artifact_image__/" + encodeURIComponent(ref);

test("重复引用出现在 alt 时只改图片目标", () => {
  assert.equal(rewriteMarkdownArtifactImageSources(`![${ref}](${ref})`), `![${ref}](${rendered})`);
});

test("alt 中以目标开头的较长文本也保持原样", () => {
  assert.equal(
    rewriteMarkdownArtifactImageSources(`![${ref}.backup](${ref})`),
    `![${ref}.backup](${rendered})`,
  );
});

test("尖括号、空白和 title 中重复引用保持原样", () => {
  assert.equal(
    rewriteMarkdownArtifactImageSources(`![${ref}](  <${ref}> "${ref}"  )`),
    `![${ref}](  <${rendered}> "${ref}"  )`,
  );
});

test("普通图片转换不改变 title", () => {
  assert.equal(
    rewriteMarkdownArtifactImageSources(`![preview](${ref} 'title')`),
    `![preview](${rendered} 'title')`,
  );
});

test("引用按首次出现顺序去重且忽略围栏", () => {
  const other = "zcode-artifact://share/other.png";
  const markdown = [
    `![a](${other}) ![b](${ref})`,
    "~~~md",
    "![c](zcode-artifact://hidden.png)",
    "~~~",
    `![d](${other})`,
  ].join("\n");
  assert.deepEqual(extractMarkdownArtifactImageRefs(markdown), [other, ref]);
});

test("CRLF 反引号围栏原样保留且只转换围栏外引用", () => {
  const block = ["```md", `![code](${ref})`, "```", ""].join("\r\n");
  assert.equal(
    rewriteMarkdownArtifactImageSources(block + `![visible](${ref})`),
    block + `![visible](${rendered})`,
  );
});

test("CRLF 波浪号围栏内引用不提取也不改写", () => {
  const hidden = "zcode-artifact://share/hidden.png";
  const block = ["~~~md", `![code](${hidden})`, "~~~", ""].join("\r\n");
  const markdown = block + `![visible](${ref})`;
  assert.equal(rewriteMarkdownArtifactImageSources(markdown), block + `![visible](${rendered})`);
  assert.deepEqual(extractMarkdownArtifactImageRefs(markdown), [ref]);
});

test("不足长度或带内容的围栏不能提前结束代码块", () => {
  const block = ["~~~~", "~~~", "~~~~ text", `![code](${ref})`, "~~~~"].join("\n");
  assert.equal(rewriteMarkdownArtifactImageSources(block), block);
  assert.deepEqual(extractMarkdownArtifactImageRefs(block), []);
});

test("普通链接和外部图片不改写", () => {
  const markdown = `[link](${ref}) ![external](https://example.invalid/image.png)`;
  assert.equal(rewriteMarkdownArtifactImageSources(markdown), markdown);
  assert.deepEqual(extractMarkdownArtifactImageRefs(markdown), []);
});

test("解码 round-trip 与损坏输入保持原有语义", () => {
  assert.equal(decodeMarkdownArtifactImageSource(rendered), ref);
  for (const value of [
    ref,
    "/__zcode_artifact_image__/%",
    "/__zcode_artifact_image__/https%3A%2F%2Fexample.invalid",
  ]) {
    assert.equal(decodeMarkdownArtifactImageSource(value), null);
  }
});

test("无协议标记的大文本不分配逐行 split 数组", () => {
  const markdown = "普通文本 ![external](https://example.invalid/image.png)\n".repeat(20_000);
  const original = String.prototype.split;
  let splits = 0;
  const spy = mock.method(
    String.prototype,
    "split",
    function (this: string, ...args: Parameters<typeof original>) {
      if (String(this) === markdown) splits++;
      return Reflect.apply(original, this, args);
    },
  );
  try {
    assert.equal(rewriteMarkdownArtifactImageSources(markdown), markdown);
    assert.deepEqual(extractMarkdownArtifactImageRefs(markdown), []);
  } finally {
    spy.mock.restore();
  }
  assert.equal(splits, 0, "无 artifact 引用时不进入逐行扫描");
});
