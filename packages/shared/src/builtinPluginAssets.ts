/** Generated dependencies are confined to the shared MCP host, never a workspace install. */
export const CUA_RUNTIME_MODULES_PATH = "dist/mcp/node_modules";

export function cuaNativePackage(platform: string, arch: string): string {
  if (!["linux", "win32", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported CUA target: ${platform}-${arch}`);
  }
  const suffix = platform === "linux" ? "-gnu" : platform === "win32" ? "-msvc" : "";
  return `@trycua/cua-driver-${platform}-${arch}${suffix}`;
}

export function cuaRuntimeRequiredPaths(platform: string, arch: string): string[] {
  const native = cuaNativePackage(platform, arch);
  const library =
    platform === "win32"
      ? "cua_driver_sdk.dll"
      : platform === "darwin"
        ? "libcua_driver_sdk.dylib"
        : "libcua_driver_sdk.so";
  return [
    "dist/mcp/CUA-NOTICES.md",
    ...[
      "@trycua/cua-driver/package.json",
      "@trycua/cua-driver/dist/index.js",
      "@trycua/cua-driver/dist/native/node-runtime.js",
      "@ubjs/core/package.json",
      "@ubjs/core/dist/esm/index.js",
      "@ubjs/node/package.json",
      "@ubjs/node/typescript/dist/resolve-lib.js",
      `${native}/package.json`,
      `${native}/${library}`,
      `${native}/cua_driver_node_runtime.node`,
      `${native}/node-runtime-NOTICE.md`,
    ].map((path) => `${CUA_RUNTIME_MODULES_PATH}/${path}`),
  ];
}

/** Immutable asset contract shared by bootstrap, desktop staging and remote deployment. */
export const BUILTIN_PLUGIN_SEED_PATHS = {
  "browser-use-plugin": [
    "docs/api.json",
    "docs/documents.json",
    "docs/overview.md",
    "docs/recording.md",
    "docs/workflow.md",
    "scripts/browser-client.mjs",
    "skills/control-browser/SKILL.md",
    "skills/web-gui-tester/SKILL.md",
  ],
  "node-repl-host": ["dist/mcp/server.js"],
  // Bugfix：上游 662c30bea（UI plugins / Gen UI）把 visualize-plugin 加进了 staged 官方
  // 插件清单，但那次 cherry-pick（6bb868c）只搬了插件源码，没有搬这份注册表——
  // 本仓库的清单是派生自这里的（BUILTIN_PLUGIN_ASSETS 由本表的键生成），上游则是内联
  // 写在 prepare-agent-node-bundle.mjs 里。缺这一条的后果：桌面打包与远端部署都不会
  // stage visualize-plugin，Gen UI 技能在安装包里整体缺失（/visualize 展开时找不到
  // 技能文件），且因为没有 requiredSeedPaths 校验，构建期不会报错。
  // 路径清单照搬上游 prepare-agent-node-bundle.mjs 的 requiredSeedPaths。
  "visualize-plugin": [
    "skills/visualize/SKILL.md",
    "skills/visualize/references/api.md",
    "skills/visualize/references/styles.md",
    "skills/visualize/tweak.md",
    "skills/visualize/LICENSE.md",
    "skills/visualize/scripts/render.py",
    "skills/visualize/assets/visualize.css",
    "skills/visualize/assets/visualize.html",
    "skills/visualize/assets/calendar.js",
    "skills/visualize/assets/runtime-manifest.json",
    "skills/visualize/scripts/vendor.py",
    "skills/visualize/assets/vendor/manifest.json",
    "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
    "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
    "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
    "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
    "skills/visualize/assets/vendor/lucide-1.17.0.js",
    "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
    "skills/visualize/assets/vendor/d3-7.9.0.min.js",
    "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
    "skills/visualize/widgets/calendar.md",
    "skills/visualize/examples/calendar.html",
    "skills/visualize/assets/standalone-host-bridge.js",
    "skills/visualize/assets/standalone-shell.js",
  ],
  "presentations-plugin": ["agents/visual-judge.md", "skills/pptx/SKILL.md"],
  "documents-plugin": [
    "agents/visual-judge.md",
    "skills/docx/SKILL.md",
    "skills/docx/scripts/__init__.py",
    "skills/docx/scripts/document.py",
    "skills/docx/scripts/utilities.py",
    "skills/docx/scripts/packing.py",
    "skills/docx/scripts/identifiers.py",
    "skills/docx/scripts/docx_editor.py",
    "skills/docx/scripts/tracked_changes.py",
    "skills/docx/scripts/comments.py",
    "skills/docx/scripts/postcheck.py",
    "skills/docx/scripts/postcheck_document.py",
    "skills/docx/scripts/postcheck_rules.py",
    "skills/docx/scripts/fix_footer_fields.py",
    "skills/docx/scripts/add_toc_placeholders.py",
    "skills/docx/scripts/templates/comments.xml",
    "skills/docx/scripts/templates/commentsExtended.xml",
    "skills/docx/scripts/templates/commentsExtensible.xml",
    "skills/docx/scripts/templates/commentsIds.xml",
    "skills/docx/scripts/templates/people.xml",
    "skills/docx/setup.sh",
    "skills/docx/routes/create.md",
    "skills/docx/routes/read.md",
    "skills/docx/routes/comment.md",
    "skills/docx/routes/edit.md",
    "skills/docx/routes/format.md",
    "skills/docx/references/python-api.md",
    "skills/docx/references/toc.md",
    "skills/docx/env_setup/setup.md",
    "skills/docx/env_setup/env_check.sh",
    "skills/docx/scenes/academic.md",
    "skills/docx/scenes/contract.md",
    "skills/docx/scenes/copywriting.md",
    "skills/docx/scenes/exam.md",
    "skills/docx/scenes/official-doc.md",
    "skills/docx/scenes/report.md",
    "skills/docx/scenes/resume.md",
    "skills/docx/references/chart-templates.md",
    "skills/docx/references/common-rules.md",
    "skills/docx/references/decorations.md",
    "skills/docx/references/design-system.md",
    "skills/docx/references/faq.md",
    "skills/docx/references/math-formulas.md",
    "skills/docx/references/xmleditor-api.md",
  ],
  "pdf-plugin": [
    "agents/visual-judge.md",
    "skills/pdf/SKILL.md",
    "skills/pdf/briefs/report.md",
    "skills/pdf/briefs/resume.md",
    "skills/pdf/briefs/poster.md",
    "skills/pdf/scripts/convert_pdf_to_images.py",
    "skills/pdf/scripts/create_validation_image.py",
    "skills/pdf/scripts/check_fillable_fields.py",
    "skills/pdf/scripts/extract_form_field_info.py",
    "skills/pdf/scripts/fill_fillable_fields.py",
    "skills/pdf/scripts/fill_pdf_form_with_annotations.py",
    "skills/pdf/scripts/check_bounding_boxes.py",
    "skills/pdf/scripts/check_bounding_boxes_test.py",
    "skills/pdf/scripts/pdf_qa.py",
    "skills/pdf/scripts/pdf_qa_document.py",
    "skills/pdf/scripts/pdf_qa_text.py",
    "skills/pdf/scripts/pdf_qa_checks.py",
    "skills/pdf/scripts/pdf_qa_colors.py",
    "skills/pdf/scripts/html2pdf.py",
    "skills/pdf/scripts/html2pdf_render.py",
    "skills/pdf/scripts/cover_render.py",
    "skills/pdf/scripts/toc_validate.py",
    "skills/pdf/scripts/toc_validate_document.py",
  ],
  "spreadsheets-plugin": [
    "agents/visual-judge.md",
    "skills/xlsx/SKILL.md",
    "skills/xlsx/scripts/recalc.py",
  ],
  "skill-creator-plugin": [],
  "plugin-creator-plugin": [
    "skills/plugin-creator/SKILL.md",
    "skills/plugin-creator/scripts/create-basic-plugin.mjs",
    "skills/plugin-creator/scripts/marketplace-files.mjs",
    "skills/plugin-creator/scripts/upsert-dev-marketplace.mjs",
    "skills/plugin-creator/scripts/scaffold-files.mjs",
    "skills/plugin-creator/scripts/validate-plugin.mjs",
    "skills/plugin-creator/references/plugin-json-spec.md",
    "skills/plugin-creator/references/installing-and-updating.md",
  ],
  "image-search-plugin": [".mcp.json"],
  "restore-legacy-sessions-plugin": [],
  "zcode-guide-plugin": [
    "commands/workflow.md",
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/examples.md",
    "skills/dynamic-workflows/patterns.md",
  ],
  "zcode-cua-plugin": [
    "docs/computer-use.md",
    "scripts/computer-use-client.mjs",
    "scripts/computer-use-errors.mjs",
    "scripts/computer-use-envelope.mjs",
    "scripts/computer-use-keys.mjs",
    "scripts/computer-use-target.mjs",
    "skills/computer-use/SKILL.md",
  ],
} as const;

export interface BuiltinPluginAsset {
  directory: keyof typeof BUILTIN_PLUGIN_SEED_PATHS;
  packageName: string;
  relativePath: string;
  stagedPath: string;
  requiredSeedPaths: readonly string[];
  requiresRuntime: boolean;
  requiredRuntimePaths: readonly string[];
  runtimeBuildScript: string;
}

export const BUILTIN_PLUGIN_ASSETS: readonly BuiltinPluginAsset[] = (
  Object.keys(BUILTIN_PLUGIN_SEED_PATHS) as Array<keyof typeof BUILTIN_PLUGIN_SEED_PATHS>
).map((directory) => {
  const requiresRuntime = directory === "browser-use-plugin" || directory === "node-repl-host";
  return {
    directory,
    packageName: `@zcode/${directory}`,
    relativePath: `apps/zcode-cli/packages/${directory}`,
    stagedPath: `packages/${directory}`,
    requiredSeedPaths: BUILTIN_PLUGIN_SEED_PATHS[directory],
    requiresRuntime,
    requiredRuntimePaths: requiresRuntime ? BUILTIN_PLUGIN_SEED_PATHS[directory] : [],
    runtimeBuildScript: "scripts/build.mjs",
  };
});

export const BUILTIN_PLUGIN_TOP_LEVEL_PATHS = [
  ".mcp.json",
  ".zcodium-plugin",
  "README.md",
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
] as const;

export const BUILTIN_PLUGIN_REQUIRED_PATHS: readonly string[] = BUILTIN_PLUGIN_ASSETS.flatMap(
  ({ directory, requiredSeedPaths }) =>
    [".zcodium-plugin/plugin.json", ...requiredSeedPaths].map((path) => `${directory}/${path}`),
);
