import { formatProjectError } from "@/project-sidebar/view.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useEffect, useRef, useState } from "react";
import type { VirtualProject } from "@/project-sidebar/contract.js";
import { useRemoteBoundaryAcknowledgement } from "@/RemoteConnectionDialogContent.js";
import { useProjectDirectoryServices } from "@/project-sidebar/useProjectDirectoryServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import type { ProjectFolderTrustRequest } from "@/project-sidebar/ProjectFolderTrustDialog.js";
import { ProjectEditorDialog } from "@/project-sidebar/ProjectEditorDialog.js";
import type { ProjectEditorProps } from "@/project-sidebar/projectEditorTypes.js";

export function ProjectEditor({
  project,
  host,
  initialRoots = [],
  fixedFolder,
  isCurrent = () => true,
  projects,
  service,
  onClose,
  onSaved,
  onDeleted,
  devices,
  defaultDeviceId,
  suspended = false,
  onBeforeSave,
  onConnectDevice,
  onAddDevice,
  remoteService,
  onBrowseExisting,
  onPrepareExisting,
  onSavedExisting = async () => undefined,
}: ProjectEditorProps) {
  const { intl } = useZCodeIntl();
  const sidebar = useOptionalProjectDirectory();
  const platform = useOptionalPlatform();
  const [selectedDeviceId, setSelectedDeviceId] = useState(defaultDeviceId ?? "local");
  const hostId =
    project?.hostId ?? fixedFolder?.hostId ?? host?.id ?? (devices ? selectedDeviceId : undefined);
  const remote = Boolean(hostId && hostId !== "local");
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  const [name, setName] = useState(
    project?.name ?? (fixedFolder ? getPathLeaf(fixedFolder.path) : ""),
  );
  const [nameEdited, setNameEdited] = useState(false);
  const [roots, setRoots] = useState(
    project?.roots.map((root) => root.rootPath) ??
      (fixedFolder ? [fixedFolder.path] : initialRoots),
  );
  const [primary, setPrimary] = useState(
    project?.roots.find((root) => root.isPrimary)?.rootPath ??
      fixedFolder?.path ??
      initialRoots[0] ??
      "",
  );
  const [existing, setExisting] = useState(false);
  const [legacyDeviceId, setLegacyDeviceId] = useState<string | null>(null);
  const existingButton = useRef<HTMLButtonElement>(null);
  const [browsing, setBrowsing] = useState(false);
  const directory = useProjectDirectoryServices(service, hostId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<VirtualProject | null>(null);
  const [folderTrust, setFolderTrust] = useState<ProjectFolderTrustRequest | null>(null);
  const saveFlight = useRef<{ cancelTrust?: () => void } | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const confirm = useConfirmDialog();
  const acknowledgeBoundary = useRemoteBoundaryAcknowledgement();
  const epoch = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
      saveFlight.current?.cancelTrust?.();
    };
  }, []);
  useEffect(() => {
    // 父表单切到后台后，连同尚未完成的恢复查询一起失效，避免返回前台后旧查询重新弹出确认。
    if (suspended && saveFlight.current) {
      epoch.current++;
      saveFlight.current.cancelTrust?.();
    }
  }, [suspended]);
  const current = (request: number) => alive.current && epoch.current === request;
  const selectedDevice = devices?.find((device) => device.id === selectedDeviceId);
  const changeDevice = async (next: string) => {
    if (next === selectedDeviceId) return;
    const request = ++epoch.current;
    // 确认前不提交任何字段；旧目录响应也随此次设备选择失效，避免跨设备污染草稿。
    if (
      roots.length &&
      !(await confirm({ title: msg("switchDevice"), description: msg("switchDeviceDescription") }))
    )
      return;
    if (!current(request)) return;
    setRoots([]);
    setPrimary("");
    setBrowsing(false);
    setError(null);
    setSelectedDeviceId(next);
  };
  const addRoots = (values: string[]) => {
    if (remote && project) return;
    const next = remote
      ? values.filter(Boolean).slice(0, 1)
      : [...new Set([...roots, ...values.filter(Boolean)])];
    setRoots(next);
    if (remote || !roots.length) setPrimary(next[0] ?? "");
    setBrowsing(false);
  };
  const browse = async () => {
    const request = ++epoch.current;
    if (remote && devices && selectedDevice?.status !== "online") {
      if (!selectedDevice || !onConnectDevice) {
        setError(msg("connectionUnavailable"));
        return;
      }
      setBusy(true);
      try {
        const ready = await onConnectDevice(selectedDevice);
        if (current(request) && ready) setBrowsing(true);
      } catch (cause) {
        if (current(request)) setError(formatProjectError(cause, intl.formatMessage));
      } finally {
        if (current(request)) setBusy(false);
      }
      return;
    }
    // 本地曾统一走 Host 文件列表，绕过系统多选；按项目 Host 与平台能力选入口，不能借当前 tab 判定。
    if ((hostId && hostId !== "local") || !platform?.selectDirectories) {
      if (remote) {
        setBusy(true);
        try {
          // 已连接设备可直接浏览目录，仍须经过与主动连接相同的首次介绍；失效表单不记已读。
          if (!(await acknowledgeBoundary(() => current(request) && !suspendedRef.current))) return;
        } finally {
          if (current(request)) setBusy(false);
        }
      }
      if (current(request) && !suspendedRef.current) setBrowsing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const selected = await platform.selectDirectories();
      logger.debug("[ProjectEditor] native directory selection", { count: selected.length });
      if (current(request) && selected.length) addRoots(selected);
    } catch (cause) {
      logger.warn("[ProjectEditor] native directory selection failed", cause);
      if (current(request)) setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      if (current(request)) setBusy(false);
    }
  };
  const save = async () => {
    if (saveFlight.current || suspendedRef.current || !isCurrent()) return;
    const flight: { cancelTrust?: () => void } = {};
    saveFlight.current = flight;
    const request = epoch.current;
    const canCommit = () => current(request) && !suspendedRef.current && isCurrent();
    setBusy(true);
    setError(null);
    try {
      if (created) {
        await onSaved(created);
        if (canCommit()) onClose();
        return;
      }
      if (remote && (roots.length !== 1 || (project && project.roots[0]?.rootPath !== roots[0]))) {
        throw new Error("project.remote-single-root-required");
      }
      let restoreProject: VirtualProject | undefined;
      if (!project) {
        // 设备全集不等于本机项目入口全集；远端恢复候选必须读取所属 Host，不能只看 open set。
        const tree =
          remote && (devices || fixedFolder)
            ? await service.readTree({ hostId, includeDeleted: true })
            : undefined;
        if (tree?.legacySingleRoot) {
          setLegacyDeviceId(hostId!);
          throw new Error(msg("legacyUpgradeRequired"));
        }
        const candidates = tree?.projects ?? projects;
        if (!canCommit()) return;
        const deleted = candidates.find(
          (candidate) =>
            candidate.deleted &&
            (!hostId || candidate.hostId === hostId) &&
            candidate.roots.length === roots.length &&
            candidate.roots.every((root) => roots.includes(root.rootPath)),
        );
        if (
          deleted &&
          (await confirm({
            title: msg("restore"),
            description: intl.formatMessage(
              { id: "project.restoreDescription" },
              { name: deleted.name },
            ),
          }))
        )
          restoreProject = deleted;
      }
      if (!canCommit()) return;
      if (!project && roots.length) {
        const accepted = await new Promise<boolean>((resolve) => {
          const finish = (value: boolean) => {
            if (!flight.cancelTrust) return;
            flight.cancelTrust = undefined;
            if (alive.current) setFolderTrust(null);
            resolve(value);
          };
          flight.cancelTrust = () => finish(false);
          setFolderTrust({
            roots: [...roots],
            deviceLabel: remote
              ? (fixedFolder?.deviceLabel ??
                selectedDevice?.label ??
                (host ? remoteHostLabel(host) : hostId!))
              : undefined,
            restoring: Boolean(restoreProject),
            projectName: fixedFolder
              ? (nameEdited ? name.trim() : restoreProject?.name) || getPathLeaf(fixedFolder.path)
              : undefined,
            resolve: finish,
          });
        });
        logger.debug("[ProjectEditor] folder confirmation", {
          accepted,
          remote,
          count: roots.length,
        });
        if (!accepted || !canCommit()) return;
      }
      await onBeforeSave?.(hostId ?? "local");
      if (!canCommit()) return;
      const saved = await service.saveProject({
        ...(hostId ? { hostId } : {}),
        ...(project ? { id: project.id } : {}),
        ...(restoreProject ? { restoreProjectId: restoreProject.id } : {}),
        ...(nameEdited ? { name: name.trim() } : {}),
        defaultName: msg("new"),
        roots,
        ...(primary ? { primaryRoot: primary } : {}),
      });
      if (!alive.current) return;
      // 远端创建与本机入口登记分两步；登记失败重试必须复用已创建的项目，不能再生成一个 ID。
      if (!project) setCreated(saved);
      // 外层聊天可能已换代；保留已保存结果，但不继续登记、导航或关闭新流程。
      if (!canCommit()) return;
      if (!project && !remote) sidebar?.preferences.prepend(saved);
      await onSaved(saved);
      // 草稿可能已被关闭或替换；旧登记结果不能关闭后来创建的表单。
      if (canCommit()) onClose();
    } catch (cause) {
      if (canCommit()) setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      if (saveFlight.current === flight) saveFlight.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const remove = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      // 编辑器曾漏掉删除入口；复用所属 Host 的软删除，不触碰文件或任务。
      await service.deleteProject(project.id, project.hostId);
      await onDeleted?.();
      onClose();
    } catch (cause) {
      setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      setBusy(false);
    }
  };
  const browseExisting = async () => {
    if (!selectedDevice || !onBrowseExisting) return;
    const request = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      if ((await onBrowseExisting(selectedDevice)) && current(request)) setExisting(true);
    } catch (cause) {
      if (current(request)) setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      if (current(request)) setBusy(false);
    }
  };
  const browserEpoch = epoch.current;
  const needsConnection = remote && Boolean(devices) && selectedDevice?.status !== "online";
  const changeDialogOpen = (open: boolean) => {
    if (!open)
      logger.debug("[ProjectEditor] close requested", {
        busy,
        confirming: Boolean(folderTrust),
      });
    if (!open && (!busy || fixedFolder)) onClose();
  };
  const selectDirectory = (path: string) => {
    if (current(browserEpoch)) addRoots([path]);
  };
  const cancelBrowsing = () => {
    epoch.current++;
    setBrowsing(false);
  };
  const closeExistingList = () => {
    epoch.current++;
    setExisting(false);
    requestAnimationFrame(() => existingButton.current?.focus());
  };
  const reportLegacyCapability = (legacy: boolean) => {
    setLegacyDeviceId(legacy ? (selectedDevice?.id ?? null) : null);
  };
  const restoreTrustFocus = () => {
    if (alive.current && !suspendedRef.current) saveButton.current?.focus();
  };
  return (
    <ProjectEditorDialog
      suspended={suspended}
      folderTrust={folderTrust}
      existing={existing}
      remoteService={remoteService}
      service={service}
      onPrepareExisting={onPrepareExisting}
      onSavedExisting={onSavedExisting}
      browsing={browsing}
      directoryServices={directory.services}
      changeDialogOpen={changeDialogOpen}
      reportLegacyCapability={reportLegacyCapability}
      closeExistingList={closeExistingList}
      selectDirectory={selectDirectory}
      cancelBrowsing={cancelBrowsing}
      restoreTrustFocus={restoreTrustFocus}
      form={{
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
      }}
    />
  );
}
