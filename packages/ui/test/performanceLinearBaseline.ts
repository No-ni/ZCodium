import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import ts from "typescript";

export async function loadLinearBaseline<T>(
  file: string,
  dependencies: Record<string, unknown>,
): Promise<T> {
  const [source, manifestText] = await Promise.all([
    readFile(new URL(`./fixtures/performance-linear-baseline/${file}`, import.meta.url), "utf8"),
    readFile(
      new URL("./fixtures/performance-linear-baseline/manifest.json", import.meta.url),
      "utf8",
    ),
  ]);
  const manifest = JSON.parse(manifestText) as {
    sources: Array<{ name: string; sha256: string }>;
  };
  const expected = manifest.sources.find((entry) => entry.name === file)?.sha256;
  if (createHash("sha256").update(source).digest("hex") !== expected) {
    throw new Error(`Changed linear-hotpath reference: ${file}`);
  }
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)((id: string) => {
    if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected reference import: ${id}`);
    return dependencies[id];
  }, exports);
  return exports as T;
}

export function freezeLinearInput(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeLinearInput);
    Object.freeze(value);
  }
}

export function linearRandom(seed: number): (limit: number) => number {
  let state = seed;
  return (limit) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
}

export function measureLinearHotpath(name: string, before: () => unknown, after: () => unknown) {
  const sample = (action: () => unknown) => {
    const start = performance.now();
    action();
    return performance.now() - start;
  };
  for (let index = 0; index < 4; index++) {
    before();
    after();
  }
  const beforeTimes: number[] = [];
  const afterTimes: number[] = [];
  for (let index = 0; index < 15; index++) {
    if (index % 2) {
      afterTimes.push(sample(after));
      beforeTimes.push(sample(before));
    } else {
      beforeTimes.push(sample(before));
      afterTimes.push(sample(after));
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[7]!;
  return { name, beforeMs: median(beforeTimes), afterMs: median(afterTimes), samples: 15 };
}
