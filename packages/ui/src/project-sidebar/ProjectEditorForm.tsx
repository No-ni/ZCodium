import type { RefObject } from "react";
import {
  ChevronRight,
  Folder,
  FolderPlus,
  LoaderCircle,
  Monitor,
  Plus,
  Server,
  X,
} from "lucide-react";
import type { ProjectDevice, VirtualProject } from "@/project-sidebar/contract.js";
import { Button } from "@/components/ui/button.js";
import { DialogFooter } from "@/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import {
  resolveRemoteConnectionPresentation,
  type RemoteConnectionStatus,
} from "@/lib/remoteConnectionPresentation.js";

const FIELD_LABEL = "text-ui-sm font-medium text-foreground";
// SelectItem 的 ItemText 默认按内容收缩；撑满整行后状态才能靠右，长名称截断时不挤掉状态。
const DEVICE_ITEM = "pr-8 *:[span]:last:min-w-0 *:[span]:last:flex-1";

/** 设备行：图标 + 名称 + 状态；状态颜色只取远程连接展示模型，在线只留圆点。 */
function DeviceOption({ label, status }: { label: string; status?: string }) {
  const { intl } = useZCodeIntl();
  const presentation = status
    ? resolveRemoteConnectionPresentation({ state: status as RemoteConnectionStatus })
    : undefined;
  const Icon = status ? Server : Monitor;
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <Icon className="size-4 text-foreground-subtle" />
      <span className="min-w-0 truncate">{label}</span>
      {presentation ? (
        <span
          data-testid="virtual-project-device-status"
          data-status={status}
          className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle"
        >
          {presentation.icon === "spinner" ? (
            <LoaderCircle className={`size-3 animate-spin ${presentation.foreground}`} />
          ) : (
            <span className={`size-2 rounded-full ${presentation.dot}`} />
          )}
          <span className={status === "online" ? "sr-only" : undefined}>
            {intl.formatMessage({ id: `project.deviceStatus.${status}` })}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * 编辑器表单：只消费 ProjectEditor 给出的值与回调。
 * 草稿、确认请求与保存/删除仍在 ProjectEditor，本组件不持有状态、不调用服务。
 */
export function ProjectEditorForm({
  msg,
  intl,
  project,
  fixedFolder,
  devices,
  selectedDeviceId,
  selectedDevice,
  changeDevice,
  onAddDevice,
  onBrowseExisting,
  remote,
  name,
  setName,
  setNameEdited,
  roots,
  setRoots,
  primary,
  setPrimary,
  busy,
  created,
  needsConnection,
  browse,
  browseExisting,
  existingButton,
  saveButton,
  error,
  legacyDeviceId,
  hostId,
  remove,
  save,
  onClose,
}: {
  msg(id: string): string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  project: VirtualProject | null;
  fixedFolder?: { hostId: string; path: string; deviceLabel: string };
  devices?: ProjectDevice[];
  selectedDeviceId: string;
  selectedDevice?: ProjectDevice;
  changeDevice(next: string): Promise<void>;
  onAddDevice?(selectDevice: (id: string) => Promise<void>): void;
  onBrowseExisting?(device: ProjectDevice): Promise<boolean>;
  remote: boolean;
  name: string;
  setName(value: string): void;
  setNameEdited(value: boolean): void;
  roots: string[];
  setRoots(value: string[]): void;
  primary: string;
  setPrimary(value: string): void;
  busy: boolean;
  created: VirtualProject | null;
  needsConnection: boolean;
  browse(): Promise<void>;
  browseExisting(): Promise<void>;
  existingButton: RefObject<HTMLButtonElement | null>;
  saveButton: RefObject<HTMLButtonElement | null>;
  error: string | null;
  legacyDeviceId: string | null;
  hostId?: string;
  remove(): Promise<void>;
  save(): Promise<void>;
  onClose(): void;
}) {
  return (
    <>
      <div className="grid min-w-0 gap-1.5">
        <label htmlFor="project-name" className={FIELD_LABEL}>
          {msg("name")}
        </label>
        <Input
          id="project-name"
          aria-label={msg("name")}
          placeholder={msg("new")}
          autoFocus
          disabled={busy || Boolean(created)}
          data-testid="virtual-project-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setNameEdited(true);
          }}
          className="h-9 rounded-lg max-md:text-mobile-input-safe"
        />
        {fixedFolder ? (
          <p className="break-all text-ui-sm text-foreground-subtle">{fixedFolder.deviceLabel}</p>
        ) : null}
      </div>
      {devices ? (
        <div className="grid min-w-0 gap-1.5">
          <label htmlFor="project-device" className={FIELD_LABEL}>
            {msg("device")}
          </label>
          <Select
            value={selectedDeviceId}
            onValueChange={(value) => {
              if (value === "add-device") onAddDevice?.(changeDevice);
              else void changeDevice(value);
            }}
            disabled={busy || Boolean(created)}
          >
            <SelectTrigger
              id="project-device"
              data-testid="virtual-project-device"
              className="h-9 w-full min-w-0 rounded-lg *:data-[slot=select-value]:w-full *:data-[slot=select-value]:min-w-0"
            >
              <SelectValue>
                <DeviceOption
                  label={
                    selectedDeviceId === "local"
                      ? msg("thisComputer")
                      : (selectedDevice?.label ?? selectedDeviceId)
                  }
                  status={
                    selectedDeviceId === "local" ? undefined : (selectedDevice?.status ?? "offline")
                  }
                />
              </SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" className="w-(--radix-select-trigger-width)">
              <SelectItem value="local" data-device-id="local" className={DEVICE_ITEM}>
                <DeviceOption label={msg("thisComputer")} />
              </SelectItem>
              {devices.map((device) => (
                <SelectItem
                  key={device.id}
                  value={device.id}
                  data-device-id={device.id}
                  className={DEVICE_ITEM}
                >
                  <DeviceOption label={device.label} status={device.status} />
                </SelectItem>
              ))}
              {onAddDevice ? (
                <>
                  <SelectSeparator />
                  <SelectItem value="add-device">
                    <Plus className="text-foreground-subtle" />
                    {msg("addRemoteDevice")}
                  </SelectItem>
                </>
              ) : null}
            </SelectContent>
          </Select>
          {/* 旧入口是一行 ghost 文字，用户看不出可点也不知用途；改为挨着设备的问句 + 下划线链接。 */}
          {remote && selectedDevice && onBrowseExisting ? (
            <p className="flex flex-wrap items-center gap-x-1 text-ui-sm text-foreground-subtle">
              {msg("existingOnDeviceHint")}
              <button
                ref={existingButton}
                type="button"
                disabled={busy || Boolean(created)}
                data-testid="virtual-project-existing"
                className="inline-flex items-center gap-0.5 rounded-sm text-brand underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
                onClick={() => void browseExisting()}
              >
                {msg("existingOnDeviceAction")}
                <ChevronRight className="size-3.5" />
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
      <fieldset disabled={busy || Boolean(created)} className="min-w-0">
        <legend className={`mb-1.5 ${FIELD_LABEL}`}>{msg("folders")}</legend>
        {/* 有目录时使用同一列表的末行添加，只有零目录才展示空态大卡片。 */}
        <div
          data-testid={roots.length ? "virtual-project-roots" : undefined}
          className={
            roots.length
              ? "min-w-0 overflow-hidden rounded-lg border border-border divide-y divide-border"
              : undefined
          }
        >
          {roots.map((root) => (
            <div
              className="flex min-h-12 min-w-0 items-center gap-2 px-3 py-2"
              key={root}
              data-testid="virtual-project-root-row"
            >
              <Folder className="size-4 shrink-0 text-foreground-subtle" />
              <span
                className={
                  fixedFolder
                    ? "min-w-0 flex-1 break-all text-ui-base"
                    : "min-w-0 flex-1 truncate text-ui-base"
                }
                title={root}
                data-testid="virtual-project-root-name"
              >
                {fixedFolder ? root : getPathLeaf(root)}
              </span>
              {root === primary ? (
                <span
                  data-testid="virtual-project-primary"
                  className="inline-flex h-7 shrink-0 items-center rounded-md border border-border px-2 text-ui-base text-foreground-subtle"
                >
                  {msg("primaryBadge")}
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-foreground-subtle"
                  data-testid="virtual-project-set-primary"
                  onClick={() => setPrimary(root)}
                >
                  {msg("setPrimary")}
                </Button>
              )}
              {!fixedFolder && (!remote || !project) ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-foreground-subtle"
                  data-testid="virtual-project-remove-folder"
                  aria-label={msg("removeFolder")}
                  onClick={() => {
                    const next = roots.filter((item) => item !== root);
                    setRoots(next);
                    if (primary === root) setPrimary(next[0] ?? "");
                  }}
                >
                  <X className="size-4" />
                </Button>
              ) : null}
            </div>
          ))}
          {!fixedFolder && (!remote || !project) ? (
            <button
              type="button"
              data-testid="virtual-project-browse"
              aria-label={msg(needsConnection ? "connectAndBrowse" : "browse")}
              className={`group flex w-full items-center gap-2 text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 ${roots.length ? "min-h-12 px-3 py-2 text-left" : "min-h-32 flex-col justify-center rounded-lg border border-dashed border-border px-4 py-5 text-center hover:border-border-hover"}`}
              onClick={() => {
                void browse();
              }}
            >
              {roots.length ? (
                <>
                  <FolderPlus className="size-4 shrink-0 text-foreground-subtle" />
                  <span>{msg(needsConnection ? "connectAndBrowse" : "addSourceFolder")}</span>
                </>
              ) : (
                <>
                  <span className="flex size-9 items-center justify-center rounded-full bg-surface text-foreground-subtle group-hover:text-foreground">
                    <FolderPlus className="size-4" />
                  </span>
                  <span className="font-medium">
                    {msg(needsConnection ? "connectAndBrowse" : "browse")}
                  </span>
                  <span className="text-ui-sm text-foreground-subtle">
                    {needsConnection
                      ? intl.formatMessage(
                          { id: "project.connectAndBrowseHint" },
                          {
                            status: msg(`deviceStatus.${selectedDevice?.status ?? "offline"}`),
                          },
                        )
                      : msg("browseHint")}
                  </span>
                </>
              )}
            </button>
          ) : null}
        </div>
      </fieldset>
      {legacyDeviceId === hostId ? (
        <p className="text-ui-sm text-foreground-subtle">{msg("legacyUpgradeRequired")}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter className="flex-row flex-wrap items-center justify-end">
        {project ? (
          <Button
            variant="ghost"
            data-testid="virtual-project-editor-delete"
            disabled={busy || Boolean(created)}
            onClick={() => {
              void remove();
            }}
            className="mr-auto bg-destructive-surface text-destructive-surface-foreground hover:bg-destructive-surface hover:text-destructive-surface-foreground"
          >
            {msg("delete")}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onClose} disabled={busy && !fixedFolder}>
          {msg("cancel")}
        </Button>
        <Button
          ref={saveButton}
          data-testid="virtual-project-save"
          onClick={() => {
            void save();
          }}
          disabled={busy || (remote && (roots.length !== 1 || legacyDeviceId === hostId))}
        >
          {project ? msg("save") : msg("create")}
        </Button>
      </DialogFooter>
    </>
  );
}
