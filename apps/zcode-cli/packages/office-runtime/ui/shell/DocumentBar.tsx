import { type DocKind } from "#office/contract.ts";
import { type Strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import { baseName } from "#ui/rpc.ts";

export function DocumentBar({
  t,
  path,
  kind,
  menu,
  drawerOpen,
  drawerAvailable,
  ready,
  hasDocument,
  onDrawer,
  onSwitch,
  onFind,
  onMore,
}: {
  t: Strings;
  path: string | null;
  kind: DocKind | null;
  menu: "switch" | "more" | null;
  drawerOpen: boolean;
  drawerAvailable: boolean;
  ready: boolean;
  hasDocument: boolean;
  onDrawer(): void;
  onSwitch(): void;
  onFind(): void;
  onMore(): void;
}) {
  return (
    <header className="docbar">
      {path ? (
        <button
          type="button"
          className={`btn icon ${drawerOpen && drawerAvailable ? "secondary" : "dim"}`}
          title={t.pagesAndOutline}
          aria-label={t.pagesAndOutline}
          aria-pressed={drawerOpen && drawerAvailable}
          disabled={!drawerAvailable}
          hidden={kind === "xlsx"}
          onClick={onDrawer}
        >
          <Icon name="panel-left" />
        </button>
      ) : null}
      <button
        type="button"
        className={`doctitle${menu === "switch" ? " open" : ""}`}
        title={path ?? undefined}
        aria-haspopup="menu"
        aria-expanded={menu === "switch"}
        aria-label={`${t.switchDocument}: ${path ?? ""}`}
        data-menu-trigger=""
        onClick={onSwitch}
      >
        <span className="name">{path ? baseName(path) : t.title}</span>
        <Icon name="chevron-down" size={12} className="chev" />
      </button>
      <span className="spacer" />
      {hasDocument ? (
        <>
          <button
            type="button"
            className="btn icon dim"
            title={`${t.find} (Ctrl/⌘F)`}
            aria-label={t.find}
            disabled={!ready}
            onClick={onFind}
          >
            <Icon name="search" />
          </button>
          <button
            type="button"
            className={`btn icon dim${menu === "more" ? " active" : ""}`}
            title={t.more}
            aria-label={t.more}
            aria-haspopup="menu"
            aria-expanded={menu === "more"}
            data-menu-trigger=""
            onClick={onMore}
          >
            <Icon name="ellipsis" />
          </button>
        </>
      ) : null}
    </header>
  );
}
