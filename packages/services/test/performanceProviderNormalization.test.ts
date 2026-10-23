import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigService,
  ProviderTemplate,
  ProviderTemplateMap,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
  type ProviderModelMembership,
} from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "@zcode/provider-node";
import * as releases from "../../provider-node/src/zcode-builtin-release.js";

function snapshot(
  providers = ProviderConfigMap.empty(),
  extra: Partial<ProviderConfigLayerSnapshot> = {},
): ProviderConfigLayerSnapshot {
  return Object.freeze({
    revision: "fixture-1",
    providers,
    models: ModelConfigRules.empty(),
    ...extra,
  });
}

function fixture(builtin: ProviderConfigLayerSnapshot, personal: ProviderConfigLayerSnapshot) {
  let current = personal;
  let updates = 0;
  const listeners = new Set<(reason: string) => void>();
  const repository: PersonalProviderConfigRepository = {
    read: async () => current,
    onDidChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: async (transform) => {
      const next = transform(current);
      current = Object.freeze({ ...next, revision: `fixture-${++updates + 1}` });
      for (const listener of listeners) listener("updated");
      return current;
    },
  };
  const service = new ProviderConfigService({
    zcodeBuiltinSource: { read: async () => builtin, onDidChange: () => () => {} },
    personalRepository: repository,
  });
  return { service, repository, updates: () => updates };
}

function uniqueReference(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) if (!result.includes(value)) result.push(value);
  return result;
}

function orderReference(builtin: string[], personal: string[], requested: readonly string[]) {
  const members = [...builtin, ...personal];
  const ordered = uniqueReference(requested).filter((id) => members.includes(id));
  return [
    ...builtin.filter((id) => !ordered.includes(id)),
    ...ordered,
    ...personal.filter((id) => !ordered.includes(id)),
  ];
}

const defaultModelSelection = Object.freeze({
  providerId: "fixture-api",
  modelId: "personal",
  options: Object.freeze({ reasoningLevel: "disabled" }),
});
const edited = new ProviderConfig({
  api: new ProviderApiConfig({
    type: "openai-chat-completions",
    baseUrl: "https://example.invalid/v1",
  }),
  access: new ApiKeyAccessConfig({ apiKey: "synthetic-test-key" }),
  personalModelIds: ["must-not-create-member"],
  modelOrder: ["must-not-reorder"],
});

async function save(service: ProviderConfigService, membership?: ProviderModelMembership) {
  return service.savePersonalProviderOverlay("fixture-api", edited, membership);
}

function frozenUpdate(value: ProviderConfigLayerUpdate) {
  return {
    providers: value.providers.toJSON(),
    models: value.models.toPersonalJSON(),
    providerOrder: value.providerOrder,
    defaultModelSelection: value.defaultModelSelection,
  };
}

describe("provider membership normalization keeps save semantics", () => {
  it("keeps first occurrences, inherited ownership, exact IDs and saved model order", async () => {
    const inherited = Object.freeze(["builtin", "BUILTIN", "builtin", "中文", "😀"]);
    const ids = Object.freeze([
      "personal",
      "builtin",
      "personal",
      "中文",
      "个人",
      "😀",
      "Personal",
    ]);
    for (const modelOrder of [
      undefined,
      null,
      [],
      ["个人", "builtin", "个人", "missing", "Personal"],
    ]) {
      const builtin = snapshot(
        new ProviderConfigMap([
          [
            "fixture-api",
            new ProviderConfig({
              group: "zai-family",
              builtinModelIds: inherited,
            }),
          ],
        ]),
      );
      const personal = snapshot(
        new ProviderConfigMap([
          {
            providerId: "fixture-api",
            providerName: "Fixture",
            config: new ProviderConfig({ personalModelIds: ids, modelOrder }),
          },
        ]),
        { providerOrder: Object.freeze(["fixture-api"]), defaultModelSelection },
      );
      const before = frozenUpdate(personal);
      const f = fixture(builtin, personal);
      const events: string[] = [];
      f.service.onDidChange((reason) => events.push(reason));
      try {
        const committed = await save(f.service);
        const config = committed.providers.get("fixture-api")!;
        const builtinIds = uniqueReference(inherited);
        const personalIds = uniqueReference(ids).filter((id) => !builtinIds.includes(id));
        expect(config.personalModelIds).toEqual(personalIds);
        expect(config.modelOrder).toEqual(
          modelOrder == null ? modelOrder : orderReference(builtinIds, personalIds, modelOrder),
        );
        expect(config.api).toEqual(edited.api);
        expect(config.access).toEqual(edited.access);
        expect(committed.defaultModelSelection).toBe(defaultModelSelection);
        expect(committed.providerOrder).toBe(personal.providerOrder);
        expect(committed.models).toBe(personal.models);
        expect(events).toEqual(["personal:updated"]);
        expect(f.updates()).toBe(1);
        expect(frozenUpdate(personal)).toEqual(before);
      } finally {
        f.service.dispose();
      }
    }
  });

  it("uses current dynamic membership instead of the static inherited list", async () => {
    const builtin = snapshot(
      new ProviderConfigMap([
        [
          "fixture-api",
          new ProviderConfig({
            builtinModelIds: ["static"],
          }),
        ],
      ]),
    );
    const personal = snapshot(
      new ProviderConfigMap([
        [
          "fixture-api",
          new ProviderConfig({
            personalModelIds: ["dynamic", "static", "personal", "personal"],
            modelOrder: ["personal", "dynamic"],
          }),
        ],
      ]),
    );
    let checks = 0;
    const membership: ProviderModelMembership = {
      providerId: "fixture-api",
      personalRevision: personal.revision,
      inheritedModelIds: Object.freeze(["dynamic", "dynamic"]),
      assertCurrent: () => {
        checks++;
      },
    };
    const f = fixture(builtin, personal);
    try {
      const committed = await save(f.service, membership);
      expect(committed.providers.get("fixture-api")?.personalModelIds).toEqual([
        "static",
        "personal",
      ]);
      expect(committed.providers.get("fixture-api")?.modelOrder).toEqual([
        "personal",
        "dynamic",
        "static",
      ]);
      expect(checks).toBe(1);
    } finally {
      f.service.dispose();
    }
  });

  it("preserves template baseline membership and personal-only provider group", async () => {
    const template = new ProviderTemplate({
      templateId: "fixture-template",
      templateNameMap: { "en-US": "Fixture" },
      config: new ProviderConfig({ builtinModelIds: ["template-model", "template-model"] }),
    });
    const builtin = snapshot(ProviderConfigMap.empty(), {
      providerTemplates: new ProviderTemplateMap([[template.templateId, template]]),
    });
    const personal = snapshot(
      new ProviderConfigMap([
        {
          providerId: "fixture-api",
          templateId: template.templateId,
          providerName: "Fixture",
          config: new ProviderConfig({
            group: "standard-personal",
            personalModelIds: ["template-model", "personal", "personal"],
            modelOrder: ["personal"],
          }),
        },
      ]),
    );
    const f = fixture(builtin, personal);
    try {
      const committed = await save(f.service);
      expect(committed.providers.get("fixture-api")?.group).toBe("standard-personal");
      expect(committed.providers.get("fixture-api")?.personalModelIds).toEqual(["personal"]);
      expect(committed.providers.get("fixture-api")?.modelOrder).toEqual([
        "template-model",
        "personal",
      ]);
      expect(committed.providers.getRule("fixture-api")?.templateId).toBe(template.templateId);
    } finally {
      f.service.dispose();
    }
  });

  it("rejects stale membership, deleted providers and duplicate names without committing", async () => {
    const builtin = snapshot(new ProviderConfigMap([["fixture-api", new ProviderConfig()]]));
    const personal = snapshot(
      new ProviderConfigMap([
        { providerId: "fixture-api", providerName: "Fixture", config: new ProviderConfig() },
        {
          providerId: "other",
          providerName: "Occupied",
          config: new ProviderConfig({ group: "standard-personal" }),
        },
      ]),
    );
    const f = fixture(builtin, personal);
    try {
      await expect(
        save(f.service, {
          providerId: "fixture-api",
          personalRevision: "stale",
          inheritedModelIds: [],
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("membership revision conflict");
      await expect(f.service.savePersonalProviderOverlay("deleted", edited)).rejects.toThrow(
        "尚未创建",
      );
      await expect(
        f.service.savePersonalProviderOverlay("fixture-api", edited, undefined, {
          providerName: " occupied ",
        }),
      ).rejects.toThrow("Provider 名称已存在");
      expect(f.updates()).toBe(0);
      expect(await f.repository.read()).toBe(personal);
    } finally {
      f.service.dispose();
    }
  });

  it("matches independent normalization across replacement inputs and same IDs in separate sources", async () => {
    for (let seed = 0; seed < 80; seed++) {
      const inherited = Array.from({ length: seed % 13 }, (_, i) => `model-${(i * 3 + seed) % 17}`);
      const ids = Array.from({ length: seed % 23 }, (_, i) => `model-${(i * 5 + seed) % 29}`);
      const order = Array.from({ length: seed % 19 }, (_, i) => `model-${(i * 7 + seed) % 31}`);
      const builtin = snapshot(
        new ProviderConfigMap([
          ["fixture-api", new ProviderConfig({ builtinModelIds: inherited })],
        ]),
      );
      const personal = snapshot(
        new ProviderConfigMap([
          ["fixture-api", new ProviderConfig({ personalModelIds: ids, modelOrder: order })],
        ]),
      );
      const f = fixture(builtin, personal);
      try {
        const normalizedBuiltin = uniqueReference(inherited);
        const normalizedPersonal = uniqueReference(ids).filter(
          (id) => !normalizedBuiltin.includes(id),
        );
        const result = await save(f.service);
        expect(result.providers.get("fixture-api")?.personalModelIds).toEqual(normalizedPersonal);
        expect(result.providers.get("fixture-api")?.modelOrder).toEqual(
          orderReference(normalizedBuiltin, normalizedPersonal, order),
        );
        const next = await save(f.service);
        expect(next.providers.toJSON()).toEqual(result.providers.toJSON());
      } finally {
        f.service.dispose();
      }
    }
  });

  it("does not repeatedly scan growing result arrays for distinct model IDs", async () => {
    const count = 1200;
    const inherited = Array.from({ length: count }, (_, i) => `builtin-${i}`);
    const personalIds = Array.from({ length: count }, (_, i) => `personal-${i}`);
    const f = fixture(
      snapshot(
        new ProviderConfigMap([
          ["fixture-api", new ProviderConfig({ builtinModelIds: inherited })],
        ]),
      ),
      snapshot(
        new ProviderConfigMap([
          ["fixture-api", new ProviderConfig({ personalModelIds: personalIds })],
        ]),
      ),
    );
    const includes = Array.prototype.includes;
    let scanned = 0;
    const spy = vi.spyOn(Array.prototype, "includes").mockImplementation(function (
      this: unknown[],
      value: unknown,
      fromIndex?: number,
    ) {
      if (typeof value === "string" && /^(builtin|personal)-\d+$/.test(value))
        scanned += this.length;
      return includes.call(this, value, fromIndex);
    });
    let committed: ProviderConfigLayerSnapshot;
    try {
      committed = await save(f.service);
    } finally {
      spy.mockRestore();
      f.service.dispose();
    }
    expect(committed.providers.get("fixture-api")?.personalModelIds).toEqual(personalIds);
    expect(scanned).toBeLessThan(count * 8);
  });
});

const releaseDocument = {
  schemaVersion: 1,
  revision: 7,
  config: {
    providerConfigRules: {
      templateRules: [],
      providerRules: [
        {
          providerId: "fixture-api",
          providerName: "Fixture",
          config: { group: "zai-family", builtinModelIds: ["model"] },
        },
      ],
    },
    modelConfigRules: {
      builtinProviderModelRules: [],
      templateModelRules: [],
      modelRules: [],
      modelApiRules: [],
      providerSiteRules: [],
    },
  },
};

function revisionReference(document: unknown, file: string) {
  const release = releases.decodeZCodeBuiltinRelease(document);
  const sourceKey = createHash("sha256").update(resolve(file)).digest("hex");
  const signature = createHash("sha256")
    .update(releases.serializeZCodeBuiltinRelease(release))
    .digest("hex");
  return `zcode-builtin:${release.revision}:${sourceKey}:${signature}`;
}

describe("builtin provider source shares only the current read signature", () => {
  it("preserves revision bytes, file refresh, source isolation and invalid file errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcodium-perf-provider-"));
    const file = join(root, "first.json");
    const otherFile = join(root, "second.json");
    await Promise.all([
      writeFile(file, JSON.stringify(releaseDocument)),
      writeFile(otherFile, JSON.stringify(releaseDocument)),
    ]);
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: file,
      watch: false,
    });
    const same = new NodeZCodeBuiltinProviderConfigSource({ bundledFilePath: file, watch: false });
    const other = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: otherFile,
      watch: false,
    });
    try {
      const first = await source.read();
      expect(first.revision).toBe(revisionReference(releaseDocument, file));
      expect((await same.read()).revision).toBe(first.revision);
      expect((await other.read()).revision).not.toBe(first.revision);
      expect((await source.read()).providers.toJSON()).toEqual(first.providers.toJSON());
      const changed = structuredClone(releaseDocument);
      changed.config.providerConfigRules.providerRules[0]!.providerName = "Revised";
      await writeFile(file, JSON.stringify(changed));
      expect((await source.read()).revision).toBe(revisionReference(changed, file));
      expect((await same.read()).revision).toBe(revisionReference(changed, file));
      await writeFile(file, "invalid-json");
      await expect(source.read()).rejects.toThrow();
      source.dispose();
      await expect(source.read()).rejects.toThrow("已 dispose");
    } finally {
      source.dispose();
      same.dispose();
      other.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes the parsed release once even on the first read", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcodium-perf-signature-"));
    const file = join(root, "bundle.json");
    await writeFile(file, JSON.stringify(releaseDocument));
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: file,
      watch: false,
    });
    const spy = vi.spyOn(releases, "serializeZCodeBuiltinRelease");
    let calls = 0;
    try {
      await source.read();
      calls = spy.mock.calls.length;
      spy.mockClear();
      await source.read();
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      spy.mockRestore();
      source.dispose();
      await rm(root, { recursive: true, force: true });
    }
    expect(calls).toBe(1);
  });
});
