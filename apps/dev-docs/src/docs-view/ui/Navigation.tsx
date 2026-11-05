import { type ReactNode } from "react";
import { ArrowRight } from "lucide-react";

export function ViewButton({
  active,
  icon,
  label,
  mobileLabel,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  mobileLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-ui-sm ${
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{mobileLabel ?? label}</span>
    </button>
  );
}

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-foreground-subtle">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

export function SummaryCard({
  body,
  conceptId,
  icon,
  onSelect,
  title,
}: {
  body: string;
  conceptId: string;
  icon: ReactNode;
  onSelect: (conceptId: string) => void;
  title: string;
}) {
  return (
    <a
      className="group rounded-lg border border-card-border bg-card p-4 hover:border-border-hover hover:bg-card-selected"
      href={`#concept-${conceptId}`}
      onClick={() => onSelect(conceptId)}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="grid size-8 place-items-center rounded-lg border border-border bg-surface text-brand">
          {icon}
        </div>
        <ArrowRight className="size-4 text-foreground-subtlest group-hover:text-foreground" />
      </div>
      <h3 className="font-mono text-ui-base font-medium">{title}</h3>
      <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{body}</p>
    </a>
  );
}
