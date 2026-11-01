import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSshConfigAliasCatalog } from "../src/system/sshConfigAliasCatalog.js";
import { listSSHConfigAliasesFromLocalConfig } from "../src/system/sshConfigAlias.js";

/**
 * SSH config alias 列表 TTL 快照 + 单飞回归。
 *
 * Bug 原因：listSSHConfigAliasesFromLocalConfig 原来只有 30s TTL 结果缓存，只能在一次
 * 扫描完成后阻挡顺序重复；并发首调（双窗口同时开 SSH 对话框 / 桌面加载中手机远控请求 /
 * 单窗口快速重开）全部 miss 缓存，各自完整重扫并重复 spawn ssh -G（alias 上限 200、
 * 并发 3、单个 1.5s 超时），还会互相覆盖 aliasCache。
 * 修复依据：docs/specs/ssh-config-alias-single-flight.md——缓存簿记抽成纯 DI catalog，
 * TTL 锚定调用开始、严格 expiresAt > now、每次返回经 clone、在途扫描单飞、拒绝清 flight 可重试。
 *
 * 测试全程 hermetic：catalog 用例用内存 loader + 假时钟；生产装配用例只写沙箱 HOME 下的
 * .ssh/config，并临时让 ssh 可执行文件解析失败以走原 loader 的 fallback 分支，
 * 不启动真实 ssh、不读取真实 HOME/.zcodium、不起应用或 Agent。
 * 注意：本回归不验证真实 ssh -G 成功路径，也不把内存 loader 称作真实 ssh 验证。
 */

interface AliasOption {
  alias: string;
  host: string;
}

const TTL_MS = 100;

/** 可闸门的扫描 loader：登记调用次数、通报进入、按需失败；每次调用返回全新对象。 */
function createScanHarness(value: AliasOption[]) {
  let markEntered: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  // 闸门默认打开：只有显式 block() 的并发用例才把 loader 保持在途。
  let gate: Promise<void> = Promise.resolve();
  let releaseGate: () => void = () => {};
  // 粘性失败：并发红灯下两个 loader 都必须看到同一次失败，失败信息才确定；
  // 由测试显式 clearFailure() 解除，避免一次性消费让第二个 loader 静默成功。
  let failure: Error | null = null;
  const harness = {
    calls: 0,
    entered,
    /** 让后续 load 阻塞，直到 release()；用于把扫描固定在途。 */
    block(): void {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    },
    release(): void {
      releaseGate();
    },
    failWith(error: Error): void {
      failure = error;
    },
    clearFailure(): void {
      failure = null;
    },
    async load(): Promise<AliasOption[]> {
      harness.calls += 1;
      markEntered();
      await gate;
      if (failure) {
        throw failure;
      }
      return value.map((option) => ({ ...option }));
    },
  };
  return harness;
}

function createCatalog(harness: ReturnType<typeof createScanHarness>, clock: { value: number }) {
  return createSshConfigAliasCatalog<AliasOption[]>({
    load: harness.load,
    now: () => clock.value,
    ttlMs: TTL_MS,
    clone: (options) => options.map((option) => ({ ...option })),
  });
}

const ALIASES: AliasOption[] = [{ alias: "alpha", host: "alpha.example.com" }];

describe("ssh config alias catalog：TTL 快照语义", () => {
  it("TTL 边界：expiresAt 当刻与之前命中缓存，之后重新扫描（严格 >）", async () => {
    const harness = createScanHarness(ALIASES);
    const clock = { value: 1_000 };
    const catalog = createCatalog(harness, clock);

    await catalog.read();
    assert.equal(harness.calls, 1, "首次读取必须真实扫描");

    clock.value = 1_099;
    await catalog.read();
    assert.equal(harness.calls, 1, "expiresAt 之前必须命中快照");

    clock.value = 1_100;
    await catalog.read();
    assert.equal(harness.calls, 2, "expiresAt 当刻已过期（严格 >），必须重新扫描");

    clock.value = 1_200;
    await catalog.read();
    assert.equal(harness.calls, 3, "过期后再读取继续重新扫描");
  });

  it("完成后缓存：连续两次读取只扫描一次", async () => {
    const harness = createScanHarness(ALIASES);
    const catalog = createCatalog(harness, { value: 500 });

    const first = await catalog.read();
    const second = await catalog.read();

    assert.equal(harness.calls, 1);
    assert.deepEqual(first, ALIASES);
    assert.deepEqual(second, ALIASES);
  });

  it("空结果缓存：loader 返回 [] 时按 TTL 缓存且返回数组相互独立", async () => {
    const harness = createScanHarness([]);
    const catalog = createCatalog(harness, { value: 800 });

    const first = await catalog.read();
    const second = await catalog.read();

    assert.deepEqual(first, []);
    assert.deepEqual(second, []);
    assert.equal(harness.calls, 1, "空结果同样按 TTL 缓存");
    assert.notEqual(first, second, "两次返回必须是独立数组");
  });

  it("拷贝隔离：修改返回值不污染缓存与后续返回", async () => {
    const harness = createScanHarness(ALIASES);
    const clock = { value: 900 };
    const catalog = createCatalog(harness, clock);

    const first = await catalog.read();
    first[0]!.host = "mutated";
    const second = await catalog.read();

    assert.equal(harness.calls, 1, "第二次读取命中快照");
    assert.equal(second[0]!.host, "alpha.example.com", "缓存不得被调用方修改污染");
    assert.notEqual(second[0], first[0], "缓存命中也返回独立对象");

    clock.value += TTL_MS + 1;
    const third = await catalog.read();
    assert.equal(harness.calls, 2, "过期后重新扫描");
    assert.equal(third[0]!.host, "alpha.example.com");
  });

  it("起始时间锚定：慢扫描超过 TTL 时快照落入即过期，下次必须重扫", async () => {
    const harness = createScanHarness(ALIASES);
    const clock = { value: 2_000 };
    const catalog = createCatalog(harness, clock);

    harness.block();
    const inFlight = catalog.read();
    await harness.entered;
    clock.value = 2_000 + TTL_MS + 300;
    harness.release();
    const first = await inFlight;
    assert.deepEqual(first, ALIASES);

    const second = await catalog.read();
    assert.equal(
      harness.calls,
      2,
      "expiresAt 必须锚定调用开始（2000+100），按完成时刻续期会错误命中",
    );
    assert.deepEqual(second, ALIASES);
  });

  it("拒绝重试：loader 拒绝原样上抛，flight 清除后可重新扫描", async () => {
    const harness = createScanHarness(ALIASES);
    const clock = { value: 3_000 };
    const catalog = createCatalog(harness, clock);

    harness.failWith(new Error("scan failed"));
    await assert.rejects(catalog.read(), /scan failed/, "拒绝必须原样上抛，不吞异常");
    assert.equal(harness.calls, 1);
    harness.clearFailure();

    const retried = await catalog.read();
    assert.deepEqual(retried, ALIASES);
    assert.equal(harness.calls, 2, "拒绝后下一次读取必须重新扫描");
  });
});

describe("ssh config alias catalog：在途单飞", () => {
  it("并发 2→1：两个并发 read 只扫描一次且结果相等", async () => {
    const harness = createScanHarness(ALIASES);
    const catalog = createCatalog(harness, { value: 4_000 });

    harness.block();
    const first = catalog.read();
    await harness.entered;
    const second = catalog.read();
    harness.release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(harness.calls, 1, "并发首调必须合并为一次扫描");
    assert.deepEqual(firstResult, ALIASES);
    assert.deepEqual(secondResult, ALIASES);
    assert.notEqual(firstResult, secondResult, "两个调用方获得独立数组");
  });

  it("加入中途：在途扫描的加入者共享同一快照的独立副本", async () => {
    const harness = createScanHarness(ALIASES);
    const catalog = createCatalog(harness, { value: 5_000 });

    harness.block();
    const first = catalog.read();
    await harness.entered;
    const second = catalog.read();
    harness.release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(harness.calls, 1, "TTL 过期不取消在途扫描，加入者不得再起一次扫描");
    assert.deepEqual(firstResult, secondResult);
    assert.notEqual(firstResult[0], secondResult[0], "加入者同样获得独立 option 对象");
  });

  it("并发共享拒绝：在途拒绝双方收到同一错误，之后可重试", async () => {
    const harness = createScanHarness(ALIASES);
    const catalog = createCatalog(harness, { value: 6_000 });

    harness.block();
    const first = catalog.read();
    await harness.entered;
    const second = catalog.read();
    harness.failWith(new Error("scan exploded"));
    harness.release();

    await assert.rejects(first, /scan exploded/);
    await assert.rejects(second, /scan exploded/);
    assert.equal(harness.calls, 1, "在途拒绝双方共享同一次扫描");
    harness.clearFailure();

    const retried = await catalog.read();
    assert.deepEqual(retried, ALIASES);
    assert.equal(harness.calls, 2, "共享拒绝后 flight 已清除，可重新扫描");
  });
});

describe("sshConfigAlias 生产装配保持", () => {
  it("导出函数保持真实 parse + 无 ssh fallback + 缓存接线 + 拷贝隔离", async () => {
    // 沙箱守卫：本用例写 homedir() 下的 .ssh/config，必须在项目沙箱内执行；
    // 沙箱外直接运行（无 PROJECT_TEST_SANDBOX_ROOT）必须立刻失败，禁止触达真实 HOME。
    const sandboxRoot = process.env.PROJECT_TEST_SANDBOX_ROOT;
    const home = homedir();
    assert.ok(
      typeof sandboxRoot === "string" && sandboxRoot.length > 0 && home.startsWith(sandboxRoot),
      "生产装配用例必须在项目沙箱内执行（PROJECT_TEST_SANDBOX_ROOT 缺失或 HOME 越界）",
    );

    const configPath = join(home, ".ssh", "config");
    await mkdir(join(home, ".ssh"), { recursive: true });
    await writeFile(configPath, "Host alpha\n  HostName alpha.example.com\n  User alice\n", "utf8");

    // 让 ssh 可执行文件解析失败：走原 loader 逐字保留的 fallback 分支，不起真实 ssh。
    const envKeys = ["PATH", "WINDIR", "ProgramFiles", "ProgramFiles(x86)"];
    const saved = new Map(envKeys.map((key) => [key, process.env[key]] as const));
    process.env.PATH = "";
    process.env.WINDIR = join(home, "no-windir");
    process.env.ProgramFiles = join(home, "no-program-files");
    process.env["ProgramFiles(x86)"] = join(home, "no-program-files-x86");
    try {
      const first = await listSSHConfigAliasesFromLocalConfig();
      assert.equal(first.length, 1, "真实 parse 必须产出 alias 条目");
      assert.equal(first[0]?.alias, "alpha");
      assert.equal(first[0]?.host, "alpha.example.com", "无 ssh 时回退到 config 解析值");
      assert.equal(first[0]?.username, "alice");

      await writeFile(configPath, "Host beta\n  HostName beta.example.com\n", "utf8");
      const second = await listSSHConfigAliasesFromLocalConfig();
      assert.equal(
        second[0]?.alias,
        "alpha",
        "TTL 内必须命中缓存（配置已改仍返回旧快照），证明缓存接线",
      );

      second[0]!.host = "mutated";
      const third = await listSSHConfigAliasesFromLocalConfig();
      assert.equal(third[0]?.host, "alpha.example.com", "修改返回值不得污染缓存");
      assert.notEqual(third[0], second[0], "缓存命中返回独立对象");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(join(home, ".ssh"), { recursive: true, force: true });
    }
  });
});
