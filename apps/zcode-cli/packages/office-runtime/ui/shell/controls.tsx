import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { type Strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import type { PageState, ZoomState } from "#ui/viewers/types.ts";

/* ---------------------------------------------------------------- Menu */

/** ZCode dropdown: closes on Escape and on any pointer press outside it. */
export function Menu({
  className,
  onClose,
  children,
  label,
}: {
  className: string;
  onClose(): void;
  children: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!ref.current?.contains(target) && !target.closest?.("[data-menu-trigger]")) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    ref.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  const move = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return (
    <div ref={ref} className={`menu ${className}`} role="menu" aria-label={label} onKeyDown={move}>
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  checked,
  children,
  hint,
  onSelect,
}: {
  icon?: ReactNode;
  checked?: boolean;
  children: ReactNode;
  hint?: ReactNode;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className="mi"
      onClick={onSelect}
    >
      <span className="mi-icon">{checked ? <Icon name="check" size={16} /> : icon}</span>
      <span className="mi-label">{children}</span>
      {hint ? <span className="mi-hint">{hint}</span> : null}
    </button>
  );
}

/* ---------------------------------------------------------------- Find */

export function FindBar({
  t,
  query,
  total,
  index,
  onQuery,
  onStep,
  onClose,
}: {
  t: Strings;
  query: string;
  total: number | null;
  index: number;
  onQuery(query: string): void;
  onStep(direction: 1 | -1): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const count =
    !query.trim() || total === null ? "" : total ? t.findCount(index + 1, total) : t.noResults;
  return (
    <div className="docbar findbar" role="search">
      <label className="findfield">
        <Icon name="search" className="muted" />
        <input
          ref={input}
          className="find-input"
          type="text"
          aria-label={t.find}
          placeholder={t.findPlaceholder}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onStep(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <span className="count" aria-live="polite">
          {count}
        </span>
      </label>
      <button
        type="button"
        className="btn icon dim"
        title={t.previousMatch}
        aria-label={t.previousMatch}
        disabled={!total}
        onClick={() => onStep(-1)}
      >
        <Icon name="chevron-up" />
      </button>
      <button
        type="button"
        className="btn icon dim"
        title={t.nextMatch}
        aria-label={t.nextMatch}
        disabled={!total}
        onClick={() => onStep(1)}
      >
        <Icon name="chevron-down" />
      </button>
      <button
        type="button"
        className="btn icon dim"
        title={t.closeFind}
        aria-label={t.closeFind}
        onClick={onClose}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- Page / zoom pill */

const IDLE_MS = 1500;

/**
 * Floating page and zoom control. Shown while scrolling, while the pointer is near the bottom edge,
 * while focused or hovered; fades out after 1.5 s of stillness.
 */
export function PagePill({
  t,
  frame,
  page,
  zoom,
  onPage,
  onZoom,
  onFit,
}: {
  t: Strings;
  frame: RefObject<HTMLElement | null>;
  page: PageState;
  zoom: ZoomState | null;
  onPage(page: number): void;
  onZoom(direction: 1 | -1): void;
  onFit(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [draft, setDraft] = useState<string | null>(null);
  const hold = useRef(false);
  useEffect(() => {
    const container = frame.current;
    if (!container) return;
    let timer = 0;
    const idle = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!hold.current && !ref.current?.contains(document.activeElement)) setVisible(false);
      }, IDLE_MS);
    };
    const wake = () => {
      setVisible(true);
      idle();
    };
    const near = (event: PointerEvent) => {
      const bounds = container.getBoundingClientRect();
      if (event.clientY > bounds.bottom - 80) wake();
    };
    container.addEventListener("scroll", wake, { capture: true, passive: true });
    container.addEventListener("pointermove", near, { passive: true });
    idle();
    return () => {
      clearTimeout(timer);
      container.removeEventListener("scroll", wake, { capture: true });
      container.removeEventListener("pointermove", near);
    };
  }, [frame]);
  const go = () => {
    const value = Number(draft);
    setDraft(null);
    if (Number.isInteger(value) && value >= 1) onPage(Math.min(value, page.count));
  };
  return (
    <div
      ref={ref}
      className={`pill${visible ? "" : " faded"}`}
      onPointerEnter={() => {
        hold.current = true;
        setVisible(true);
      }}
      onPointerLeave={() => {
        hold.current = false;
      }}
      onFocus={() => setVisible(true)}
    >
      <button
        type="button"
        className="btn icon sm dim"
        title={t.previousPage}
        aria-label={t.previousPage}
        disabled={page.current <= 1}
        onClick={() => onPage(page.current - 1)}
      >
        <Icon name="chevron-up" />
      </button>
      <span className="pg">
        <input
          className="pgin"
          aria-label={t.pageNumber}
          inputMode="numeric"
          style={{ width: `${Math.max(2, String(page.count).length) + 1.6}ch` }}
          value={draft ?? String(page.current)}
          onFocus={(event) => {
            setDraft(String(page.current));
            event.target.select();
          }}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
          onBlur={() => setDraft(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              go();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
        />
        <span>{t.ofPages(page.count)}</span>
      </span>
      <button
        type="button"
        className="btn icon sm dim"
        title={t.nextPage}
        aria-label={t.nextPage}
        disabled={page.current >= page.count}
        onClick={() => onPage(page.current + 1)}
      >
        <Icon name="chevron-down" />
      </button>
      {zoom ? (
        <>
          <span className="vsep" />
          <button
            type="button"
            className="btn icon sm dim"
            title={t.zoomOut}
            aria-label={t.zoomOut}
            disabled={zoom.mode !== "width" && zoom.percent <= 25}
            onClick={() => onZoom(-1)}
          >
            <Icon name="minus" />
          </button>
          <button type="button" className="zoom" title={t.fitWidth} onClick={onFit}>
            {zoom.mode === "width" ? t.fit : `${zoom.percent}%`}
          </button>
          <button
            type="button"
            className="btn icon sm dim"
            title={t.zoomIn}
            aria-label={t.zoomIn}
            disabled={zoom.mode !== "width" && zoom.percent >= 400}
            onClick={() => onZoom(1)}
          >
            <Icon name="plus" />
          </button>
        </>
      ) : null}
    </div>
  );
}
