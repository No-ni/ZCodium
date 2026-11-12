import { createElement, useEffect, useMemo, useSyncExternalStore, type ReactElement } from "react";
import type { SharedMobileRootProps } from "./contract.js";
import { SharedMobileRootController } from "./app/controller.js";
import { registerMobileRootWorkspace } from "./adapters/workspace-registry.js";
import { createMobileBrowserPlatform } from "./adapters/browser-platform.js";
import { RootSurface } from "./ui/RootSurface.js";

export type { SharedMobileRootProps } from "./contract.js";

/** 依赖装配只借用配对传输与现有 browser primitive，不创建普通 Web Server 连接。 */
// 公共返回类型不能泄漏组件内部的 RootSurfaceProps。
export function SharedMobileRoot(props: SharedMobileRootProps): ReactElement {
  const { client, saveFile, onWorkspaceListUpdated } = props;
  const controller = useMemo(
    () =>
      new SharedMobileRootController(
        client,
        {
          registerWorkspace: registerMobileRootWorkspace,
          createPlatform: (access) => createMobileBrowserPlatform(client, access, saveFile),
        },
        onWorkspaceListUpdated,
      ),
    [client, saveFile, onWorkspaceListUpdated],
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    controller.update(props.connection, props.bootstrap);
  }, [controller, props.connection, props.bootstrap]);
  return createElement(RootSurface, {
    snapshot,
    title: props.title,
    description: props.description,
    notice: props.notice,
    onRetry: () => controller.retry(),
  });
}
