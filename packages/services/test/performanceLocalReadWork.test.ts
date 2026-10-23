import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as shared from "@zcode/shared";
import type { ZCodePersistedFileChange, ZCodeSessionFile } from "@zcode/shared";
import { ProviderConfigMap } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "../../provider-node/src/provider-config-file-codec.js";
import { buildPerTurnChangeSummaries } from "../src/session/taskChangeSummary.js";
import { readLatestAssistantTurnChangeSummary } from "../src/bots/statusFormatting.js";

afterEach(() => vi.restoreAllMocks());

function snapshot(
  fileChanges: ZCodeSessionFile["fileChanges"],
  messages: Array<{ role: "assistant" | "user"; turnIndex?: number }>,
): ZCodeSessionFile {
  // 测试只驱动同步读取投影，不伪造 TaskService/CLI 的状态或 IO。
  return { fileChanges, messages } as unknown as ZCodeSessionFile;
}

function turn(
  turnIndex: number,
  path: string,
  beforeContent: string | null = "before\n",
  afterContent = "after\n",
  writeCount = 1,
): ZCodePersistedFileChange {
  return { turnIndex, snapshots: [{ path, beforeContent, afterContent, writeCount }] };
}

function oldSummary(input: ZCodeSessionFile | null) {
  if (!input?.fileChanges?.length) return null;
  const index = input.messages.findLast(
    (message) => message.role === "assistant" && message.turnIndex !== undefined,
  )?.turnIndex;
  if (index === undefined) return null;
  const result = buildPerTurnChangeSummaries(input.fileChanges).get(index) ?? null;
  return result && result.fileCount > 0 && result.files.length > 0 ? result : null;
}

describe("Bot latest-turn projection avoids unused historical diffs", () => {
  it("keeps last nonempty duplicate turn, same-path aggregation and path order", () => {
    const input = snapshot(
      [
        turn(7, "old"),
        turn(2, "unrelated"),
        {
          turnIndex: 7,
          snapshots: [
            { path: "z", beforeContent: "old\n", afterContent: "middle\n", writeCount: 2 },
            { path: "a", beforeContent: null, afterContent: "new\n", writeCount: 1 },
            { path: "z", beforeContent: "middle\n", afterContent: "new\nextra\n", writeCount: 3 },
          ],
        },
        { turnIndex: 7, snapshots: [] },
        turn(9, "not-the-latest-assistant"),
      ],
      [{ role: "assistant", turnIndex: 7 }, { role: "user", turnIndex: 9 }, { role: "assistant" }],
    );
    const before = structuredClone(input);
    const result = readLatestAssistantTurnChangeSummary(input);
    expect(result).toEqual({
      fileCount: 2,
      added: 3,
      removed: 1,
      files: [
        { path: "a", added: 1, removed: 0, writeCount: 1, lastTurnIndex: 7 },
        { path: "z", added: 2, removed: 1, writeCount: 5, lastTurnIndex: 7 },
      ],
    });
    expect(result).toEqual(oldSummary(input));
    expect(input).toEqual(before);
  });

  it("matches the original full-history algorithm for 500 deterministic snapshots", () => {
    let seed = 71;
    const random = (size: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % size;
    };
    for (let index = 0; index < 500; index++) {
      const input = snapshot(
        Array.from({ length: random(40) }, () => ({
          turnIndex: random(8),
          snapshots: Array.from({ length: random(5) }, () => ({
            path: ["a", "A", "中文", "😀"][random(4)]!,
            beforeContent: random(3) === 0 ? null : "a\nb\nc\n",
            afterContent: `a\n${random(4)}\nc\n`,
            writeCount: random(4) + 1,
          })),
        })),
        Array.from({ length: random(20) }, () => ({
          role: random(3) === 0 ? "user" : "assistant",
          ...(random(5) === 0 ? {} : { turnIndex: random(8) }),
        })),
      );
      const before = structuredClone(input);
      expect(readLatestAssistantTurnChangeSummary(input)).toEqual(oldSummary(input));
      expect(input).toEqual(before);
    }
    for (const input of [
      null,
      snapshot(undefined, []),
      snapshot([], []),
      snapshot([turn(1, "a")], []),
    ]) {
      expect(readLatestAssistantTurnChangeSummary(input)).toBeNull();
    }
  });

  it("does no diff for an unmatched or empty target, and keeps original LCS fallbacks", () => {
    const input = snapshot(
      [turn(0, "historical"), { turnIndex: 1, snapshots: [] }],
      [{ role: "assistant", turnIndex: 1 }],
    );
    const count = vi.spyOn(shared, "computeLineChangeStat");
    expect(readLatestAssistantTurnChangeSummary(input)).toBeNull();
    input.messages[0]!.turnIndex = 9;
    expect(readLatestAssistantTurnChangeSummary(input)).toBeNull();
    expect(count).not.toHaveBeenCalled();
    count.mockRestore();
    const long = Array.from({ length: 700 }, (_, index) => `old ${index}`).join("\n");
    for (const change of [
      turn(1, "identical", "same\n", "same\n"),
      turn(1, "large", long, long.replaceAll("old", "new")),
      turn(1, "deleted", "a\nb\n", ""),
    ]) {
      const target = snapshot(
        [turn(0, "historical"), change],
        [{ role: "assistant", turnIndex: 1 }],
      );
      expect(readLatestAssistantTurnChangeSummary(target)).toEqual(oldSummary(target));
    }
  });

  it("does one 500-by-500-line diff rather than 100 unused historical diffs", () => {
    const before = Array.from({ length: 500 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 500 }, (_, index) => `new ${index}`).join("\n");
    const input = snapshot(
      Array.from({ length: 100 }, (_, index) => turn(index, "file", before, after)),
      [{ role: "assistant", turnIndex: 99 }],
    );
    const count = vi.spyOn(shared, "computeLineChangeStat");
    const result = readLatestAssistantTurnChangeSummary(input);
    expect(result).toEqual({
      fileCount: 1,
      added: 500,
      removed: 500,
      files: [{ path: "file", added: 500, removed: 500, writeCount: 1, lastTurnIndex: 99 }],
    });
    expect(count).toHaveBeenCalledTimes(1);
  });
});

function personalDocument(count = 1) {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: Array.from({ length: count }, (_, index) => `fixture-${index}`),
      providerConfigRules: {
        providerRules: Array.from({ length: count }, (_, index) => ({
          providerId: `fixture-${index}`,
          providerName: `Fixture ${index}`,
          config: {
            group: "standard-personal",
            personalModelIds: ["模型", "Model", "😀"],
            modelOrder: ["😀", "Model", "模型"],
          },
        })),
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: "fixture-0", modelId: "Model" },
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zcodium-local-read-work-"));
  const filePath = join(directory, "personal.json");
  const recoveries: unknown[] = [];
  const repository = new NodePersonalProviderConfigRepository({
    filePath,
    pollingIntervalMs: false,
    onRecovery: (event) => recoveries.push(event),
  });
  return {
    filePath,
    repository,
    recoveries,
    async dispose() {
      repository.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function revision(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

describe("Personal read reuses only its own canonical JSON for revision", () => {
  it("encodes the same decoded config once per canonical read, without caching the file", async () => {
    const f = await fixture();
    try {
      const update = decodeProviderConfigFile(personalDocument(256));
      const encoded = encodeProviderConfigFile(update);
      const content = JSON.stringify(encoded);
      await writeFile(f.filePath, JSON.stringify(encoded, null, 2));
      const encode = vi.spyOn(ProviderConfigMap.prototype, "toJSON");
      const stringify = vi.spyOn(JSON, "stringify");
      const first = await f.repository.read();
      const jsonCalls = stringify.mock.calls.filter(
        ([value]) => typeof value === "object" && value !== null && "schemaVersion" in value,
      ).length;
      expect(first.revision).toBe(revision(content));
      expect(first.providerOrder).toEqual(update.providerOrder);
      expect(first.defaultModelSelection).toEqual(update.defaultModelSelection);
      expect({ encodings: encode.mock.calls.length, serializations: jsonCalls }).toEqual({
        encodings: 1,
        serializations: 2,
      });
      encode.mockClear();
      stringify.mockClear();
      const next = await f.repository.read();
      expect(next.revision).toBe(first.revision);
      expect(next).not.toBe(first);
      expect(encode).toHaveBeenCalledTimes(1);
      encode.mockRestore();
      stringify.mockRestore();
      const edited = personalDocument();
      edited.config.providerConfigRules.providerRules[0]!.providerName = "Updated 中文";
      const changed = encodeProviderConfigFile(decodeProviderConfigFile(edited));
      await writeFile(f.filePath, JSON.stringify(changed, null, 2));
      const latest = await f.repository.read();
      expect(latest.revision).toBe(revision(JSON.stringify(changed)));
      expect(latest.revision).not.toBe(first.revision);
      expect(latest.providers.getRule("fixture-0")?.providerName).toBe("Updated 中文");
      expect(f.recoveries).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("keeps normalization, absent order, committed revisions and original bad bytes", async () => {
    const f = await fixture();
    const events: string[] = [];
    f.repository.onDidChange((reason) => events.push(reason));
    try {
      const empty = await f.repository.read();
      expect(empty.providers.toJSON()).toEqual([]);
      expect(empty.providerOrder).toEqual([]);
      const decoded = decodeProviderConfigFile(personalDocument());
      const encoded = encodeProviderConfigFile(decoded);
      const noncanonical = { config: encoded.config, schemaVersion: encoded.schemaVersion };
      await writeFile(f.filePath, JSON.stringify(noncanonical));
      const normalized = await f.repository.read();
      expect(normalized.revision).toBe(revision(JSON.stringify(encoded)));
      expect(await readFile(f.filePath, "utf8")).toBe(JSON.stringify(encoded, null, 2));
      expect(events).toEqual([]);
      const noOrder = decodeProviderConfigFile({
        ...encoded,
        config: { ...encoded.config, providerOrder: undefined },
      });
      const committed = await f.repository.update(() => noOrder);
      const readback = await f.repository.read();
      expect(readback.providerOrder).toBeUndefined();
      expect(readback.revision).toBe(committed.revision);
      expect(readback.defaultModelSelection).toEqual(committed.defaultModelSelection);
      expect(events).toEqual(["updated"]);
      for (const bytes of ["{invalid", JSON.stringify({ schemaVersion: 999, config: {} })]) {
        await writeFile(f.filePath, bytes);
        const recovered = await f.repository.read();
        expect(recovered.revision).toBe(empty.revision);
        expect(await readFile(f.filePath, "utf8")).toBe(bytes);
      }
      expect(f.recoveries).toHaveLength(2);
      f.repository.dispose();
      await assert.rejects(f.repository.read(), /dispose/);
    } finally {
      await f.dispose();
    }
  });
});
