import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// 官方 3.17.1 合并的构建/发行契约门：纯静态断言，不装依赖、不跑网络、不写文件。
// 规则出处见 .agents/specs/official-3.17.1-build.md；本文件只验证「构建出来的东西仍是 ZCodium」。
const repoRoot = resolve(import.meta.dirname, "../..");

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

const rootPackage = readJson("package.json");
const desktopPackage = readJson("packages/desktop/package.json");
const builderConfig = read("packages/desktop/electron-builder.config.js");
const tsupConfig = read("packages/desktop/tsup.config.ts");
const viteConfig = read("packages/desktop/vite.config.ts");
const bundleScript = read("packages/desktop/scripts/bundle.mjs");
const workflow = read(".github/workflows/desktop.yml");

test("产品与工具链版本对齐官方 3.17.1", () => {
  assert.equal(rootPackage.version, "3.17.1");
  assert.equal(rootPackage.packageManager, "pnpm@10.33.2");
  assert.equal(desktopPackage.devDependencies.electron, "44.7.0");
  assert.equal(desktopPackage.devDependencies["electron-builder"], "26.17.0");
  assert.equal(desktopPackage.dependencies["electron-updater"], "6.8.10");
  // 补丁键必须与根实际解析的 vitest 版本一致，否则 pnpm install 直接失败。
  assert.equal(rootPackage.devDependencies.vitest, "4.1.7");
  assert.equal(rootPackage.pnpm.patchedDependencies["vitest@4.1.7"], "patches/vitest@4.1.7.patch");
  assert.equal(
    rootPackage.pnpm.patchedDependencies["wdio-electron-service@9.2.1"],
    "patches/wdio-electron-service@9.2.1.patch",
  );
  // Electron 44 的 Chromium 映射与 node-abi 需要固定，避免 builder 依赖树漂移。
  assert.equal(rootPackage.pnpm.overrides["electron-to-chromium"], "1.5.452");
  assert.equal(rootPackage.pnpm.overrides["@electron/rebuild>node-abi"], "4.37.0");
});

test("根 typecheck 入口合法且不减检查", () => {
  // 逐个解析入口目标并确认 tsconfig 真实存在：失效入口会让 typecheck 静默少查一个包。
  const typecheck = rootPackage.scripts.typecheck;
  const targets = typecheck
    .split(/\s+/u)
    .filter((token) => token !== "" && !token.startsWith("-") && token !== "tsc" && token !== "&&");
  assert.ok(targets.length >= 17, `typecheck 目标数量不能减少（当前 ${targets.length}）`);
  for (const target of targets) {
    const relative = target.endsWith(".json") ? target : `${target}/tsconfig.json`;
    assert.ok(existsSync(resolve(repoRoot, relative)), `typecheck 指向不存在的入口 ${relative}`);
  }
  // 上游入口里的本仓既有检查一个都不能丢：relay 是自建包，dev-docs/e2e-report 是本轮新增。
  for (const required of [
    "packages/relay/tsconfig.json",
    "packages/server",
    "packages/zcode-server-cli",
    "apps/dev-docs",
    "packages/e2e-report",
    "packages/desktop/tsconfig.main.json",
    "packages/desktop/tsconfig.host.json",
    "packages/desktop/tsconfig.e2e.json",
    "packages/desktop/tsconfig.remote-main.json",
  ]) {
    assert.ok(targets.includes(required), `typecheck 缺少 ${required}`);
  }
  // 已删除的 shared 测试专用 tsconfig 与旧 CUA 后端（无 tsconfig/无 build 脚本）不能留在入口。
  assert.doesNotMatch(typecheck, /tsconfig\.testing\.json/u);
  assert.doesNotMatch(typecheck, /packages\/zcode-cua/u);
});

test("根 prepare 不再调用不存在的 CUA build 脚本", () => {
  // 用户决定保留旧电脑操作后端：@zcode/zcode-cua 只有 test/lint，没有 build 入口。
  assert.equal(rootPackage.scripts.prepare, "husky");
  assert.equal(rootPackage.scripts["build:cua"], undefined);
  const cuaPkg = readJson("packages/zcode-cua/package.json");
  assert.equal(cuaPkg.scripts.build, undefined);
});

test("Linux 发行资源与官方远端部署入口不恢复", () => {
  for (const forbidden of [
    "prepare:remote-assets",
    "prepare:remote-assets:linux",
    "dev:desktop:remote-prod",
    "bootstrap:with-remote",
  ]) {
    assert.equal(rootPackage.scripts[forbidden], undefined, `${forbidden} 不应回到根入口`);
  }
  assert.equal(desktopPackage.scripts["prepare:glm"], undefined);
  assert.equal(desktopPackage.scripts["prepare:remote-assets"], undefined);
  assert.equal(
    existsSync(resolve(repoRoot, "scripts/dev-desktop-remote-prod.mjs")),
    false,
    "官方 remote prod dev 入口脚本必须保持删除",
  );
});

test("官方遥测/账号面不编译进构建", () => {
  // ARMS 补丁文件与被删掉的补丁声明都不能回来。
  assert.equal(existsSync(resolve(repoRoot, "patches/@arms__rum-electron@0.0.3.patch")), false);
  assert.deepEqual(
    Object.keys(rootPackage.pnpm.patchedDependencies).filter((key) => key.includes("arms")),
    [],
  );
  const desktopDeps = { ...desktopPackage.dependencies, ...desktopPackage.devDependencies };
  assert.deepEqual(
    Object.keys(desktopDeps).filter(
      (name) => name.startsWith("@opentelemetry/") || name === "@arms/rum-electron",
    ),
    [],
    "OTel / ARMS 依赖不得回到 desktop 依赖表",
  );
  // 显式 Provider capture 仅为开发夹具；不能进入生产运行时依赖。
  assert.equal(desktopPackage.dependencies?.["http-mitm-proxy"], undefined);
  assert.equal(desktopPackage.devDependencies?.["http-mitm-proxy"], "1.1.0");
  // builder 与 bundle 的运行时闭包名单都不能注入 OTel。
  assert.doesNotMatch(builderConfig, /@opentelemetry/u);
  assert.doesNotMatch(bundleScript, /@opentelemetry/u);
  // 官方 OAuth / 业务域名不进构建注入；套餐与奖励 webview 入口不恢复。
  assert.doesNotMatch(tsupConfig, /ZAI_OAUTH_|ZAI_BUSINESS_|VITE_ZAI_OAUTH_/u);
  assert.doesNotMatch(viteConfig, /VITE_CODING_PLAN_WEBVIEW_ORIGIN|VITE_REWARDS_WEBVIEW/u);
  assert.doesNotMatch(tsupConfig, /preload\/(codingPlanWebview|rewardsWebview)/u);
  // 自动更新端点 define 只能是自有更新源；ARMS/RUM/事件上报端点不进产物。
  assert.doesNotMatch(
    tsupConfig,
    /__ZCODE_ARMS_RUM_ENDPOINT__|__ZCODE_TELEMETRY_REPORT_ENDPOINT__/u,
  );
  assert.doesNotMatch(
    viteConfig,
    /__ZCODE_ARMS_RUM_ENDPOINT__|__ZCODE_TELEMETRY_REPORT_ENDPOINT__/u,
  );
  assert.doesNotMatch(
    tsupConfig,
    /__ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__|__ZCODE_REMOTE_CDN_RELEASE_ROOTS__:/u,
  );
  assert.equal(desktopPackage.scripts["e2e:telemetry:fields"], undefined);
});

test("官方遥测/云/营销归因工具在本域保持剥离", () => {
  const removed = [
    "packages/desktop/scripts/audit-telemetry-fields.mjs",
    "packages/desktop/scripts/lib/telemetry-field-contract.mjs",
    "packages/desktop/scripts/lib/telemetry-field-contract.d.mts",
    "packages/desktop/scripts/lib/conversation-telemetry-parity.mjs",
    "packages/desktop/scripts/lib/conversation-telemetry-parity.d.mts",
    "packages/desktop/scripts/cloud-content-mock.mjs",
    "packages/desktop/scripts/cloud-content-mock.d.mts",
    "packages/desktop/scripts/cloud-content-mock.test.mjs",
    "packages/desktop/scripts/generate-cloud-content-video.cjs",
    "scripts/marketing-touch-coverage-audit.mjs",
    "scripts/marketing-executable-lines.mjs",
    "scripts/marketing-source-map-evidence.mjs",
    "scripts/test/marketing-touch-coverage-audit.test.mjs",
    "scripts/test/marketing-executable-lines.test.mjs",
    "scripts/test/marketing-source-map-evidence.test.mjs",
    "scripts/test/arms-patch-install-contract.test.mjs",
    "scripts/dev-official-mcp-server.mjs",
    "scripts/dev-web-share-env.mjs",
    // 官方发布链的 CDN 预热/刷新脚本：默认打到官方 CDN 域名，本 fork 不向官方平台上传发行物。
    "scripts/cdn-preload.sh",
    // 官方构建期常量面（ARMS/RUM、上报端点、遥测开关）：即便不注入，留默认值也会让审计红。
    "scripts/build-time-config.mjs",
    "scripts/test/build-time-config.test.mjs",
  ];
  for (const relativePath of removed) {
    assert.equal(
      existsSync(resolve(repoRoot, relativePath)),
      false,
      `${relativePath} 属于官方遥测/云/营销归因面，必须保持删除`,
    );
  }
  for (const forbidden of ["dev:official-mcp", "dev:web-share:test", "dev:web-share:mock"]) {
    assert.equal(rootPackage.scripts[forbidden], undefined, `${forbidden} 不应回到根入口`);
  }
});

test("ZCodium 身份、自有更新源与 macOS 下限", () => {
  assert.equal(desktopPackage.productName, "ZCodium");
  assert.match(desktopPackage.description, /ZCodium/);
  assert.equal(desktopPackage.author, "ZCodium");
  for (const file of ["packages/desktop/tsup.config.ts", "packages/desktop/vite.config.ts"]) {
    assert.match(read(file), /__ZCODIUM_UPDATE_ORIGIN__/, `${file} 必须注入自有更新源`);
    assert.match(read(file), /ZCODIUM_UPDATE_ORIGIN/, `${file} 自有更新源变量名不能漂移`);
  }
  // 自动更新既要显式请求开关，也要已配置的自有源，缺一即关闭；常量只能来自本地 env 读取。
  for (const [relative, source] of [
    ["packages/desktop/vite.config.ts", viteConfig],
    ["packages/desktop/tsup.config.ts", tsupConfig],
  ]) {
    assert.match(
      source,
      /autoUpdateRequested && Boolean\(process\.env\.ZCODIUM_UPDATE_ORIGIN/u,
      `${relative} 自动更新必须同时要求显式开关与自有更新源`,
    );
    assert.match(
      source,
      /const autoUpdateRequested = \["1", "true", "yes"\]\.includes\(/u,
      `${relative} 自动更新开关必须就地从 env 解析，不留官方默认常量模块`,
    );
    assert.doesNotMatch(
      source,
      /build-time-config|buildTimeConfig/u,
      `${relative} 不应再引用官方常量模块`,
    );
  }
  // 构建入口与 CI 不能内嵌官方域名/上报端点，哪怕只是默认值。
  const buildEntries = {
    "package.json": JSON.stringify(rootPackage),
    "packages/desktop/package.json": JSON.stringify(desktopPackage),
    "packages/desktop/electron-builder.config.js": builderConfig,
    "packages/desktop/tsup.config.ts": tsupConfig,
    "packages/desktop/vite.config.ts": viteConfig,
    "vitest.config.ts": read("vitest.config.ts"),
    ".github/workflows/desktop.yml": workflow,
  };
  for (const [relative, source] of Object.entries(buildEntries)) {
    assert.doesNotMatch(
      source,
      /zcode\.z\.ai|cdn-zcode|api\.z\.ai|bigmodel\.cn|ZCODE_ARMS_RUM_ENDPOINT|ZCODE_TELEMETRY_REPORT_ENDPOINT|ZCODE_OFFICIAL_MARKETPLACE|client-config/u,
      `${relative} 构建入口不得内嵌官方域名/遥测/客户端配置面`,
    );
  }
  assert.match(builderConfig, /minimumSystemVersion: "13\.0\.0"/);
  assert.match(builderConfig, /target: \["dmg"\]/);
  assert.doesNotMatch(builderConfig, /target: \["dmg", "zip"\]/);
  // 直接调 builder 也不能绕过 fork 的平台边界。
  assert.match(
    builderConfig,
    /if \(targetPlatform\.os !== "darwin" && targetPlatform\.os !== "win32"\)/,
  );
  assert.doesNotMatch(builderConfig, /PACMAN_RUNTIME_DEPENDENCIES|AppImage|"deb"|"rpm"/);
  assert.match(builderConfig, /rewriteUpdaterCacheDirName/, "updater cache 目录改写不能丢");
});

test("桌面产物只有 Windows exe 与 macOS dmg，且只手动触发", () => {
  assert.match(bundleScript, /mac: \["\.dmg"\],\s*\n\s*win: \["\.exe"\]/);
  assert.match(workflow, /^on:\s*\n\s*workflow_dispatch:/m);
  for (const trigger of ["push:", "pull_request:", "schedule:"]) {
    assert.doesNotMatch(
      workflow,
      new RegExp(`^\\s*${trigger.replace(":", ":")}\\s*$`, "m"),
      `${trigger} 不能自动触发构建`,
    );
  }
  for (const artifact of [
    "desktop-${{ matrix.platform }}-${{ matrix.arch }}",
    "desktop-mac-${{ matrix.arch }}",
  ]) {
    assert.ok(workflow.includes(artifact), `缺少产物名 ${artifact}`);
  }
  assert.match(workflow, /arch: \["arm64", "x64"\]/);
  assert.match(workflow, /arch: x64/);
  assert.match(workflow, /arch: arm64/);
  assert.doesNotMatch(workflow, /prepare:remote-assets|bundle-remote-assets/);
  assert.doesNotMatch(
    workflow,
    /runs-on:.*(ubuntu-24\.04[\s\S]*bundle:desktop -- --os linux)|--os linux/,
  );
  assert.match(workflow, /ZCODE_ENV: production/);
});

test("旧电脑操作后端与 Windows/mac 原生包资产入口保留，且不接 Linux", () => {
  // 用户决定保留 @trycua/cua-driver 后端：本域不能删掉它的资产暂存入口与 CI 探针。
  assert.equal(existsSync(resolve(repoRoot, "scripts/cua-driver-runtime-assets.mjs")), true);
  const agentBundle = read("packages/desktop/scripts/prepare-agent-node-bundle.mjs");
  assert.match(agentBundle, /scripts\/cua-driver-runtime-assets\.mjs/);
  assert.match(agentBundle, /stageCuaDriverRuntime\(/);
  assert.match(
    read("scripts/build-desktop-agent-cli.mjs"),
    /stageDevCuaPluginRuntime\(\{ env: cuaPluginRuntimeStagingEnv \}\)/,
  );
  // 同架构跑执行探针，交叉架构只校验随包资产文件。
  assert.match(workflow, /node scripts\/ci\/cua-driver-smoke\.mjs\n/);
  assert.match(workflow, /cua-driver-smoke\.mjs --files-only/);
  assert.match(workflow, /cua-driver-smoke\.mjs --packaged/);
  // 桌面包不嵌入 Linux 原生运行资源。
  assert.doesNotMatch(builderConfig, /linux:\s*\{|PACMAN_RUNTIME_DEPENDENCIES|AppImage/);
  assert.doesNotMatch(bundleScript, /"linux"/);
  // prepare:runtime-assets 只在 win32/darwin 分支挂原生资产，不给 Linux 开口子。
  const prepareRuntime = read("packages/desktop/scripts/prepare-runtime-assets.mjs");
  assert.match(
    prepareRuntime,
    /if \(target\.os !== "darwin" && target\.os !== "win32"\)[\s\S]{0,120}throw new Error/,
  );
  // 上游新 helper 生产链保持 inert：探针要求 producer 同时给出 zcodeCuaRuntime.windows 契约与
  // broker/helperConstants 导出；本 fork 的旧后端两者皆无，Helper 构建/随包/dev 注入都不得启动。
  const producerModule = read("packages/desktop/scripts/computer-use-producer.mjs");
  assert.match(producerModule, /export function isComputerUseHelperProducerInstalled\(/);
  assert.match(producerModule, /zcodeCuaRuntime\?\.windows/);
  assert.match(producerModule, /"\.\/broker\/helperConstants"/);
  assert.match(
    prepareRuntime,
    /isComputerUseHelperProducerInstalled\(\{ desktopPackageRoot: desktopRoot \}\)/,
    "windows cua helper 必须受 helper 能力探针控制，不能只看 producer 是否安装",
  );
  assert.match(prepareRuntime, /shouldPrepareWindowsCuaHelper \? \["prepare:windows-cua-helper"\]/);
  assert.match(
    builderConfig,
    /if \(shouldPackageComputerUseHelper\) \{[\s\S]{0,160}finalizePackagedWindowsCuaHelper/,
  );
  assert.match(
    builderConfig,
    /const shouldPackageComputerUseHelper = isComputerUseHelperProducerInstalled\(/,
  );
  assert.match(
    read("scripts/dev-desktop-env.mjs"),
    /const computerUseDevEnv = hasComputerUseHelperProducer \? await resolveComputerUseDevEnv\(\) : \{\}/,
  );
  // 官方 Helper 链的入口文件可以留着（上游结构），但不能被本 fork 的默认链路调用。
  assert.doesNotMatch(
    workflow,
    /prepare:windows-cua-helper|ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR/,
    "CI 不能默认构建官方 Helper",
  );
  // 安装清单是安装包自身契约，必须无条件跟随 Windows 目标，
  // 不能被电脑操作后端的可用性绑架（NSIS 保留文件与更新校验都依赖它）。
  assert.match(
    builderConfig,
    /if \(actualWindowsTarget\) \{[\s\S]{0,400}?await runTimedAsync\("afterPack:writeWindowsInstallManifest"/,
  );
});

test("测试态构建 define 不含官方上报端点", () => {
  const vitestConfig = read("vitest.config.ts");
  assert.doesNotMatch(
    vitestConfig,
    /__ZCODE_TELEMETRY_REPORT_ENDPOINT__|__ZCODE_ARMS_RUM_ENDPOINT__/,
  );
  assert.doesNotMatch(vitestConfig, /zcode\.z\.ai|api\.z\.ai|bigmodel\.cn/);
});

test("自建遥测与内建 Provider 配置只走显式 opt-in，不逼发布构建填官方凭证", () => {
  // 官方 release 门会在没有 OTLP 配置时抛错；本 fork 必须保持未配置即空导出。
  assert.doesNotMatch(
    tsupConfig,
    /OTLP configuration is required for release builds|CI_COMMIT_BRANCH === "release\/current"/u,
  );
  assert.match(tsupConfig, /if \(!endpoint && !headers\) \{\n\s*return \{\};/u);
  // 单一内建 Provider 配置：不引入官方 zcode-builtin.test.json 目录，且保留 .env 端点装载。
  const providerConfigScript = read("scripts/builtin-provider-config.mjs");
  // 注释里会解释为什么不读官方测试 catalog，所以只禁止真正的字符串字面量入口。
  assert.doesNotMatch(providerConfigScript, /["`]zcode-builtin\.test\.json["`]/u);
  assert.doesNotMatch(providerConfigScript, /environment === "production" \? /u);
  assert.match(
    providerConfigScript,
    /loadBuiltinProviderConfig[\s\S]{0,320}ZCODE_BUILTIN_PROVIDER_CONFIG_FILE/u,
  );
  assert.match(providerConfigScript, /loadEndpointEnv/u);
  // E2E 构建指纹只登记真实构建输入：官方 OAuth/套餐/邀请 define 已移除，自有更新源必须登记。
  const e2eBuild = read("packages/desktop/scripts/ensure-e2e-desktop-build.mjs");
  assert.doesNotMatch(
    e2eBuild,
    /ZAI_OAUTH|ZAI_BUSINESS|VITE_ZAI_OAUTH|CODING_PLAN_WEBVIEW|REWARDS_WEBVIEW/u,
  );
  assert.doesNotMatch(e2eBuild, /zcode-builtin\.test\.json/u);
  assert.match(e2eBuild, /"ZCODIUM_UPDATE_ORIGIN"/u);
  assert.match(e2eBuild, /"ZCODE_AUTO_UPDATE"/u);
});

test("开发态 Electron runtime 与 macOS dev 副本身份", () => {
  const devScript = read("packages/desktop/scripts/dev.mjs");
  assert.match(devScript, /ensureElectronRuntime/);
  assert.match(devScript, /\.zcodium-runtime\/desktop-dev/);
  const devBundle = read("packages/desktop/scripts/devElectronAppBundle.mjs");
  assert.match(devBundle, /DEV_ELECTRON_APP_NAME = "ZCodium Dev"/);
  assert.match(devBundle, /DEV_ELECTRON_APP_BUNDLE_ID = "dev\.zcodium\.app\.development"/);
  assert.match(devBundle, /LEGACY_DEV_ELECTRON_APP_NAMES = \["ZCode Dev"\]/);
  // Electron 42+ 要求 dev 副本带有效签名，ad-hoc 只用于开发副本。
  assert.match(devBundle, /signDevElectronApp/);
  assert.match(devBundle, /DEV_ELECTRON_BUNDLE_FORMAT = 3/);
});

test("macOS release doctor 跟随 ZCodium 身份与 .zcodium 数据根", () => {
  const doctor = read("scripts/doctor-macos-release-app.sh");
  assert.match(doctor, /\/Applications\/ZCodium\.app/);
  assert.match(doctor, /\$\{ZCODE_HOME:-\$\{HOME:\+\$HOME\/\.zcodium\}\}/);
  assert.doesNotMatch(doctor, /Applications\/ZCode\.app/);
  // 保留旧电脑操作后端：doctor 不再验收官方独立 Helper.app，改为验收产品 app 自身与数据根身份。
  assert.doesNotMatch(
    doctor,
    /ZCODE_CUA_REQUIRE_HELPER|ZCODE_CUA_HELPER_APP_PATH|Computer Use Helper/,
  );
  assert.match(doctor, /"\$APP_BUNDLE_NAME executable"/);
  assert.match(doctor, /assert_fork_data_root "\$ZCODE_HOME_DIR"/);
  const doctorTest = read("packages/desktop/test/macosReleaseAppDoctor.test.ts");
  assert.doesNotMatch(doctorTest, /broker\/helperConstants|ZCODE_CUA_REQUIRE_HELPER/);
});

test("legacy prepare-prebuilds 仍按本仓保留（退役需 CI fixture 归属方一起处理）", () => {
  assert.equal(existsSync(resolve(repoRoot, "scripts/prepare-prebuilds.mjs")), true);
});
