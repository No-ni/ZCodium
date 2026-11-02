import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ArtifactKindIcon,
  artifactOpenAsFileName,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { ArtifactOpenAsFileButton } from "@/file-menu/index.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

/**
 * 产物查看 tab 的头部：标题 / 版本导航 / 操作按钮 / 作者说明。
 *
 * 纯受控展示组件：状态、派生与 hook 都留在父 `WorkflowArtifactView`（唯一 owner），
 * 这里只按 props 渲染，自身不调用任何 hook——`intl` 也由父注入而非在此读 context。
 * 从 `WorkflowArtifactSidePane.tsx` 拆出是为了父文件的行数上限（max-lines 400）。
 */
export function WorkflowArtifactHeader({
  artifact,
  title,
  kindLabel,
  intl,
  version,
  versionIndex,
  availableVersions,
  onSelectVersion,
  openAsFile,
  openAsFileBytes,
  runId,
  reveal,
  revealInMenu,
  copyable,
  copied,
  onCopy,
}: {
  artifact: WorkflowRunArtifactView;
  title: string;
  kindLabel: string;
  intl: IntlShape;
  version: number;
  versionIndex: number;
  availableVersions: readonly number[];
  onSelectVersion: (version: number) => void;
  openAsFile: boolean;
  openAsFileBytes: Uint8Array<ArrayBuffer> | null;
  runId: string;
  reveal?: () => void;
  revealInMenu: boolean;
  copyable: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <header className="shrink-0 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {/* 与产物药丸同一枚方形瓦片：tab 头就是那枚药丸长大了。 */}
        <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-surface-hover text-foreground-subtle">
          <ArtifactKindIcon className="size-3.5" kind={artifact.kind} />
        </span>
        <h2
          className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
          data-testid="workflow-artifact-title"
          title={title}
        >
          {title}
        </h2>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-ui-sm text-foreground-subtle">{kindLabel}</span>
        <ArtifactVersionStepper
          availableVersions={availableVersions}
          intl={intl}
          onSelect={onSelectVersion}
          version={version}
          versionIndex={versionIndex}
        />
        <div className="ml-auto flex items-center gap-1">
          {openAsFile ? (
            <ArtifactOpenAsFileButton
              artifactId={artifact.id}
              bytes={openAsFileBytes}
              fileName={artifactOpenAsFileName(artifact, version)}
              runId={runId}
              version={version}
              {...(reveal === undefined ? {} : { onReveal: reveal })}
            />
          ) : null}
          {!revealInMenu && reveal !== undefined ? (
            <Button
              data-testid="workflow-artifact-reveal"
              onClick={reveal}
              size="sm"
              type="button"
              variant="ghost"
            >
              <FolderOpenIcon aria-hidden="true" className="size-3.5" />
              {intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" })}
            </Button>
          ) : null}
          {copyable ? (
            <Button
              data-testid="workflow-artifact-copy"
              onClick={onCopy}
              size="sm"
              type="button"
              variant="ghost"
            >
              <CopyIcon aria-hidden="true" className="size-3.5" />
              {intl.formatMessage({
                id: copied
                  ? "chat.toolCall.workflow.run.artifacts.copied"
                  : "chat.toolCall.workflow.run.artifacts.copy",
              })}
            </Button>
          ) : null}
        </div>
      </div>
      {/* 作者写的说明（用户语言）；缺席即整行不渲染。 */}
      {artifact.description === undefined ? null : (
        <p className="mt-1.5 text-ui-sm text-foreground-subtle">{artifact.description}</p>
      )}
    </header>
  );
}

/**
 * 版本步进器 `‹ v2 / 3 ›`。只有一版时整块缺席——一个永远两端禁用的步进器只是噪声。
 *
 * 按**已知版本的数组**翻而不是按数字加减：journal 读不到时数组里只有最新版一个数，
 * 那时步进器自然消失，而不是给出一批取不到字节的版本号。
 */
function ArtifactVersionStepper({
  availableVersions,
  version,
  versionIndex,
  onSelect,
  intl,
}: {
  availableVersions: readonly number[];
  version: number;
  versionIndex: number;
  onSelect: (version: number) => void;
  intl: IntlShape;
}) {
  if (availableVersions.length <= 1) {
    return (
      <span
        className="font-mono text-ui-xs text-foreground-subtlest"
        data-testid="workflow-artifact-version"
      >
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.run.artifacts.version" },
          { version: String(version) },
        )}
      </span>
    );
  }
  const previous = availableVersions[versionIndex - 1];
  const next = availableVersions[versionIndex + 1];
  return (
    <div className="flex items-center gap-0.5" data-testid="workflow-artifact-version-stepper">
      <Button
        aria-label={intl.formatMessage({
          id: "chat.toolCall.workflow.run.artifacts.previousVersion",
        })}
        data-testid="workflow-artifact-version-previous"
        disabled={previous === undefined}
        onClick={() => (previous === undefined ? undefined : onSelect(previous))}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      </Button>
      <span
        className="font-mono text-ui-xs text-foreground-subtle"
        data-testid="workflow-artifact-version"
      >
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.run.artifacts.versionOf" },
          { total: String(availableVersions.length), version: String(version) },
        )}
      </span>
      <Button
        aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.nextVersion" })}
        data-testid="workflow-artifact-version-next"
        disabled={next === undefined}
        onClick={() => (next === undefined ? undefined : onSelect(next))}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronRightIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}
