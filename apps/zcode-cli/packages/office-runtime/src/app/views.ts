import type { DocKind, Selection, ViewState } from "#office/contract.ts";
import { cut } from "#office/domain/text.ts";

export interface ViewReport {
  viewId?: string;
  path: string;
  at?: string | null;
  selection?: Selection | null;
}

const emptyView = (): ViewState => ({
  path: null,
  kind: null,
  at: null,
  selection: null,
  updatedAt: 0,
});

/** In-memory window reports; DocumentOwner holds exactly one instance of this owner. */
export function createViewReports(
  resolve: (input: string) => Promise<{ path: string; kind: DocKind }>,
) {
  const views = new Map<string, ViewState>();
  const reports = new Map<string, number>();
  let sequence = 0;
  return {
    async report(input: ViewReport): Promise<ViewState> {
      const viewId = input.viewId ?? "legacy";
      const ticket = ++sequence;
      reports.set(viewId, ticket);
      const { path, kind } = await resolve(input.path);
      const view: ViewState = {
        path,
        kind,
        at: input.at ? cut(input.at, 0, 300) : null,
        selection: input.selection?.at
          ? { at: cut(input.selection.at, 0, 300), text: cut(input.selection.text ?? "", 0, 2000) }
          : null,
        updatedAt: Date.now(),
      };
      // 中文说明：多窗口不能共用最后写者；旧异步上报不能覆盖新票号，也不能复活已释放窗口。
      if (reports.get(viewId) !== ticket) return views.get(viewId) ?? emptyView();
      views.set(viewId, view);
      return view;
    },
    list: () => [...views].map(([viewId, view]) => ({ viewId, ...view })),
    release(viewId: string) {
      reports.delete(viewId);
      views.delete(viewId);
    },
    get: (viewId?: string): ViewState =>
      viewId
        ? (views.get(viewId) ?? emptyView())
        : views.size === 1
          ? views.values().next().value!
          : emptyView(),
    close() {
      reports.clear();
      views.clear();
    },
  };
}
