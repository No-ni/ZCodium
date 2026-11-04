import type { UpdateStatePayload } from "@zcode/shared";

/** 帮助菜单的平台契约夹具：只保存内存状态，不调用真实原生操作或更新源。 */
export function createHelpMenuFixture(params: URLSearchParams, calls: { helpActions: string[] }) {
  const listeners = new Set<(state: UpdateStatePayload) => void>();
  let releaseRead: ((state: UpdateStatePayload) => void) | undefined;
  let failure = false;
  async function run(id: string) {
    calls.helpActions.push(id);
    if (failure) throw new Error("E2E_HELP_RAW_FAILURE");
  }
  return {
    platform: {
      executeDesktopCommand: (id: string) => run(id),
      openFeedback: () => run("feedback"),
      openCommunity: () => run("community"),
      openExternal: () => run("docs"),
      getUpdateState: async (): Promise<UpdateStatePayload> =>
        params.get("view") === "help-menu"
          ? new Promise((resolve) => {
              releaseRead = resolve;
            })
          : { kind: "idle", enabled: false },
      onUpdateStateChanged: (callback: (state: UpdateStatePayload) => void) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    },
    actions: {
      setHelpFailure: (value: boolean) => {
        failure = value;
      },
      emitHelpUpdate: (state: UpdateStatePayload) => {
        for (const callback of listeners) callback(state);
      },
      releaseHelpUpdateRead: (state: UpdateStatePayload) => releaseRead?.(state),
    },
  };
}
