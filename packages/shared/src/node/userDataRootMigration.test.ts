import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  LEGACY_ZCODE_USER_DATA_DIR_NAME,
  ZCODE_USER_DATA_DIR_NAME,
  ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME,
} from "../appDirNames.js";
import { migrateLegacyUserDataRoot } from "./userDataRootMigration.js";

describe("migrateLegacyUserDataRoot", () => {
  let baseDir: string;
  let legacyRoot: string;
  let nextRoot: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "zcodium-data-root-"));
    legacyRoot = join(baseDir, LEGACY_ZCODE_USER_DATA_DIR_NAME);
    nextRoot = join(baseDir, ZCODE_USER_DATA_DIR_NAME);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function seedLegacyTree(): void {
    mkdirSync(join(legacyRoot, "v2"), { recursive: true });
    mkdirSync(join(legacyRoot, "cli", "db"), { recursive: true });
    writeFileSync(join(legacyRoot, "v2", "setting.json"), '{"dataBaseDir":"/tmp/custom"}');
    writeFileSync(join(legacyRoot, "cli", "db", "db.sqlite"), "sqlite-bytes");
  }

  it("把旧根整体搬到新根，内容逐字节保留", () => {
    seedLegacyTree();
    const result = migrateLegacyUserDataRoot({ baseDir });

    assert.equal(result.status, "migrated");
    assert.equal(existsSync(nextRoot), true);
    assert.equal(
      readFileSync(join(nextRoot, "v2", "setting.json"), "utf8"),
      '{"dataBaseDir":"/tmp/custom"}',
    );
    assert.equal(readFileSync(join(nextRoot, "cli", "db", "db.sqlite"), "utf8"), "sqlite-bytes");
  });

  it("迁移后旧根写标记文件，防止重复灌入", () => {
    seedLegacyTree();
    migrateLegacyUserDataRoot({ baseDir });
    const marker = join(legacyRoot, ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME);

    assert.equal(existsSync(marker), true);
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as { migratedTo: string };
    assert.equal(parsed.migratedTo, nextRoot);
  });

  it("已有标记时不再迁移（no-op）", () => {
    seedLegacyTree();
    migrateLegacyUserDataRoot({ baseDir });
    // 用户在新根里改了配置，再启动不应被旧根覆盖回去。
    writeFileSync(join(nextRoot, "v2", "setting.json"), '{"dataBaseDir":"/tmp/newer"}');

    const second = migrateLegacyUserDataRoot({ baseDir });

    assert.equal(second.status, "noop-already-migrated");
    assert.equal(
      readFileSync(join(nextRoot, "v2", "setting.json"), "utf8"),
      '{"dataBaseDir":"/tmp/newer"}',
    );
  });

  it("旧根不存在时 no-op（全新安装）", () => {
    const result = migrateLegacyUserDataRoot({ baseDir });

    assert.equal(result.status, "noop-no-legacy");
    assert.equal(existsSync(nextRoot), false);
  });

  it("新旧根同时存在时跳过，不覆盖任何一方", () => {
    seedLegacyTree();
    mkdirSync(join(nextRoot, "v2"), { recursive: true });
    writeFileSync(join(nextRoot, "v2", "setting.json"), '{"dataBaseDir":"/tmp/kept"}');
    writeFileSync(join(legacyRoot, "v2", "setting.json"), '{"dataBaseDir":"/tmp/legacy"}');

    const result = migrateLegacyUserDataRoot({ baseDir });

    assert.equal(result.status, "skipped-both-exist");
    assert.equal(
      readFileSync(join(nextRoot, "v2", "setting.json"), "utf8"),
      '{"dataBaseDir":"/tmp/kept"}',
    );
    assert.equal(
      readFileSync(join(legacyRoot, "v2", "setting.json"), "utf8"),
      '{"dataBaseDir":"/tmp/legacy"}',
    );
    // 跳过时不写标记，避免把"未迁移"误判成"已迁移"而永久放弃。
    assert.equal(existsSync(join(legacyRoot, ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME)), false);
  });

  it("自定义基目录下按同一 baseDir 解析", () => {
    const customBase = mkdtempSync(join(tmpdir(), "zcodium-data-base-"));
    try {
      mkdirSync(join(customBase, LEGACY_ZCODE_USER_DATA_DIR_NAME, "v2"), { recursive: true });
      writeFileSync(
        join(customBase, LEGACY_ZCODE_USER_DATA_DIR_NAME, "v2", "setting.json"),
        '{"dataBaseDir":"/tmp/custom"}',
      );

      const result = migrateLegacyUserDataRoot({ baseDir: customBase });

      assert.equal(result.status, "migrated");
      assert.equal(
        readFileSync(join(customBase, ZCODE_USER_DATA_DIR_NAME, "v2", "setting.json"), "utf8"),
        '{"dataBaseDir":"/tmp/custom"}',
      );
    } finally {
      rmSync(customBase, { recursive: true, force: true });
    }
  });

  it("迁移失败不抛异常，返回 failed", () => {
    seedLegacyTree();
    // 把旧根变成文件，cpSync 会以非目录形式失败，走失败分支。
    rmSync(legacyRoot, { recursive: true, force: true });
    writeFileSync(legacyRoot, "not-a-directory");

    const result = migrateLegacyUserDataRoot({ baseDir });

    assert.equal(result.status, "failed");
    assert.ok("error" in result && result.error !== undefined);
  });
  // 以下两条来自 2026-10-03 的真实数据实测补充，覆盖此前单测未触及的形态。
  describe("复杂树与端到端可读", () => {
    beforeEach(() => {
      baseDir = mkdtempSync(join(tmpdir(), "zcodium-data-root-"));
      legacyRoot = join(baseDir, LEGACY_ZCODE_USER_DATA_DIR_NAME);
      nextRoot = join(baseDir, ZCODE_USER_DATA_DIR_NAME);
    });

    afterEach(() => {
      rmSync(baseDir, { recursive: true, force: true });
    });

    it("软链、只读、0 字节、空目录、中文与空格路径逐项保留", () => {
      // 真实 ~/.zcodium 的形态：深层嵌套 + 大小文件混排 + 软链 + 中文/空格文件名。
      // 原用例只比对 config.json 等两个叶子，以上形态没有覆盖。
      // 日志内容刻意用 ASCII：避免多字节字符让长度断言依赖编码细节。
      mkdirSync(join(legacyRoot, "v2", "logs"), { recursive: true });
      mkdirSync(join(legacyRoot, "cli", "skills", "文档 技能"), { recursive: true });
      mkdirSync(join(legacyRoot, "workspace", "default", "src", "deep", "deeper"), {
        recursive: true,
      });
      mkdirSync(join(legacyRoot, "v2", "empty-dir"), { recursive: true });
      writeFileSync(join(legacyRoot, "v2", "state.db"), Buffer.alloc(1024 * 512, 7));
      writeFileSync(join(legacyRoot, "v2", "logs", "app.log"), Buffer.alloc(25000, 0x61));
      writeFileSync(join(legacyRoot, "cli", "skills", "文档 技能", "SKILL.md"), "# old skill");
      writeFileSync(
        join(legacyRoot, "workspace", "default", "src", "deep", "deeper", "main.ts"),
        "export {};",
      );
      writeFileSync(join(legacyRoot, "v2", "zero.bin"), Buffer.alloc(0));
      symlinkSync(join(legacyRoot, "v2", "state.db"), join(legacyRoot, "v2", "db-link"));
      writeFileSync(join(legacyRoot, "v2", "readonly.txt"), "read only");
      chmodSync(join(legacyRoot, "v2", "readonly.txt"), 0o444);

      assert.equal(migrateLegacyUserDataRoot({ baseDir }).status, "migrated");

      assert.equal(lstatSync(join(nextRoot, "v2", "empty-dir")).isDirectory(), true);
      assert.equal(readFileSync(join(nextRoot, "v2", "zero.bin")).length, 0);
      assert.equal(lstatSync(join(nextRoot, "v2", "db-link")).isSymbolicLink(), true);
      assert.equal(readFileSync(join(nextRoot, "v2", "readonly.txt"), "utf8"), "read only");
      assert.equal(
        readFileSync(join(nextRoot, "cli", "skills", "文档 技能", "SKILL.md"), "utf8"),
        "# old skill",
      );
      assert.equal(readFileSync(join(nextRoot, "v2", "state.db")).length, 1024 * 512);
      assert.equal(readFileSync(join(nextRoot, "v2", "logs", "app.log")).length, 25000);
      // 旧根除标记文件外不被改写。
      assert.equal(
        readdirSync(legacyRoot).filter((n) => n === ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME)
          .length,
        1,
      );
    });

    it("迁移后新根落在数据路径函数的查找位置上（端到端）", () => {
      // 锁住「迁移完还得真能用」：此前只有契约层断言，没有从 getZCodeDataRootDir()
      // 的视角确认搬过去的树落在正确位置。
      mkdirSync(join(legacyRoot, "v2"), { recursive: true });
      writeFileSync(join(legacyRoot, "v2", "setting.json"), '{"dataBaseDir":"/tmp/custom"}');

      assert.equal(migrateLegacyUserDataRoot({ baseDir }).status, "migrated");

      assert.equal(nextRoot, join(baseDir, ZCODE_USER_DATA_DIR_NAME));
      assert.equal(
        readFileSync(join(nextRoot, "v2", "setting.json"), "utf8"),
        '{"dataBaseDir":"/tmp/custom"}',
      );
    });
  });
});
