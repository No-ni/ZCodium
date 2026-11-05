import {
  concepts,
  type ConceptKind,
  type StdioTrafficDirection,
  type StructureDoc,
  type Concept,
} from "@/data/protocolDocs.js";

export const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));

export const kindLabel: Record<ConceptKind, string> = {
  compat: "兼容字段",
  id: "ID",
  protocol: "协议",
  runtime: "运行态",
  state: "状态",
};

export const kindClassName: Record<ConceptKind, string> = {
  compat: "bg-warning/12 text-foreground border-warning/35",
  id: "bg-brand/12 text-foreground border-brand/35",
  protocol: "bg-file-node text-file-node-foreground border-file-node-hover",
  runtime: "bg-command-node text-command-node-foreground border-command-node-hover",
  state: "bg-skill-node text-skill-node-foreground border-skill-node-hover",
};

export const directionLabel: Record<StdioTrafficDirection, string> = {
  "agent-stderr": "stderr",
  "agent-to-app": "agent -> app",
  "app-to-agent": "app -> agent",
};

export const directionClassName: Record<StdioTrafficDirection, string> = {
  "agent-stderr": "border-command-node-hover bg-command-node text-command-node-foreground",
  "agent-to-app": "border-skill-node-hover bg-skill-node text-skill-node-foreground",
  "app-to-agent": "border-file-node-hover bg-file-node text-file-node-foreground",
};

export function normalizeText(value: string) {
  return value.toLowerCase().trim();
}

export function matchesStructure(structure: StructureDoc, query: string) {
  if (!query) return true;
  const haystack = [
    structure.title,
    structure.path,
    structure.purpose,
    structure.oldShape ?? "",
    structure.newShape,
    structure.migration,
    ...structure.fields.flatMap((field) => [
      field.name,
      field.type,
      field.meaning,
      field.owner,
      field.oldName ?? "",
      field.notes ?? "",
    ]),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

export function matchesConcept(concept: Concept, query: string) {
  if (!query) return true;
  return [
    concept.name,
    concept.summary,
    concept.lifecycle,
    concept.owner,
    concept.source,
    ...(concept.aliases ?? []),
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}
