"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { BundledTheme } from "shiki";
import {
  highlightCode,
  shouldUseSyntaxHighlighting,
  type TokenizedCode,
} from "@/lib/shikiHighlighter.js";
import { observeCodeSnippetVisibility } from "./codeSnippetVisibility.js";

interface CodeSnippetProps {
  code: string;
  language: string;
  enableSyntaxHighlighting: boolean;
  theme?: BundledTheme;
  wrapLongLines: boolean;
  fontSizePx: number;
}

const MAX_HIGHLIGHT_CHARS = 20_000;
const MAX_HIGHLIGHT_TOKENS = 10_000;

/** Markdown 只读代码展示；文件行交互由 CodeViewer 承担。 */
export function CodeSnippet({
  code,
  language,
  enableSyntaxHighlighting,
  theme,
  wrapLongLines,
  fontSizePx,
}: CodeSnippetProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [highlight, setHighlight] = useState<{
    code: string;
    language: string;
    theme?: BundledTheme;
    result: TokenizedCode;
  } | null>(null);
  const canHighlight =
    enableSyntaxHighlighting &&
    visible &&
    code.length <= MAX_HIGHLIGHT_CHARS &&
    shouldUseSyntaxHighlighting(language);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return observeCodeSnippetVisibility(root, setVisible);
  }, []);

  useEffect(() => {
    setHighlight(null);
    if (!canHighlight) return;

    let cancelled = false;
    const accept = (result: TokenizedCode) => {
      // 围栏在流式/终态或历史窗口变化时可能卸载；旧结果不能写入新版本。
      if (
        !cancelled &&
        result.tokens.reduce((count, line) => count + line.length, 0) <= MAX_HIGHLIGHT_TOKENS
      ) {
        setHighlight({ code, language, theme, result });
      }
    };
    // 缓存命中也由入口的微任务通知，避免同一结果同步/异步各提交一次。
    highlightCode(code, language, theme, accept);
    return () => {
      cancelled = true;
    };
  }, [canHighlight, code, language, theme]);

  const result =
    canHighlight &&
    highlight?.code === code &&
    highlight.language === language &&
    highlight.theme === theme
      ? highlight.result
      : null;
  const textStyle: CSSProperties = {
    margin: 0,
    font: "inherit",
    whiteSpace: wrapLongLines ? "pre-wrap" : "pre",
    overflowWrap: wrapLongLines ? "anywhere" : "normal",
    tabSize: 4,
  };

  return (
    <div
      ref={rootRef}
      data-code-snippet
      className="overflow-x-auto font-mono text-foreground"
      style={{ fontSize: fontSizePx, lineHeight: "1.5" }}
    >
      <div className="relative" style={{ minWidth: wrapLongLines ? undefined : "max-content" }}>
        {result ? (
          <pre
            key="highlight"
            inert
            aria-hidden="true"
            data-code-snippet-highlight
            data-conversation-find-ignore="true"
            className="pointer-events-none absolute inset-0 select-none"
            style={{ ...textStyle, color: result.fg }}
          >
            {result.tokens.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 ? "\n" : null}
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))}
              </span>
            ))}
          </pre>
        ) : null}
        {/* 原因：异步 token 替换原文会使查找 Range/selection 失效；只叠加视觉层，原文节点始终不动。 */}
        <pre
          key="source"
          className="relative selection:text-foreground"
          style={{ ...textStyle, color: result ? "transparent" : undefined }}
        >
          <code data-code-snippet-source style={{ font: "inherit" }}>
            {code}
          </code>
        </pre>
      </div>
    </div>
  );
}
