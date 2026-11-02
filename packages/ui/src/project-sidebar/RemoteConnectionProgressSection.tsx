import { useState } from "react";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { buildRemoteHostWorkspaceIdentity, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { RemoteProjectHost } from "@/project-sidebar/contract.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useRemoteDevicePresentationInput } from "@/hooks/useSourceServerStatuses.js";
import {
  classifyRemoteConnectionError,
  type RemoteConnectionStatus,
} from "@/lib/remoteConnectionPresentation.js";

/** 与 Host 侧 resolveProjectHostService 相同的解析；URL Server 直连不属于 Source 管理域。 */
function sourceServerIdForHost(host: RemoteProjectHost): string | undefined {
  if (host.target?.kind === "server") return undefined;
  return parseRemoteWorkspaceIdentity(buildRemoteHostWorkspaceIdentity(host.id, "/"))
    ?.sourceServerId;
}

/** 身份详情只读现有连接状态；失败原因使用固定分类，不依赖退休操作历史。 */
export function RemoteConnectionProgressSection({
  host,
  status,
  error,
}: {
  host: RemoteProjectHost;
  status: RemoteConnectionStatus;
  error?: string;
}) {
  const { intl } = useZCodeIntl();
  const sourceServerId = sourceServerIdForHost(host);
  const device = useRemoteDevicePresentationInput(sourceServerId);
  const connecting = status === "connecting";
  // 修复原因：布尔值会让新错误沿用“已复制”；记录被复制的原文，错误变化后自然失效。
  const [copiedError, setCopiedError] = useState<string>();
  const msg = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);

  if (connecting) {
    // 管理合同不再提供操作历史；详情只呈现已知连接态，不猜测安装阶段或进度。
    return (
      <div
        data-testid="remote-connection-progress"
        className="mt-3 rounded-lg bg-progress-surface px-2.5 py-2"
      >
        <div className="flex items-center gap-2 font-medium text-progress-surface-foreground">
          <LoaderCircle
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          />
          <span>{msg("workspaceSidebar.connecting")}</span>
        </div>
      </div>
    );
  }

  if (!error || (status !== "failed" && status !== "offline")) return null;
  const reason = classifyRemoteConnectionError({
    errorCode: device?.errorCode,
    error,
    target: host.target ?? undefined,
  });
  return (
    <div
      data-testid="remote-connection-failure"
      className="mt-3 rounded-lg bg-destructive-surface px-2.5 py-2 text-destructive-surface-foreground"
    >
      <div className="break-words font-medium">{msg(reason.titleId, reason.values)}</div>
      <div className="mt-0.5 break-words">{msg(reason.reasonId, reason.values)}</div>
      <button
        type="button"
        data-testid="remote-connection-copy-error"
        className="mt-1.5 inline-flex items-center gap-1 hover:underline"
        onClick={() => {
          void navigator.clipboard
            .writeText(error)
            .then(() => setCopiedError(error))
            .catch((cause) => {
              logger.warn("[project-sidebar] 复制连接错误失败", cause);
              toast(String(cause));
            });
        }}
      >
        {copiedError === error ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
        {msg(copiedError === error ? "remote.progress.copied" : "remote.progress.copyError")}
      </button>
    </div>
  );
}
