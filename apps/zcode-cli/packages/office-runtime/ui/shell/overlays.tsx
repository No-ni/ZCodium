import { useState, type RefObject, type MouseEvent as ReactMouseEvent } from "react";
import { describeAt, type Strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import { useFloating } from "#ui/shell/float.ts";
import type { Locate } from "#ui/viewers/types.ts";

/* ---------------------------------------------------------------- Selection bar and Ask */

export type BarMode = "bar" | "ask" | "added";

/** Keep the document's text selection when a press lands on the bar. */
const keepSelection = (event: ReactMouseEvent) => {
  if (!(event.target as Element).closest("textarea")) event.preventDefault();
};

export function SelectionBar({
  t,
  frame,
  locate,
  text,
  label,
  quote,
  short,
  mode,
  canAsk,
  copied,
  onAdd,
  onAsk,
  onCopy,
  onCancelAsk,
  onSend,
}: {
  t: Strings;
  frame: RefObject<HTMLElement | null>;
  locate: Locate;
  /** A text selection (offers Copy) rather than a block, page or cell range (shows its label). */
  text: boolean;
  label: string;
  quote: string;
  /** Use the short "Add" label (spreadsheets, where the range label takes the room). */
  short: boolean;
  mode: BarMode;
  canAsk: boolean;
  copied: boolean;
  onAdd(): void;
  onAsk(): void;
  onCopy(): void;
  onCancelAsk(): void;
  onSend(question: string): Promise<boolean>;
}) {
  const asking = mode === "ask";
  const ref = useFloating<HTMLDivElement>(frame, locate, {
    side: asking ? "bottom" : "top",
    dock: true,
  });
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!question.trim() || sending) return;
    setSending(true);
    const ok = await onSend(question.trim());
    setSending(false);
    if (ok) setQuestion("");
  };
  if (asking)
    return (
      <div
        ref={ref}
        className="pop ask"
        role="dialog"
        aria-label={t.ask}
        onMouseDown={keepSelection}
      >
        <div className="ctx">
          <span className="where">{label}</span>
          {quote ? <span className="q">“{quote}”</span> : null}
        </div>
        <textarea
          autoFocus
          className="textarea"
          rows={2}
          aria-label={t.askPlaceholder}
          placeholder={t.askPlaceholder}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancelAsk();
            }
          }}
        />
        <div className="row">
          <span className="hint">
            <kbd>↵</kbd> {t.sendKey}
          </span>
          <button type="button" className="btn sm" onClick={onCancelAsk}>
            {t.cancel}
          </button>
          <button
            type="button"
            className="btn sm primary"
            disabled={!question.trim() || sending}
            onClick={() => void send()}
          >
            {t.send}
          </button>
        </div>
      </div>
    );
  return (
    <div
      ref={ref}
      className="pop bar"
      role="toolbar"
      aria-label={label}
      onMouseDown={keepSelection}
    >
      {!text ? (
        <>
          <span className="where">{label}</span>
          <span className="vsep" />
        </>
      ) : null}
      <button
        type="button"
        className="btn lg"
        title={t.addToChatHint}
        onClick={onAdd}
        disabled={mode === "added"}
      >
        {mode === "added" ? (
          <>
            <Icon name="check" size={16} className="ok" />
            {t.added}
          </>
        ) : (
          <>
            <Icon name="message-square-plus" size={16} />
            {short ? t.addShort : t.addToChat}
          </>
        )}
      </button>
      {canAsk ? (
        <button type="button" className="btn lg" onClick={onAsk}>
          <Icon name="message-circle-question" size={16} />
          {t.ask}
        </button>
      ) : null}
      {text ? (
        <>
          <span className="vsep" />
          <button
            type="button"
            className="btn icon lg dim"
            title={copied ? t.copied : t.copy}
            aria-label={copied ? t.copied : t.copy}
            onClick={onCopy}
          >
            <Icon name={copied ? "check" : "copy"} />
          </button>
        </>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Agent callout */

export function AgentCallout({
  t,
  frame,
  locate,
  note,
  index,
  total,
  onNext,
  onClose,
}: {
  t: Strings;
  frame: RefObject<HTMLElement | null>;
  locate: Locate | null;
  note: string | null;
  index: number;
  total: number;
  onNext(): void;
  onClose(): void;
}) {
  const ref = useFloating<HTMLDivElement>(frame, locate, { side: "bottom", offset: 6, dock: true });
  return (
    <div ref={ref} className="callout" role="note">
      <div className="body">
        <div className="who">
          <span className="dot" />
          {total > 1 ? t.agentOf(index + 1, total) : t.agent}
        </div>
        {note ? <div className="text">{note}</div> : null}
      </div>
      {total > 1 ? (
        <button
          type="button"
          className="btn icon sm dim"
          title={t.nextTarget}
          aria-label={t.nextTarget}
          onClick={onNext}
        >
          <Icon name="chevron-down" />
        </button>
      ) : null}
      <button
        type="button"
        className="btn icon sm dim"
        title={t.close}
        aria-label={t.close}
        onClick={onClose}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

export function OffscreenChip({
  text,
  down,
  raised,
  onClick,
}: {
  text: string;
  down: boolean;
  raised: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" className={`chip offscreen${raised ? " raised" : ""}`} onClick={onClick}>
      <span className="dot" />
      {text}
      <Icon name={down ? "arrow-down" : "arrow-up"} size={12} />
    </button>
  );
}

/** "1 more on page 4" for targets outside the view. */
export function offscreenText(t: Strings, ats: string[]): string {
  return t.moreOn(ats.length, describeAt(ats[0], t, true));
}
