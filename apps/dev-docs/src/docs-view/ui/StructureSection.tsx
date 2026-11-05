import { type StructureDoc, type FieldDoc } from "@/data/protocolDocs.js";
import { BookOpenText } from "lucide-react";
import { ConceptLinks } from "./ConceptPanels.js";
import { type ReactNode } from "react";

export function StructureSection({
  activeConceptId,
  onSelectConcept,
  structure,
}: {
  activeConceptId: string;
  onSelectConcept: (conceptId: string) => void;
  structure: StructureDoc;
}) {
  return (
    <article
      className="scroll-mt-20 rounded-lg border border-card-border bg-card"
      id={structure.id}
    >
      <div className="border-b border-border p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <BookOpenText className="size-4 text-brand" />
          <h2 className="text-ui-base font-medium">{structure.title}</h2>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-ui-sm text-foreground-subtle">
            {structure.path}
          </span>
        </div>
        <p className="text-ui-base leading-6 text-foreground-subtle">{structure.purpose}</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {structure.oldShape ? (
            <CodePanel label="旧结构" value={structure.oldShape} />
          ) : (
            <CodePanel label="旧结构" value="无直接旧结构，属于新增协议结构说明。" />
          )}
          <CodePanel label="新结构" value={structure.newShape} />
        </div>
        <div className="mt-3 rounded-lg border border-border bg-accent/60 p-3 text-ui-sm leading-5 text-foreground">
          {structure.migration}
        </div>
      </div>
      <FieldTable
        activeConceptId={activeConceptId}
        fields={structure.fields}
        onSelectConcept={onSelectConcept}
      />
    </article>
  );
}

export function CodePanel({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 text-ui-sm font-medium text-foreground-subtle">{label}</div>
      <code className="block whitespace-pre-wrap break-words font-mono text-ui-sm leading-5 text-foreground">
        {value}
      </code>
    </div>
  );
}

export function FieldTable({
  activeConceptId,
  fields,
  onSelectConcept,
}: {
  activeConceptId: string;
  fields: FieldDoc[];
  onSelectConcept: (conceptId: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] border-collapse text-left text-ui-sm">
        <thead className="bg-surface text-foreground-subtle">
          <tr>
            <Th>字段</Th>
            <Th>类型</Th>
            <Th>状态</Th>
            <Th>含义</Th>
            <Th>Owner</Th>
            <Th>关联概念</Th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr className="border-t border-border align-top" key={`${field.name}-${field.source}`}>
              <td className="w-44 p-3">
                <div className="font-mono text-foreground">{field.name}</div>
                {field.oldName ? (
                  <div className="mt-1 font-mono text-foreground-subtlest">
                    old: {field.oldName}
                  </div>
                ) : null}
              </td>
              <td className="w-56 p-3 font-mono text-foreground-subtle">{field.type}</td>
              <td className="w-24 p-3">
                <RequiredBadge required={field.required} />
              </td>
              <td className="min-w-80 p-3">
                <p className="leading-5 text-foreground">{field.meaning}</p>
                {field.notes ? (
                  <p className="mt-1 leading-5 text-foreground-subtle">{field.notes}</p>
                ) : null}
                <p className="mt-1 font-mono text-ui-xs leading-5 text-foreground-subtlest">
                  {field.source}
                </p>
              </td>
              <td className="w-36 p-3 text-foreground-subtle">{field.owner}</td>
              <td className="w-56 p-3">
                <ConceptLinks
                  activeId={activeConceptId}
                  ids={field.conceptIds}
                  onSelect={onSelectConcept}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Th({ children }: { children: ReactNode }) {
  return <th className="border-b border-border px-3 py-2 font-medium">{children}</th>;
}

export function RequiredBadge({ required }: { required: FieldDoc["required"] }) {
  const label = required === "required" ? "必填" : required === "optional" ? "可选" : "兼容";
  const className =
    required === "required"
      ? "border-brand/35 bg-brand/12 text-foreground"
      : required === "optional"
        ? "border-border bg-surface text-foreground-subtle"
        : "border-warning/35 bg-warning/12 text-foreground";
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 ${className}`}>{label}</span>
  );
}
