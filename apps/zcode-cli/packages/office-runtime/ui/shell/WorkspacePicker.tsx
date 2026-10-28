import { useEffect, useRef, useState } from "react";
import { type Strings } from "#ui/i18n.ts";
import { FileType, Icon } from "#ui/icons.tsx";
import { baseName, dirName, listDocuments, type WorkspaceFile } from "#ui/rpc.ts";
import { describeFailure } from "#ui/shell/state.ts";

/** 只选工作区已有文件，取消不改变文档；没有 file input、上传或任何导入 RPC。 */
export function WorkspacePicker({
  t,
  onOpen,
  onClose,
}: {
  t: Strings;
  onOpen(path: string): void;
  onClose(): void;
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let active = true;
    previous.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    void listDocuments(true).then(
      (items) => {
        if (active) {
          setFiles(items);
          setLoading(false);
        }
      },
      (failure) => {
        if (active) {
          setError(describeFailure(t, failure, null).title);
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
      previous.current?.focus();
    };
  }, []);
  const matches = files.filter((file) => file.path.toLowerCase().includes(query.toLowerCase()));
  return (
    <section
      className="picker"
      role="dialog"
      aria-modal="true"
      aria-label={t.workspaceFiles}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (event.key === "Tab") {
          const elements = [...event.currentTarget.querySelectorAll<HTMLElement>("button, input")];
          const first = elements[0],
            last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="docbar">
        <span>{t.workspaceFiles}</span>
        <span className="spacer" />
        <button type="button" className="btn icon" aria-label={t.close} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <form
        className="picker-path"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) onOpen(query.trim());
        }}
      >
        <input
          ref={input}
          value={query}
          aria-label={t.workspacePath}
          placeholder={t.workspacePath}
          autoComplete="off"
          maxLength={1000}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <button type="submit" className="btn secondary" disabled={!query.trim()}>
          {t.openPath}
        </button>
      </form>
      <div className="picker-list" aria-busy={loading}>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        {loading ? <p role="status">{t.loadingFiles}</p> : null}
        {!loading && !error && !matches.length ? <p>{t.noWorkspaceFiles}</p> : null}
        <div className="filelist">
          {matches.map((file) => (
            <button
              type="button"
              className="fr"
              key={file.path}
              title={file.path}
              onClick={() => onOpen(file.path)}
            >
              <FileType kind={file.kind} />
              <span className="nm">{baseName(file.path)}</span>
              <span className="dir">{dirName(file.path)}</span>
            </button>
          ))}
        </div>
        <p className="footnote">{t.emptyCaption}</p>
      </div>
    </section>
  );
}
