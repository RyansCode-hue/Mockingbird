/**
 * Lanes for the commit graph. Commits arrive newest first in topological order;
 * each lane holds the commit it's waiting to reach. A commit takes the lane that
 * was waiting for it (lanes that also waited merge into it), hands that lane on
 * to its first parent, and opens lanes for its other parents.
 */
export interface GraphRow {
  /** The lane the commit's dot sits in. */
  lane: number;
  /** What each lane waits for above the dot, and below it. */
  before: (string | null)[];
  after: (string | null)[];
  parents: string[];
}

export function layoutGraph(commits: { sha: string; parents: string[] }[]): GraphRow[] {
  let lanes: (string | null)[] = [];
  return commits.map((c) => {
    const before = lanes.slice();
    let lane = lanes.indexOf(c.sha);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
    }
    const after = lanes.slice();
    for (let i = 0; i < after.length; i++) if (after[i] === c.sha) after[i] = null;
    const [first, ...rest] = c.parents;
    // a parent another lane already waits for is joined there, not doubled
    after[lane] = first && !after.includes(first) ? first : null;
    for (const p of rest) {
      if (after.includes(p)) continue;
      let free = after.findIndex((x, i) => x === null && i !== lane);
      if (free < 0) free = after.length;
      after[free] = p;
    }
    while (after.length && after[after.length - 1] === null) after.pop();
    lanes = after;
    return { lane, before, after, parents: c.parents };
  });
}

/** How many lanes the widest row uses. */
export const laneCount = (rows: GraphRow[]) => rows.reduce((n, r) => Math.max(n, r.before.length, r.after.length, r.lane + 1), 0);
