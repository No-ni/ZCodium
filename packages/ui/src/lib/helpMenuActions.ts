import type { IPlatformService } from "@zcode/shared";
import { DesktopCommandIds } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { ZCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

export interface HelpMenuActionHandlers {
  openIssueReport: () => Promise<void>;
  openProductDocs: () => Promise<void>;
  openCommunity: () => Promise<void>;
  openResourceManager: () => Promise<void>;
  showAbout: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  exportLogs: () => void;
}

export function createHelpMenuActionHandlers({
  platform,
  intl,
}: {
  platform: Pick<
    IPlatformService,
    "openFeedback" | "exportLogs" | "openExternal" | "openCommunity" | "executeDesktopCommand"
  >;
  intl: IntlInstance;
}): HelpMenuActionHandlers {
  async function run(action: () => unknown | Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch {
      // 原生 IPC / 外部打开操作可能拒绝；菜单忽略返回的 Promise，必须在动作入口观察失败。
      // 提示使用当前语言，日志不附带原始错误中的 URL、路径或用户内容。
      logger.warn("[HelpMenu] 执行帮助菜单操作失败");
      toast(intl.formatMessage({ id: "helpMenu.actionFailed" }));
    }
  }
  return {
    openIssueReport: () => run(() => platform.openFeedback()),
    openProductDocs: () => run(() => platform.openExternal(ZCODE_PRODUCT_DOCS_URL)),
    openCommunity: () => run(() => platform.openCommunity()),
    openResourceManager: () =>
      run(() => platform.executeDesktopCommand(DesktopCommandIds.OpenResourceManager)),
    showAbout: () => run(() => platform.executeDesktopCommand(DesktopCommandIds.ShowAbout)),
    checkForUpdates: () =>
      run(() => platform.executeDesktopCommand(DesktopCommandIds.CheckForUpdates)),
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}
