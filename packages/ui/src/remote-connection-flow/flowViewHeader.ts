import { type ComponentProps } from "react";
import { formatRemoteDraftPreview } from "@/lib/remoteConnectionWizard.js";
import { RemoteConnectionWizardHeader } from "@/RemoteConnectionWizardChrome.js";
import type { RemoteFlowContext } from "./flowContext.js";
export function buildHeader(context: RemoteFlowContext) {
  const {
    completion,
    currentStep,
    cancelled,
    stepCopy,
    formSnapshot,
    minimizedRef,
    applyOpenState,
    handleCloseRequest,
    kind,
  } = context;
  return {
    currentStep,
    deviceManagement: completion === "device-management",
    hideHeading: currentStep === "connecting" && !cancelled,
    title: stepCopy.title,
    description: stepCopy.description,
    // 表单屏头部的实时目标预览，与连接页头部的「类型 + 等宽目标」同构（RDUX-27）。
    settingsPreview:
      currentStep === "settings"
        ? { kind, target: formatRemoteDraftPreview(formSnapshot) }
        : undefined,
    onMinimize: () => {
      // Bug 原因：收起按钮过去被 loading/connectedSessionId 门禁，填写配置和连接失败
      // 等 idle 步骤会看起来像功能被删除。收起始终只改 visibility；状态清理由关闭负责。
      minimizedRef.current = true;
      applyOpenState(false);
    },
    onClose: () => {
      // Bugfix: 关闭和收起的语义不同。关闭仍走确认和取消逻辑，避免已连接但未选目录的 session 泄漏。
      void handleCloseRequest();
    },
  } satisfies ComponentProps<typeof RemoteConnectionWizardHeader>;
}
