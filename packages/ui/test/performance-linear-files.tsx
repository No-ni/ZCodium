import "@/styles.css";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";
import { renderFileChip, renderDiffCount } from "@/ToolCallBlocks/renderers.js";

function makeRaw(large: boolean, windows: boolean) {
  const root = windows ? "C:\\synthetic\\" : "/synthetic/";
  const path = `${root}first.ts`;
  return {
    content: [
      { type: "diff", path, oldText: "first-old", newText: "first-new" },
      { type: "diff", path, oldText: "ignored-old", newText: "ignored-new" },
      { type: "diff", path: `${root}中文.ts`, oldText: "before\n中文", newText: "after\n😀" },
      ...(large
        ? Array.from({ length: 2000 }, (_, index) => ({
            type: "diff",
            path: `${root}file-${index}.ts`,
            oldText: "before",
            newText: "after",
          }))
        : []),
    ],
    changes: { [path]: { type: "delete", oldText: "direct-old" } },
    rawInput: { changes: { [path]: { type: "add", newText: "input-new" } } },
    rawOutput: { changes: { [path]: { type: "update", newText: "output-new" } } },
  };
}

function Fixture() {
  const [large, setLarge] = useState(false);
  const [windows, setWindows] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [dark, setDark] = useState(false);
  const [patch, setPatch] = useState("");
  const summaries = useMemo(
    () =>
      readRawToolCallFileSummaries(makeRaw(large, windows), {
        toolName: readOnly ? "Read" : "Edit",
      }),
    [large, windows, readOnly],
  );
  return (
    <main
      className={`${dark ? "dark" : ""} h-full overflow-y-auto bg-background p-4 text-ui-base text-foreground`}
    >
      <h1 className="text-ui-xl">File-summary regression</h1>
      <div className="my-3 flex flex-wrap gap-2">
        <Button onClick={() => setLarge(!large)}>Toggle large batch</Button>
        <Button onClick={() => setWindows(!windows)}>Switch paths</Button>
        <Button onClick={() => setReadOnly(!readOnly)}>Toggle read-only tool</Button>
        <Button onClick={() => setDark(!dark)}>Toggle theme</Button>
      </div>
      <output aria-label="Summary count">{summaries.length}</output>
      <section
        aria-label="File summaries"
        className="my-3 grid gap-2 rounded-xl border border-border bg-card p-3"
      >
        {summaries.slice(0, 8).map((summary) => (
          <div key={summary.path} className="flex min-w-0 flex-wrap items-center gap-2">
            {renderFileChip({
              summary,
              clickable: true,
              onClick: () => setPatch(summary.patch ?? ""),
            })}
            <span>{summary.operationKind}</span>
            {renderDiffCount(summary.changeStat)}
          </div>
        ))}
      </section>
      <pre
        aria-label="Selected patch"
        className="overflow-x-auto rounded-xl border border-border bg-card p-3 font-mono"
      >
        {patch}
      </pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
