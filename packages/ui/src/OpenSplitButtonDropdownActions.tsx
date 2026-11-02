import type { EditorInfo } from "@zcode/shared";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import { FileApplicationChoices, FileSaveAsMenuItem } from "@/file-menu/index.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";

// 下拉保持紧凑的平铺应用列表，保存副本与路径动作都可以直接发现。
export function OpenSplitButtonDropdownActions({
  target,
  sortedEditors,
  loadingEditors,
  handleOpenExternal,
  handleOpenInEditor,
  handleOpenDefault,
  canOpenWith,
}: {
  target:
    | { type: "website" }
    | {
        type: "file";
        path: string;
        label: string;
        previewSource?: {
          workspacePath?: string;
          workspaceIdentity?: string;
          workspaceRemoteSessionId?: string;
        };
      };
  sortedEditors: readonly (EditorInfo & { isDefault?: boolean })[];
  loadingEditors: boolean;
  handleOpenExternal: () => void;
  handleOpenInEditor: (editor: EditorInfo) => void;
  handleOpenDefault?: () => void;
  canOpenWith: boolean;
}) {
  const { intl } = useZCodeIntl();
  const fileActions = useFileContextActions();
  return (
    <>
      {target.type === "website" ? (
        <DropdownMenuItem onSelect={handleOpenExternal}>
          <ExternalLinkIcon className="size-4" />
          <span>
            {intl.formatMessage({
              id: "chat.previewCards.openExternal",
            })}
          </span>
        </DropdownMenuItem>
      ) : (
        <>
          {(handleOpenDefault || canOpenWith) && (
            <FileApplicationChoices
              applications={sortedEditors}
              loading={loadingEditors}
              onOpenDefault={handleOpenDefault}
              onSelect={handleOpenInEditor}
            />
          )}
          {(handleOpenDefault || canOpenWith) && <DropdownMenuSeparator />}
          <FileSaveAsMenuItem path={target.path} {...target.previewSource} />
          <DropdownMenuItem
            onSelect={() => void fileActions.copyAbsolutePath({ path: target.path })}
          >
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void fileActions.copyRelativePath({
                path: target.path,
                relativePath: target.previewSource?.workspacePath
                  ? getWorkspaceFileRelativePath(target.previewSource.workspacePath, target.path)
                  : target.label,
              })
            }
          >
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
