import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Collapsible, CollapsibleContent } from "./collapsible.js";

const require = createRequire(import.meta.url);

describe("Collapsible measurement and animation contract", () => {
  it("guards hidden geometry reads in both dependency entrypoints", async () => {
    const entry = require.resolve("@radix-ui/react-collapsible");
    for (const path of [entry, entry.replace(/index\.js$/, "index.mjs")]) {
      const source = await readFile(path, "utf8");
      expect(source.indexOf("if (node.hidden)")).toBeGreaterThan(0);
      expect(source.indexOf("if (node.hidden)")).toBeLessThan(
        source.indexOf("node.getBoundingClientRect()"),
      );
    }
  });
  it("preserves the existing height animation, transition guard and content", () => {
    const markup = renderToStaticMarkup(
      <Collapsible open>
        <CollapsibleContent>Details</CollapsibleContent>
      </Collapsible>,
    );
    expect(markup).toContain("transition-none");
    expect(markup).toContain("animate-collapsible-down");
    expect(markup).toContain("fade-in-0");
    expect(markup).toContain("Details");
  });
});
