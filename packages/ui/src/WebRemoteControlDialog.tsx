import { memo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { Bot as BotIcon, MonitorSmartphone, XIcon } from "lucide-react";
import { BotsDialog } from "@/BotsDialog.js";
import { ProviderIcon } from "@/BotsDialog/shared.js";
import { getBotProviderRegionTagLabelId } from "@/botsUi.js";
import { WebRemoteControlEndpointSection } from "@/WebRemoteControlEndpointSection.js";
import { useWebRemoteControl } from "@/hooks/useWebRemoteControl.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import type {
  BotProvider,
  WebRemoteControlFailureReason,
  WebRemoteControlTaskSync,
} from "@zcode/shared";

type RemoteControlBotProvider = Extract<
  BotProvider,
  "weixin" | "feishu" | "lark" | "telegram" | "astrbot"
>;

const REMOTE_CONTROL_BOT_ENTRIES: Array<{
  provider: RemoteControlBotProvider;
}> = [
  // 当前仅 AstrBot 可用；其余渠道入口保留，待与桥接统一后再开放。
  { provider: "astrbot" },
  { provider: "weixin" },
  { provider: "feishu" },
  { provider: "lark" },
  { provider: "telegram" },
];

/** failure.reason → i18n 文案键；与 shared/status.ts 的枚举一一对应。 */
const FAILURE_MESSAGE_IDS: Record<WebRemoteControlFailureReason, string> = {
  sessionNotFound: "webRemoteControl.failure.sessionNotFound",
  sessionExpired: "webRemoteControl.failure.sessionExpired",
  sessionConflict: "webRemoteControl.failure.sessionConflict",
  kicked: "webRemoteControl.failure.kicked",
  workspaceClosed: "webRemoteControl.failure.workspaceClosed",
  desktopDisconnected: "webRemoteControl.failure.desktopDisconnected",
  invalidMobileConnection: "webRemoteControl.failure.invalidMobileConnection",
  desktopBootstrapTimeout: "webRemoteControl.failure.desktopBootstrapTimeout",
  connectionRecoveryTimeout: "webRemoteControl.failure.connectionRecoveryTimeout",
  relayUnavailable: "webRemoteControl.failure.relayUnavailable",
  unsupportedAction: "webRemoteControl.failure.unsupportedAction",
  unexpectedError: "webRemoteControl.failure.unexpectedError",
};

export const WebRemoteControlDialog = memo(function WebRemoteControlDialogComponent({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const [botsDialogOpen, setBotsDialogOpen] = useState(false);
  const [botEntryProvider, setBotEntryProvider] = useState<RemoteControlBotProvider | null>(null);
  const [refreshConfirmOpen, setRefreshConfirmOpen] = useState(false);
  // 两个标签页共用一个 ScrollArea，切页时按 key 重挂载把滚动位置复位到顶部，
  // 避免上一页的滚动深度带着下一页继续滚。
  const [activeTab, setActiveTab] = useState("qr");
  const taskService = useZCodeTaskService(workspacePath, null, workspaceIdentity);
  const remote = useWebRemoteControl({
    open,
    workspacePath,
    workspaceIdentity,
    loadSyncPayload: async () => {
      const workspaceKey = workspaceIdentity?.trim() || workspacePath;
      let tasks: WebRemoteControlTaskSync["tasks"] = [];
      try {
        const taskMetas = await taskService.listTasks({ workspacePath, workspaceIdentity });
        tasks = taskMetas.map((task) => ({
          workspaceKey,
          taskId: task.taskId,
          title: task.title,
          displayStatus: task.status ?? "idle",
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          ...(typeof task.unreadAt === "number" ? { unreadAt: task.unreadAt } : {}),
        }));
      } catch (error) {
        logger.warn("[WebRemoteControlDialog] 读取任务清单失败", {
          workspacePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        workspaces: [
          {
            workspaceKey,
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            kind: "local" as const,
          },
        ],
        tasks,
      };
    },
  });

  const handleOpenBotEntry = (provider: RemoteControlBotProvider) => {
    setBotEntryProvider(provider);
    setBotsDialogOpen(true);
    // Bugfix: 打开配置弹窗时收起外层远控弹层，避免两层带 backdrop-blur 的遮罩
    // 叠在毛玻璃窗口上，配置页滚动时 GPU 每帧重复采样模糊导致整窗掉帧。
    onOpenChange(false);
    logger.info("[WebRemoteControlDialog] 打开 Bot Channel 配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
      provider,
    });
  };

  const handleOpenBotsDialog = () => {
    setBotEntryProvider(null);
    setBotsDialogOpen(true);
    onOpenChange(false);
    logger.info("[WebRemoteControlDialog] 打开 Bots 总配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
    });
  };

  const failure = remote.snapshot?.failure;
  // statusDetail 只覆盖官方六态；cancelled 回落 idle 文案。
  const statusDetailId = `webRemoteControl.statusDetail.${
    remote.status === "cancelled" ? "idle" : remote.status
  }`;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          // Bugfix: 远控弹窗打开时滚动很卡。主窗口本身是 vibrancy 磨砂玻璃，
          // 模态遮罩再叠一层 backdrop-blur 后，滚动内容时 GPU 每帧都要重采整窗模糊。
          // 这里把遮罩降级成纯变暗，不再与窗口自身材质叠加采样。
          overlayClassName="bg-black/60 supports-backdrop-filter:!backdrop-blur-none"
          className="max-h-[calc(100vh-6rem)] max-w-lg gap-0 overflow-hidden rounded-2xl p-0"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Bugfix: 这个弹窗会贴近桌面窗口顶部显示，默认 close 在 Electron drag 区里容易点不中。
            // 这里改成显式点击关闭，并把按钮本身标成 no-drag，保证右上角关闭动作能稳定命中。
            // Bugfix: 远控弹层内可点击控件之前没有显式 pointer cursor，桌面端 hover 时不像可操作元素。
            // 这里仅给启用态补手指指针，禁用态仍沿用 Button 的 disabled 交互语义。
            className="absolute top-2 right-2 z-20 enabled:cursor-pointer [app-region:no-drag]"
            onClick={() => onOpenChange(false)}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
          <DialogHeader className="space-y-2 p-5 pr-12">
            <div className="flex items-center gap-2">
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                <MonitorSmartphone className="size-5" />
              </div>
              <div className="space-y-1">
                <DialogTitle>{intl.formatMessage({ id: "webRemoteControl.title" })}</DialogTitle>
                <DialogDescription>
                  {intl.formatMessage({ id: "webRemoteControl.description" })}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-col">
            <div className="px-5">
              <TabsList className="w-full">
                <TabsTrigger value="qr">
                  {intl.formatMessage({ id: "webRemoteControl.tab.qr" })}
                </TabsTrigger>
                <TabsTrigger value="bots">
                  {intl.formatMessage({ id: "webRemoteControl.tab.bots" })}
                </TabsTrigger>
              </TabsList>
            </div>
            {/* Bugfix: 原来整个弹窗共用一条 14px 通顶原生滚动条，轨道正好从右上角
                关闭按钮底下穿过。拆页后正文改用 ScrollArea 的细窄滚动条：
                type="scroll" 让它平时隐藏、滚动时淡入、停止后短暂停留再淡出，
                只覆盖标签页内容、避让头部。高度 min(420px, calc(100vh - 18rem))：
                18rem 按最大字号下的两行头部、标签栏和 6rem 视口边距之和预留，
                最小窗口（640px 高）下滚动区随视口收缩，底部不会被裁掉。
                key 跟随标签页，切页时重挂载 ScrollArea 把滚动位置复位到顶部。 */}
            <ScrollArea
              key={activeTab}
              className="h-[min(420px,calc(100vh-18rem))]"
              type="scroll"
              scrollbarClassName="data-[state=visible]:animate-in data-[state=visible]:fade-in-0 data-[state=hidden]:animate-out data-[state=hidden]:fade-out-0"
            >
              <TabsContent value="qr" className="p-5 pt-4">
                <div className="grid gap-4">
                  <WebRemoteControlEndpointSection />

                  <section className="flex flex-col rounded-xl border border-border bg-card p-4">
                    <div className="mb-4 flex items-start gap-2">
                      <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                      <div className="min-w-0 space-y-1">
                        <div className="text-ui-base font-medium text-foreground">
                          {intl.formatMessage({ id: "webRemoteControl.mobileQr.title" })}
                        </div>
                        <p className="text-ui-base/relaxed text-foreground-subtle">
                          {intl.formatMessage({ id: "webRemoteControl.mobileQr.description" })}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-background-alt p-4">
                      {remote.qrDataUrl ? (
                        <img
                          src={remote.qrDataUrl}
                          alt={intl.formatMessage({ id: "webRemoteControl.qrAlt" })}
                          className="size-64 max-w-full rounded-lg bg-white p-3"
                        />
                      ) : (
                        <div className="flex flex-col items-center gap-3 text-center text-ui-base text-foreground-subtle">
                          <MonitorSmartphone className="size-5 animate-pulse" />
                          <span>{intl.formatMessage({ id: "webRemoteControl.generating" })}</span>
                        </div>
                      )}
                    </div>

                    <div className="mt-4 space-y-1">
                      <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                        <span>{intl.formatMessage({ id: "webRemoteControl.statusLabel" })}</span>
                        {remote.status === "active" ? (
                          <span className="inline-flex h-5 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                            {intl.formatMessage({ id: "webRemoteControl.statusTag.phone" })}
                          </span>
                        ) : null}
                        {remote.status === "running" ? (
                          <span className="inline-flex h-5 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                            {intl.formatMessage({ id: "webRemoteControl.statusTag.ready" })}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-ui-base/relaxed text-foreground-subtle">
                        {failure
                          ? intl.formatMessage({ id: FAILURE_MESSAGE_IDS[failure.reason] })
                          : intl.formatMessage({ id: statusDetailId })}
                      </p>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        className="justify-center gap-2 enabled:cursor-pointer"
                        disabled={!remote.qrUrl || remote.busy}
                        onClick={() => void remote.copyLink()}
                      >
                        {intl.formatMessage({ id: "webRemoteControl.copyLink" })}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        className="justify-center gap-2 enabled:cursor-pointer"
                        disabled={remote.busy}
                        onClick={() => setRefreshConfirmOpen(true)}
                      >
                        {intl.formatMessage({ id: "webRemoteControl.refreshQr" })}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        className="justify-center gap-2 enabled:cursor-pointer"
                        disabled={remote.busy || remote.status === "idle"}
                        onClick={() => void remote.stop()}
                      >
                        {intl.formatMessage({ id: "webRemoteControl.stop" })}
                      </Button>
                    </div>
                    <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">
                      {intl.formatMessage({ id: "webRemoteControl.copyLink.description" })}
                    </p>
                    <p className="mt-1 text-ui-xs/relaxed text-foreground-subtle">
                      {intl.formatMessage({ id: "webRemoteControl.singlePageNote" })}
                    </p>
                  </section>
                </div>
              </TabsContent>

              <TabsContent value="bots" className="p-5 pt-4">
                <section className="flex flex-col rounded-xl border border-border bg-card p-4">
                  <div className="mb-4 flex items-start gap-2">
                    <BotIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                    <div className="min-w-0 space-y-1">
                      <div className="text-ui-base font-medium text-foreground">
                        {intl.formatMessage({
                          id: "webRemoteControl.botChannel.title",
                        })}
                      </div>
                      <p className="text-ui-base/relaxed text-foreground-subtle">
                        {intl.formatMessage({
                          id: "webRemoteControl.botChannel.description",
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="grid min-h-0 flex-1 gap-3">
                    {REMOTE_CONTROL_BOT_ENTRIES.map((entry) => {
                      const regionTagLabelId = getBotProviderRegionTagLabelId(entry.provider);

                      return (
                        <button
                          key={entry.provider}
                          type="button"
                          className="flex min-h-0 cursor-pointer items-start gap-3 rounded-lg border border-transparent bg-surface px-3 py-3 text-left transition-colors hover:border-input-border-focused hover:bg-surface-hover focus-visible:border-input-border-focused"
                          onClick={() => handleOpenBotEntry(entry.provider)}
                        >
                          {/* Bugfix: 远控 Bot Channel 入口原来用通用 lucide 图标，用户无法一眼区分微信、飞书和 Telegram。
                                这里直接复用 BotsDialog 的渠道 logo，不再额外包裹容器，保证品牌图标本身作为视觉识别。 */}
                          <ProviderIcon provider={entry.provider} className="size-12 shrink-0" />
                          <span className="min-w-0 flex-1 space-y-1">
                            <span className="flex min-h-0 items-center gap-1.5 text-ui-base font-medium text-foreground">
                              <span className="min-w-0 truncate">
                                {intl.formatMessage({
                                  id: `webRemoteControl.botChannel.${entry.provider}.title`,
                                })}
                              </span>
                              {regionTagLabelId ? (
                                <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                                  {intl.formatMessage({ id: regionTagLabelId })}
                                </span>
                              ) : null}
                            </span>
                            <span className="block text-ui-base/relaxed text-foreground-subtle">
                              {intl.formatMessage({
                                id: `webRemoteControl.botChannel.${entry.provider}.description`,
                              })}
                            </span>
                            <span className="block text-ui-base font-medium text-primary">
                              {intl.formatMessage({
                                id: "webRemoteControl.botChannel.configure",
                              })}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      className="w-full justify-center gap-2 enabled:cursor-pointer"
                      onClick={handleOpenBotsDialog}
                    >
                      <BotIcon className="size-3.5" />
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.manageBots",
                      })}
                    </Button>
                  </div>
                </section>
              </TabsContent>
            </ScrollArea>
          </Tabs>
        </DialogContent>
      </Dialog>
      <AlertDialog open={refreshConfirmOpen} onOpenChange={setRefreshConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "webRemoteControl.refreshQr.confirmTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({
                id: "webRemoteControl.refreshQr.confirmDescription",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRefreshConfirmOpen(false);
                void remote.refreshPairing();
              }}
            >
              {intl.formatMessage({ id: "webRemoteControl.refreshQr" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <BotsDialog
        open={botsDialogOpen}
        onOpenChange={setBotsDialogOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        entryProvider={botEntryProvider}
      />
    </>
  );
});
