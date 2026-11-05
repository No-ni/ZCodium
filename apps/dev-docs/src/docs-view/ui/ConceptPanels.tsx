import { conceptById, kindClassName, kindLabel } from "../domain/presentation.js";
import { LinkIcon, Hash, Network } from "lucide-react";
import { type Concept, protocolSurfaces } from "@/data/protocolDocs.js";

export function ConceptLinks({
  activeId,
  ids,
  onSelect,
}: {
  activeId: string;
  ids: string[];
  onSelect: (conceptId: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const concept = conceptById.get(id);
        const active = id === activeId;
        return (
          <a
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-ui-xs ${
              active
                ? "border-brand bg-brand text-foreground-inverse"
                : "border-border bg-tag text-foreground"
            }`}
            href={`#concept-${id}`}
            key={id}
            onClick={() => onSelect(id)}
            title={concept?.summary ?? id}
          >
            <LinkIcon className="size-3" />
            {concept?.name ?? id}
          </a>
        );
      })}
    </div>
  );
}

export function ConceptPanel({
  activeConcept,
  activeConceptId,
  filteredConcepts,
  onSelect,
}: {
  activeConcept: Concept | undefined;
  activeConceptId: string;
  filteredConcepts: Concept[];
  onSelect: (conceptId: string) => void;
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card">
      <div className="border-b border-border p-3">
        <div className="mb-1 flex items-center gap-2 text-ui-sm font-medium text-brand">
          <Hash className="size-4" />
          概念索引
        </div>
        {activeConcept ? (
          <div className="scroll-mt-20" id={`concept-${activeConcept.id}`}>
            <div className="mt-2 flex items-center gap-2">
              <code className="font-mono text-ui-base font-medium">{activeConcept.name}</code>
              <span
                className={`rounded-full border px-2 py-0.5 text-ui-xs ${kindClassName[activeConcept.kind]}`}
              >
                {kindLabel[activeConcept.kind]}
              </span>
            </div>
            <p className="mt-2 text-ui-sm leading-5 text-foreground-subtle">
              {activeConcept.summary}
            </p>
            <dl className="mt-3 grid gap-2 text-ui-sm">
              <DetailRow label="生命周期" value={activeConcept.lifecycle} />
              <DetailRow label="Owner" value={activeConcept.owner} />
              <DetailRow label="来源" value={activeConcept.source} mono />
            </dl>
            {activeConcept.related.length > 0 ? (
              <ConceptLinks
                activeId={activeConceptId}
                ids={activeConcept.related}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="max-h-[420px] overflow-y-auto p-2">
        {filteredConcepts.map((concept) => (
          <a
            className={`mb-1 block rounded-md px-2 py-1.5 text-ui-sm ${
              concept.id === activeConceptId
                ? "bg-selected text-foreground"
                : "text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
            }`}
            href={`#concept-${concept.id}`}
            key={concept.id}
            onClick={() => onSelect(concept.id)}
          >
            <span className="font-mono">{concept.name}</span>
            <span className="ml-2 text-foreground-subtlest">{kindLabel[concept.kind]}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

export function DetailRow({
  label,
  mono,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div>
      <dt className="text-foreground-subtlest">{label}</dt>
      <dd className={`mt-0.5 leading-5 text-foreground ${mono ? "font-mono text-ui-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

export function ProtocolPanel({
  activeConceptId,
  onSelect,
}: {
  activeConceptId: string;
  onSelect: (conceptId: string) => void;
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card p-3">
      <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
        <Network className="size-4" />
        @zcode/protocol
      </div>
      <div className="space-y-2">
        {protocolSurfaces.map((surface) => (
          <div className="rounded-lg border border-border bg-surface p-3" key={surface.id}>
            <h3 className="text-ui-base font-medium">{surface.title}</h3>
            <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{surface.summary}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {surface.fields.map((field) => (
                <span
                  className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle"
                  key={field}
                >
                  {field}
                </span>
              ))}
            </div>
            <ConceptLinks activeId={activeConceptId} ids={surface.conceptIds} onSelect={onSelect} />
          </div>
        ))}
      </div>
    </section>
  );
}
