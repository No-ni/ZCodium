import type { WorkflowGraphEdge } from "@zcode/contracts";

export function createWorkflowEdgeCycleCheck(edges: readonly WorkflowGraphEdge[]): {
  accept(edge: WorkflowGraphEdge): void;
  wouldFormCycle(edge: WorkflowGraphEdge): boolean;
} {
  const outgoing = new Map<string, string[]>();
  const accept = (edge: WorkflowGraphEdge): void => {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  };
  for (const edge of edges) accept(edge);

  return {
    accept,
    wouldFormCycle(newEdge) {
      const visited = new Set<string>();
      const queue = [newEdge.to];
      for (let index = 0; index < queue.length; index++) {
        const current = queue[index]!;
        if (current === newEdge.from) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        queue.push(...(outgoing.get(current) ?? []));
      }
      return false;
    },
  };
}
