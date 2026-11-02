import ts from "typescript";
import {
  provisionalFanoutId,
  type AbstractValue,
  type PromotedFanout,
  type TaintFacts,
  type TaintOcc,
} from "./domain.js";
import type { IterationCandidate } from "./sites.js";
import type { ApplicationVia, ArgBinding, ThroughParam, TaintResolvers } from "./state-helpers.js";

/**
 * Read-only view of the converged interpreter state that {@link emitTaintFacts} and
 * {@link emitTaintOracle} project. The caller passes the owner itself, so no map, set, or
 * value is copied or re-owned here; the placeholder graph stays owned by TaintState.
 */
export interface TaintStateReads {
  readonly askInstr: ReadonlyMap<string, AbstractValue>;
  readonly askRecv: ReadonlyMap<string, AbstractValue>;
  readonly worldRead: ReadonlyMap<string, AbstractValue>;
  readonly holePrompt: ReadonlyMap<string, AbstractValue>;
  readonly joinInByPort: ReadonlyMap<string, ReadonlyMap<number, AbstractValue>>;
  readonly fanoutInVal: ReadonlyMap<string, AbstractValue>;
  readonly promotedOrders: ReadonlySet<number>;
  readonly returnVal: AbstractValue;
  readonly awaitVal: ReadonlyMap<number, AbstractValue>;
  readonly guardVal: ReadonlyMap<number, AbstractValue>;
  readonly applications: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, ApplicationVia>>;
  readonly bindings: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, readonly ArgBinding[]>>;
  readonly throughParams: ReadonlyMap<ts.Node, ReadonlyMap<string, ThroughParam & { via: ApplicationVia }>>;
}

/** The ordering walk's oracle view; see {@link emitTaintOracle}. */
export interface TaintOracleView {
  awaitSettles: Map<number, TaintOcc[]>;
  guardReads: Map<number, TaintOcc[]>;
  applications: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, ApplicationVia>>;
  throughParams: ReadonlyMap<ts.Node, ReadonlyMap<string, ThroughParam & { via: ApplicationVia }>>;
  bindings: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, readonly ArgBinding[]>>;
}

/**
 * Project the converged state onto {@link TaintFacts}: the sink lookups, the promoted
 * fan-out candidates, and the resolved return data. `iterations` stays passed separately
 * because the candidate list lives in the site table, not on the state itself.
 */
export function emitTaintFacts(
  state: TaintStateReads,
  iterations: readonly IterationCandidate[],
  resolvers: TaintResolvers,
): TaintFacts {
    const askData = new Map<string, TaintOcc[]>();
    const askActor = new Map<string, TaintOcc[]>();
    const worldReadData = new Map<string, TaintOcc[]>();
    const joinIn = new Map<string, TaintOcc[]>();
    const fanoutIn = new Map<string, TaintOcc[]>();
    const { actor, artifact } = resolvers;

    for (const [id, value] of state.askInstr) askData.set(id, artifact(value));
    for (const [id, value] of state.askRecv) askActor.set(id, actor(value));
    for (const [id, value] of state.worldRead) worldReadData.set(id, artifact(value));
    const holeData = new Map<string, TaintOcc[]>();
    for (const [id, value] of state.holePrompt) holeData.set(id, artifact(value));
    for (const [id, ports] of state.joinInByPort) {
      const occs: TaintOcc[] = [];
      for (const [port, value] of ports) {
        for (const occ of artifact(value)) {
          occs.push({ exact: occ.exact, site: occ.site, ...(port >= 0 ? { port } : {}) });
        }
      }
      joinIn.set(id, occs);
    }
    for (const [id, value] of state.fanoutInVal) fanoutIn.set(id, artifact(value));

    const promoted: PromotedFanout[] = iterations
      .filter((cand) => state.promotedOrders.has(cand.order))
      .sort((a, b) => a.order - b.order)
      .map((cand) => ({
        id: provisionalFanoutId(cand.order),
        label: "fan-out",
        loc: cand.loc,
        order: cand.order,
      }));

    return {
      askActor,
      askData,
      fanoutIn,
      holeData,
      joinIn,
      promoted,
      returnData: artifact(state.returnVal),
      worldReadData,
    };
}

export function emitTaintOracle(state: TaintStateReads, resolvers: TaintResolvers): TaintOracleView {
    const { artifact } = resolvers;
    const awaitSettles = new Map<number, TaintOcc[]>();
    for (const [pos, value] of state.awaitVal) awaitSettles.set(pos, artifact(value));
    const guardReads = new Map<number, TaintOcc[]>();
    for (const [pos, value] of state.guardVal) guardReads.set(pos, artifact(value));
    return { applications: state.applications, awaitSettles, bindings: state.bindings, guardReads, throughParams: state.throughParams };
}
