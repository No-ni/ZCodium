import type { OutputStyle, OutputStyleConfig } from "@zcode/shared";
import type { IOutputStyleService } from "./outputStyle.js";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServiceLogger } from "../logger/serviceLogger.js";

const SETTINGS_FILE = "settings.json";
const log = createServiceLogger("output-style");

function getStyleFilePath(stylesDir: string, baseName: string): string {
  // 名称和 RPC ID 都是直接子文件标识；旧实现直接 join，../ 和反斜杠可写删样式目录外文件。
  // 保留 Unicode、空格与中间的 .md；仅拒绝路径分隔符和当前平台不能表示的文件名。
  if (
    typeof baseName !== "string" ||
    baseName.length === 0 ||
    baseName.includes("/") ||
    baseName.includes("\\") ||
    baseName.includes("\0") ||
    (process.platform === "win32" &&
      (/[<>:"|?*]/.test(baseName) ||
        [...baseName].some((character) => character.charCodeAt(0) < 32)))
  ) {
    throw Object.assign(new Error("Invalid output style file name"), {
      code: "OUTPUT_STYLE_INVALID_FILE_NAME",
    });
  }
  return join(stylesDir, `${baseName}.md`);
}

const BUILT_IN_STYLES: OutputStyle[] = [
  {
    id: "default",
    name: "Default",
    description: "Completes coding tasks efficiently and provides concise responses",
    content: "",
    isBuiltIn: true,
    enabled: true,
  },
  {
    id: "explanatory",
    name: "Explanatory",
    description: "Explains implementation choices and codebase patterns",
    content: "",
    isBuiltIn: true,
    enabled: false,
  },
  {
    id: "learning",
    name: "Learning",
    description: "Pauses and asks you to write small pieces of code for hands-on practice",
    content: "",
    isBuiltIn: true,
    enabled: false,
  },
];

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getUserOutputStylesDir(): string {
  return join(resolveUserHomeDir(), ".claude", "output-styles");
}

function getUserClaudeSettingsPath(): string {
  return join(resolveUserHomeDir(), ".claude", SETTINGS_FILE);
}

interface ClaudeSettingsConfig {
  outputStyle?: string;
  hooks?: unknown;
  [key: string]: unknown;
}

/**
 * Read JSON file safely
 */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    log.warn(undefined, "Output style settings read failed");
    return null;
  }
}

/**
 * Write JSON file safely
 */
async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  try {
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    log.error(undefined, "Output style settings write failed");
    throw error;
  }
}

/**
 * 解析 markdown 格式的 output style 文件
 */
function parseMarkdownStyle(
  content: string,
  filename?: string,
): { name: string; description: string } {
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const descMatch = content.match(/^description:\s*(.+)$/m);

  let name = nameMatch?.[1]?.trim() ?? "";

  if (!name && filename) {
    name = filename.replace(/\.md$/, "");
  }

  if (!name) {
    name = "Custom Style";
  }

  const description = descMatch?.[1]?.trim() ?? "";

  return { name, description };
}

/**
 * 创建 OutputStyle 服务实例
 */
export function createOutputStyleService(): IOutputStyleService {
  async function getActiveStyle(): Promise<{ styleId: string | null }> {
    const settingsPath = getUserClaudeSettingsPath();
    const settings = await readJsonFile<ClaudeSettingsConfig>(settingsPath);
    return { styleId: settings?.outputStyle ?? null };
  }

  async function setActiveStyle(params: { styleId: string }): Promise<void> {
    const { styleId } = params;
    const settingsPath = getUserClaudeSettingsPath();
    const claudeDir = join(resolveUserHomeDir(), ".claude");

    // Ensure directory exists
    if (!existsSync(claudeDir)) {
      await mkdir(claudeDir, { recursive: true });
    }

    // Read existing settings.json
    const existingSettings = (await readJsonFile<ClaudeSettingsConfig>(settingsPath)) || {};

    // Update outputStyle
    const newSettings: ClaudeSettingsConfig = {
      ...existingSettings,
      outputStyle: styleId,
    };

    await writeJsonFile(settingsPath, newSettings);
  }

  async function listStyles(): Promise<{ styles: OutputStyle[] }> {
    const stylesDir = getUserOutputStylesDir();
    const customStyles: OutputStyle[] = [];

    // Get active style from settings.local.json, default to "default"
    const { styleId } = await getActiveStyle();
    const activeStyleId = styleId ?? "default";

    try {
      await access(stylesDir);
      const entries = await readdir(stylesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const filePath = join(stylesDir, entry.name);
            const content = await readFile(filePath, "utf-8");
            const { name, description } = parseMarkdownStyle(content, entry.name);
            // 只移除最终扩展名；report.md.extra.md 的 ID 必须仍定位 report.md.extra.md。
            const styleId = `custom-${entry.name.slice(0, -3)}`;

            customStyles.push({
              id: styleId,
              name,
              description,
              content,
              isBuiltIn: false,
              enabled: styleId === activeStyleId,
              filePath,
            });
          } catch {
            log.warn(undefined, "Output style file read failed");
          }
        }
      }
    } catch {
      // 目录不存在或无法访问，返回内置 styles
    }

    // 按名称排序
    customStyles.sort((a, b) => a.name.localeCompare(b.name));

    // 合并内置和自定义 styles，标记激活状态
    const allStyles: OutputStyle[] = [
      ...BUILT_IN_STYLES.map((style) => ({
        ...style,
        enabled: style.id === activeStyleId,
      })),
      ...customStyles,
    ];

    return { styles: allStyles };
  }

  async function addStyle(params: { config: OutputStyleConfig }): Promise<void> {
    const { config } = params;
    const stylesDir = getUserOutputStylesDir();
    const filePath = getStyleFilePath(stylesDir, config.name.toLowerCase().replace(/\s+/g, "-"));

    try {
      await mkdir(stylesDir, { recursive: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
    }

    // 生成文件内容
    const content = `name: ${config.name}
description: ${config.description}

${config.content}`;

    await writeFile(filePath, content, "utf-8");
  }

  async function updateStyle(params: { id: string; config: OutputStyleConfig }): Promise<void> {
    const { id, config } = params;

    // 移除 'custom-' 前缀获取文件名
    const baseId = id.startsWith("custom-") ? id.slice(7) : id;
    const stylesDir = getUserOutputStylesDir();
    const filePath = getStyleFilePath(stylesDir, baseId);

    // 生成文件内容
    const content = `name: ${config.name}
description: ${config.description}

${config.content}`;

    await writeFile(filePath, content, "utf-8");
  }

  async function deleteStyle(params: { id: string }): Promise<void> {
    const { id } = params;

    // 移除 'custom-' 前缀获取文件名
    const baseId = id.startsWith("custom-") ? id.slice(7) : id;
    const stylesDir = getUserOutputStylesDir();
    const filePath = getStyleFilePath(stylesDir, baseId);

    await rm(filePath, { force: true });
  }

  async function getUserStylesDirectory(): Promise<{ path: string }> {
    const stylesDir = getUserOutputStylesDir();

    try {
      await mkdir(stylesDir, { recursive: true });
    } catch {
      // 目录已存在
    }

    return { path: stylesDir };
  }

  return {
    listStyles,
    addStyle,
    updateStyle,
    deleteStyle,
    getUserStylesDirectory,
    setActiveStyle,
    getActiveStyle,
  };
}
