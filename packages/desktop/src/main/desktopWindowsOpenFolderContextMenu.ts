import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Locale } from "@zcode/shared";

const MENU_KEY_NAME = "ZCodium.OpenInZCodium";
const LEGACY_MENU_KEY_NAME = "ZCode.OpenInZCode";
const DIRECTORY_MENU_KEY = `HKCU\\Software\\Classes\\Directory\\shell\\${MENU_KEY_NAME}`;
const DRIVE_MENU_KEY = `HKCU\\Software\\Classes\\Drive\\shell\\${MENU_KEY_NAME}`;
const LEGACY_MENU_KEYS = [
  `HKCU\\Software\\Classes\\Directory\\shell\\${LEGACY_MENU_KEY_NAME}`,
  `HKCU\\Software\\Classes\\Drive\\shell\\${LEGACY_MENU_KEY_NAME}`,
];
const MENU_LABELS: Record<Locale, string> = {
  "zh-CN": "在ZCodium中打开",
  "en-US": "Open in ZCodium",
};

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

interface WindowsOpenFolderRegistryOperation {
  args: string[];
}

function getWindowsOpenFolderMenuName(locale: Locale): string {
  return MENU_LABELS[locale] ?? MENU_LABELS["en-US"];
}

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildWindowsOpenFolderCommand(
  executablePath: string,
  appArgs: readonly string[] = [],
): string {
  return [
    quoteWindowsCommandArg(executablePath),
    ...appArgs.map(quoteWindowsCommandArg),
    "--open-workspace",
    '"%1"',
  ].join(" ");
}

function buildWindowsOpenFolderRegistryOperations(options: {
  executablePath: string;
  appArgs?: readonly string[];
  locale: Locale;
}): WindowsOpenFolderRegistryOperation[] {
  const command = buildWindowsOpenFolderCommand(options.executablePath, options.appArgs ?? []);
  const menuName = getWindowsOpenFolderMenuName(options.locale);
  const menuKeys = [DIRECTORY_MENU_KEY, DRIVE_MENU_KEY];

  return menuKeys.flatMap((menuKey) => [
    { args: ["add", menuKey, "/ve", "/d", menuName, "/f"] },
    { args: ["add", menuKey, "/v", "MUIVerb", "/t", "REG_SZ", "/d", menuName, "/f"] },
    { args: ["add", menuKey, "/v", "Icon", "/t", "REG_SZ", "/d", options.executablePath, "/f"] },
    { args: ["add", `${menuKey}\\command`, "/ve", "/d", command, "/f"] },
  ]);
}

function runRegAdd(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("reg.exe", [...args], {
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`reg.exe exited with code ${code ?? "unknown"}`));
    });
  });
}

/** 旧键可能不存在或被系统策略锁定；清理失败不影响新菜单安装。 */
function runRegDelete(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise) => {
    const child = spawn("reg.exe", ["delete", ...args, "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("error", () => resolvePromise());
    child.on("exit", () => resolvePromise());
  });
}

export async function installWindowsOpenFolderContextMenu(options: {
  platform: NodeJS.Platform;
  executablePath: string;
  argv: readonly string[];
  isDefaultApp: boolean;
  locale: Locale;
  logger: Logger;
}): Promise<void> {
  if (options.platform !== "win32") {
    return;
  }

  const appArgs =
    // 开发态 Windows 的 process.execPath 是 Electron 可执行文件。
    // 注册表命令必须同时带上应用入口，否则 Explorer 右键菜单只能启动空 Electron。
    options.isDefaultApp && options.argv[1] ? [resolve(options.argv[1])] : [];
  const operations = buildWindowsOpenFolderRegistryOperations({
    executablePath: options.executablePath,
    appArgs,
    locale: options.locale,
  });

  try {
    await Promise.all(operations.map((operation) => runRegAdd(operation.args)));
    // 旧版本的 “在ZCode中打开” 指向同一个可执行文件；清掉旧键避免右键菜单出现两项。
    await Promise.all(LEGACY_MENU_KEYS.map((menuKey) => runRegDelete([menuKey])));

    options.logger.info("[open-folder] Windows Explorer 右键菜单已安装或更新", {
      executablePath: options.executablePath,
      hasDefaultAppEntry: appArgs.length > 0,
      locale: options.locale,
    });
  } catch (error) {
    options.logger.warn("[open-folder] Windows Explorer 右键菜单安装失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
