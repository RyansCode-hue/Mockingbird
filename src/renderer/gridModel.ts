/**
 * The grid's arrangement rules, kept apart from React so they can be tested:
 * which group the grid shows, what survives switching groups (pinned panes),
 * and which snap-layout zone each pane sits in.
 *
 * `shown` is the ordered list of session ids on screen. `groupOf` gives a
 * session's top-level group, or undefined for an id that isn't live (a
 * relaunch reuses the id, so those keep their slot).
 */

type GroupOf = (id: string) => string | undefined;

/**
 * The group the grid shows: the one it was last switched to while any of its
 * sessions are still on screen, else the first unpinned pane's group (a pinned
 * pane from another group never decides it), else the first pane's.
 */
export function activeGroupOf(shown: string[], groupOf: GroupOf, pinned: ReadonlySet<string>, last: string | null): string | null {
  if (last && shown.some((id) => groupOf(id) === last && !pinned.has(id))) return last;
  const live = shown.filter((id) => groupOf(id) !== undefined);
  const first = live.find((id) => !pinned.has(id)) ?? live[0];
  return first ? groupOf(first)! : null;
}

/** The grid holds one group: panes from elsewhere leave unless pinned. */
export function pruneToGroup(shown: string[], groupOf: GroupOf, pinned: ReadonlySet<string>, active: string | null): string[] {
  if (!active) return shown;
  const next = shown.filter((id) => {
    const g = groupOf(id);
    return g === undefined || g === active || pinned.has(id);
  });
  return next.length === shown.length ? shown : next;
}

/** Switching to another group: its panes, with each pinned pane kept in the slot it had. */
export function switchTo(shown: string[], pinned: ReadonlySet<string>, next: string[]): string[] {
  const out = next.filter((id) => !pinned.has(id) || !shown.includes(id));
  shown.forEach((id, i) => {
    if (pinned.has(id)) out.splice(Math.min(i, out.length), 0, id);
  });
  return out;
}

/** What a group remembers as its layout: its own panes, not pinned visitors from other groups. */
export function layoutToRemember(shown: string[], groupOf: GroupOf, group: string): string[] {
  return shown.filter((id) => groupOf(id) === group);
}

// ---- snap-layout zones --------------------------------------------------------

export interface Zoning {
  /** Each cell's zone, or -1 for a cell beyond the template's zones. */
  zoneOf: number[];
  /** Zones no pane fills, which offer "open a session here". */
  empty: number[];
  /** Cells beyond the template, in order; they fill equal cells in rows below it. */
  overflow: number[];
}

/**
 * Seat cells in a template's zones. A cell the user placed keeps its zone; the
 * rest fill the free zones in order, and any beyond the zones flow below.
 * `placed` holds a cell key per zone (session id, or "ws:<group/workspace>").
 */
export function placeInZones(keys: string[], zoneCount: number, placed: (string | null)[]): Zoning {
  const zoneOf = keys.map(() => -1);
  const taken = Array.from({ length: zoneCount }, () => false);
  placed.slice(0, zoneCount).forEach((key, z) => {
    const i = key ? keys.indexOf(key) : -1;
    if (i >= 0 && zoneOf[i] < 0) {
      zoneOf[i] = z;
      taken[z] = true;
    }
  });
  let z = 0;
  keys.forEach((_, i) => {
    if (zoneOf[i] >= 0) return;
    while (z < zoneCount && taken[z]) z++;
    if (z < zoneCount) {
      zoneOf[i] = z;
      taken[z] = true;
    }
  });
  return {
    zoneOf,
    empty: taken.map((t, i) => (t ? -1 : i)).filter((i) => i >= 0),
    overflow: zoneOf.map((zz, i) => (zz < 0 ? i : -1)).filter((i) => i >= 0),
  };
}

/** The key seated in each zone (null for an empty one). */
export function seating(keys: string[], zoning: Zoning, zoneCount: number): (string | null)[] {
  const out: (string | null)[] = Array.from({ length: zoneCount }, () => null);
  zoning.zoneOf.forEach((z, i) => {
    if (z >= 0) out[z] = keys[i];
  });
  return out;
}

/**
 * Drop a cell into a zone. A cell coming from another zone swaps with the one
 * there; one coming from below the template (or from outside the grid) takes
 * the zone, and the one it displaces moves to the next free place.
 */
export function dropInZone(seats: (string | null)[], key: string, zone: number): (string | null)[] {
  if (zone < 0 || zone >= seats.length) return seats;
  const next = seats.slice();
  const from = next.indexOf(key);
  const occupant = next[zone];
  next[zone] = key;
  if (from >= 0 && from !== zone) next[from] = occupant;
  return next;
}

/** A zone's grid area "row-start/col-start/row-end/col-end" as numbers. */
export function parseZone(area: string): { rs: number; cs: number; re: number; ce: number } {
  const [rs, cs, re, ce] = area.split("/").map((n) => parseInt(n, 10));
  return { rs, cs, re, ce };
}

/**
 * The grid area of the j-th cell below a template of `rows` rows and `cols`
 * columns. The last one spans the rest of its row, so no space is left dead.
 */
export function overflowArea(j: number, cols: number, rows: number, last = false): string {
  const r = rows + 1 + Math.floor(j / cols);
  const c = (j % cols) + 1;
  return `${r}/${c}/${r + 1}/${last ? cols + 1 : c + 1}`;
}
