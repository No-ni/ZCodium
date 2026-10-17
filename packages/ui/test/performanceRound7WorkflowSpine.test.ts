import { describe, expect, it } from "vitest";
import { spineSections, type SpineSection } from "@/app-shell/workflowRunSpine.js";
import type {
  TimelineInk,
  TimelineRail,
  TimelineStation,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function model(count: number, rails: TimelineRail[] = []): WorkflowTimelineModel {
  const stations: TimelineStation[] = Array.from({ length: count }, (_, index) => ({
    id: `phase-${index}`,
    naming: { id: `phase-${index}`, name: `Phase ${index}` },
    pills: [],
    status: undefined,
    visited: false,
    rounds: 0,
    onLoop: false,
    track: 0,
  }));
  return { stations, rails, arcs: [], bands: [], live: true, runningIndex: undefined };
}

// 修复前的完整绘制算法作为差分参照；保留 find 的首见规则和分支路径。
function originalSpineSections(source: WorkflowTimelineModel): SpineSection[] {
  const sections: SpineSection[] = source.stations.map(() => ({ curves: [], rails: [] }));
  const trackAt = (i: number): number => source.stations[i]?.track ?? 0;
  const plain = source.rails.filter((rail) => rail.kind === undefined);
  const spanning = (i: number, track: number): TimelineInk | undefined =>
    plain.find(
      (rail) =>
        rail.from < i && i < rail.to && trackAt(rail.from) === track && trackAt(rail.to) === track,
    )?.ink;
  const pairInk = (from: number, to: number): TimelineInk =>
    plain.find((rail) => rail.from === from && rail.to === to)?.ink ?? "faint";
  source.stations.forEach((station, i) => {
    const section = sections[i]!;
    const band =
      station.track === 0 ? undefined : source.bands.find((b) => b.from <= i && i <= b.to);
    const track = band?.tracks[station.track];
    if (track === undefined) {
      const above = source.rails.find(
        (rail) => rail.to === i && rail.kind !== "twin" && rail.kind !== "merge",
      );
      const below = source.rails.find(
        (rail) => rail.from === i && rail.kind !== "twin" && rail.kind !== "fork",
      );
      if (above !== undefined) section.rails.push({ ink: above.ink, position: "above", track: 0 });
      if (below !== undefined) section.rails.push({ ink: below.ink, position: "below", track: 0 });
      return;
    }
    const at = track.stations.indexOf(i);
    const previous = track.stations[at - 1];
    const next = track.stations[at + 1];
    section.rails.push({
      ink: previous === undefined ? track.entry : pairInk(previous, i),
      position: "above",
      track: station.track,
    });
    section.rails.push({
      ink: next === undefined ? track.exit : pairInk(i, next),
      position: "below",
      track: station.track,
    });
    const main = spanning(i, 0);
    if (main !== undefined) section.rails.push({ ink: main, position: "full", track: 0 });
  });
  for (const band of source.bands) {
    band.tracks.forEach((track, t) => {
      if (t === 0) return;
      const end = band.join ?? band.to;
      const first = track.stations[0]!;
      const last = track.stations[track.stations.length - 1]!;
      const tail = band.join === undefined ? 13 : undefined;
      sections[band.from]?.curves.push({ at: "top", ink: track.entry, kind: "fork", track: t });
      sections[end]?.curves.push({
        at: tail === undefined ? "top" : "bottom",
        ink: track.exit,
        kind: "merge",
        track: t,
      });
      for (let i = band.from; i <= end; i += 1) {
        const section = sections[i];
        if (section === undefined) continue;
        if (track.stations.includes(i)) {
          if (tail !== undefined && i === end) {
            for (const rail of section.rails) {
              if (rail.track === t && rail.position === "below") rail.to = tail;
            }
          }
          continue;
        }
        if (i === end && tail === undefined) continue;
        const ink =
          i < first ? track.entry : i > last ? track.exit : (spanning(i, t) ?? track.exit);
        section.rails.push({
          ink,
          position: "full",
          track: t,
          ...(i === band.from ? { from: 13 } : {}),
          ...(tail !== undefined && i === end ? { to: tail } : {}),
        });
      }
    });
  }
  return sections;
}

function branchModel(join: boolean): WorkflowTimelineModel {
  const source = model(8, [
    { from: 0, to: 1, ink: "strong" },
    { from: 1, to: 3, ink: "march" },
    { from: 3, to: 6, ink: "faint" },
    { from: 1, to: 2, kind: "fork", ink: "strong" },
    { from: 2, to: 4, ink: "march" },
    { from: 4, to: 5, ink: "faint" },
    { from: 5, to: 6, kind: "merge", ink: "strong" },
    { from: 6, to: 7, ink: "strong" },
  ]);
  for (const index of [2, 4, 5]) source.stations[index]!.track = 1;
  source.bands = [
    {
      from: 1,
      to: 5,
      ...(join ? { join: 6 } : {}),
      tracks: [
        { stations: [1, 3], entry: "strong", exit: "faint" },
        { stations: [2, 4, 5], entry: "strong", exit: "march" },
      ],
    },
  ];
  return source;
}

describe("workflow detail spine rail lookup", () => {
  it("bounds endpoint reads at the production limit of 32 sequential phases", () => {
    const count = 32;
    const source = model(
      count,
      Array.from({ length: count - 1 }, (_, from) => ({
        from,
        to: from + 1,
        ink: "strong" as const,
      })),
    );
    let reads = 0;
    for (const rail of source.rails) {
      const from = rail.from;
      const to = rail.to;
      Object.defineProperties(rail, {
        from: {
          get: () => {
            reads += 1;
            return from;
          },
        },
        to: {
          get: () => {
            reads += 1;
            return to;
          },
        },
      });
    }
    freeze(source);
    reads = 0;
    const result = spineSections(source);
    expect(result[0]?.rails).toEqual([{ ink: "strong", position: "below", track: 0 }]);
    expect(result[15]?.rails).toEqual([
      { ink: "strong", position: "above", track: 0 },
      { ink: "strong", position: "below", track: 0 },
    ]);
    expect(result.at(-1)?.rails).toEqual([{ ink: "strong", position: "above", track: 0 }]);
    expect(reads).toBeLessThanOrEqual((count - 1) * 4);
    expect(reads).toBe((count - 1) * 2);
  });

  it("keeps first matching edges and independently filters rail kinds", () => {
    const source = freeze(
      model(4, [
        { from: 0, to: 1, kind: "twin", ink: "march" },
        { from: 0, to: 1, kind: "merge", ink: "faint" },
        { from: 0, to: 1, kind: "fork", ink: "strong" },
        { from: 0, to: 1, ink: "march" },
        { from: 1, to: 2, kind: "fork", ink: "faint" },
        { from: 1, to: 2, kind: "merge", ink: "strong" },
        { from: 1, to: 2, ink: "march" },
      ]),
    );
    const result = spineSections(source);
    expect(result).toEqual(originalSpineSections(source));
    expect(result[0]?.rails).toEqual([{ ink: "faint", position: "below", track: 0 }]);
    expect(result[1]?.rails).toEqual([
      { ink: "strong", position: "above", track: 0 },
      { ink: "strong", position: "below", track: 0 },
    ]);
    expect(result[3]).toEqual({ curves: [], rails: [] });
  });

  it("matches the original complete output for deterministic frozen graphs and branches", () => {
    let seed = 92717;
    const random = (bound: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };
    const kinds = [undefined, "twin", "fork", "merge"] as const;
    const inks = ["faint", "strong", "march"] as const;
    const sources = [model(0), model(1), branchModel(true), branchModel(false)];
    for (let round = 0; round < 30; round += 1) {
      const count = 2 + random(31);
      sources.push(
        model(
          count,
          Array.from({ length: random(80) }, () => {
            const kind = kinds[random(kinds.length)];
            return {
              from: random(count),
              to: random(count),
              ink: inks[random(inks.length)]!,
              ...(kind === undefined ? {} : { kind }),
            };
          }),
        ),
      );
    }
    for (const source of sources) {
      freeze(source);
      const actual = spineSections(source);
      expect(actual).toEqual(originalSpineSections(source));
      const repeated = spineSections(source);
      expect(repeated).toEqual(actual);
      expect(repeated).not.toBe(actual);
      if (actual[0]) {
        expect(repeated[0]?.rails).not.toBe(actual[0].rails);
        expect(repeated[0]?.curves).not.toBe(actual[0].curves);
      }
      const replacement = {
        ...source,
        rails: source.rails.map((rail) => ({ ...rail, ink: "faint" as const })),
      };
      expect(spineSections(freeze(replacement))).toEqual(originalSpineSections(replacement));
    }
    const unjoined = spineSections(freeze(branchModel(false)));
    expect(unjoined[5]?.rails).toContainEqual({
      ink: "march",
      position: "below",
      track: 1,
      to: 13,
    });
    expect(unjoined[5]?.curves).toContainEqual({
      at: "bottom",
      ink: "march",
      kind: "merge",
      track: 1,
    });
  });
});
