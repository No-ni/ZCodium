import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IGitService, IServiceAccessor } from "@zcode/services";
import type { GitRefreshResult } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";

// 仅测试当前 scope 的 proxy 生命周期；Git 返回值受控，不执行 Git/Agent/用户数据库。
const workspacePath = "/synthetic/repo";
const scenario = new URLSearchParams(location.search).get("scenario");
const pending = new Map<string, Array<(value: GitRefreshResult) => void>>();
const requests: string[] = [];
Object.assign(window, {
  gitServiceFixture: {
    requests: () => [...requests],
    complete(service: string, branchName = service) {
      const waiting = pending.get(service);
      const resolve = waiting?.shift();
      if (!resolve) throw new Error(`No pending Git request for ${service}`);
      if (waiting?.length === 0) pending.delete(service);
      resolve({
        summary: {
          workspacePath,
          repoRoot: workspacePath,
          workspaceInRepoPath: ".",
          autoRefreshWatchPaths: [{ path: `/synthetic/${branchName}/.git`, recursive: false }],
          branchName,
          trackingBranchName: null,
          headRefType: "branch",
          ahead: 0,
          behind: 0,
          isDirty: false,
          isGitAvailable: true,
          isRepository: true,
        },
        identity: null,
        unstagedChanges: [],
        stagedChanges: [],
        branchComparison: null,
      });
    },
  },
});
function services(name: string): IServiceAccessor {
  const gitService = {
    refresh: () =>
      new Promise<GitRefreshResult>((resolve) => {
        requests.push(name);
        const waiting = pending.get(name) ?? [];
        waiting.push(resolve);
        pending.set(name, waiting);
      }),
  } as IGitService;
  return { gitService } as IServiceAccessor;
}
const hostA = services("A");
const hostB = services("B");
function Repository({ includeExtendedData }: { includeExtendedData: boolean }) {
  const result = useGitRepository({
    workspacePath,
    activeTaskId: null,
    refreshToken: 0,
    includeExtendedData,
  });
  return (
    <>
      <output id="branch">{result.summary.branchName ?? ""}</output>
      <output id="loading">{String(result.loading)}</output>
      <output id="watch-paths">
        {result.summary.autoRefreshWatchPaths.map(({ path }) => path).join(",")}
      </output>
      <output id="error">{result.error ?? ""}</output>
    </>
  );
}
function Fixture() {
  const [current, setCurrent] = useState(hostA);
  const [includeExtendedData, setIncludeExtendedData] = useState(scenario === "pane");
  return (
    <>
      <button type="button" onClick={() => setCurrent(hostB)}>
        Replace service
      </button>
      <button type="button" onClick={() => setIncludeExtendedData(false)}>
        Close pane
      </button>
      <ServiceProvider services={current}>
        <Repository includeExtendedData={includeExtendedData} />
      </ServiceProvider>
    </>
  );
}
const content = <Fixture />;
createRoot(document.getElementById("root")!).render(
  scenario === "strict" ? <StrictMode>{content}</StrictMode> : content,
);
