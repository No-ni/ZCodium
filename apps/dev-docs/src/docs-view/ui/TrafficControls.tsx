import { type ReactNode } from "react";

export function TrafficStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-ui-sm text-foreground-subtle">{label}</div>
      <div className="mt-1 truncate font-mono text-ui-base text-foreground" title={value}>
        {value}
      </div>
    </div>
  );
}

export function DirectionButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-ui-sm whitespace-nowrap ${
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

export function InspectorAction({
  active = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex h-8 items-center gap-2 rounded-md border px-2 text-left text-ui-sm text-foreground hover:bg-surface-hover ${
        active ? "border-brand/35 bg-selected" : "border-border bg-surface"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
