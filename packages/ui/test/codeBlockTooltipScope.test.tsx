import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeBlock, CodeBlockHeader } from "../src/components/ai-elements/code-block.js";
import { CodeBlockTooltipScope } from "../src/components/ai-elements/code-block-tooltip-scope.js";
import { MessageResponse } from "../src/components/ai-elements/message.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

function renderBlock(grouped: boolean) {
  const block = (
    <CodeBlock codeView="snippet" code="const value = 1;" language="typescript">
      <CodeBlockHeader language="typescript" />
    </CodeBlock>
  );
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>
        {grouped ? <CodeBlockTooltipScope>{block}</CodeBlockTooltipScope> : block}
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

describe("code button tooltip ownership", () => {
  it("keeps both native buttons available without mounting a tooltip for every button", () => {
    const markup = renderBlock(true);
    expect(markup.match(/<button /g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).toContain('aria-label="Wrap lines"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain('data-slot="tooltip-trigger"');
    expect(markup).not.toContain("data-code-block-shared-hint-anchor");
  });

  it("preserves independent tooltips for CodeBlock callers outside a message scope", () => {
    const markup = renderBlock(false);
    expect(markup.match(/data-slot="tooltip-trigger"/g)).toHaveLength(2);
    expect(markup).toContain("const value = 1;");
  });

  it("preserves completed Markdown structures and literal code inside the scope", () => {
    const markdown =
      "# 中文\n\n> quote\n\n- item\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```text\n./src/**/*\n```\n\n$$a+b$$";
    const markup = renderToStaticMarkup(
      <ZCodeIntlProvider initialLocale="en-US">
        <TooltipProvider>
          <MessageResponse streaming={false}>{markdown}</MessageResponse>
        </TooltipProvider>
      </ZCodeIntlProvider>,
    );
    for (const tag of ["h1", "blockquote", "ul", "table"]) expect(markup).toContain(`<${tag}`);
    expect(markup).toContain("katex");
    expect(markup).toContain("./src/**/*");
    expect(markup.match(/data-code-snippet-source/g)).toHaveLength(1);
    // 表格自己的三个动作仍保留独立提示，作用域只接管代码按钮。
    expect(markup.match(/data-slot="tooltip-trigger"/g)).toHaveLength(3);
  });
});
