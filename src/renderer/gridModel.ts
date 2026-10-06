/**
 * The grid's arrangement rules, kept apart from React so they can be tested:
 * which group the grid shows, and what survives switching groups (pinned
 * panes). Where each pane sits is layoutTree.ts's.
 *
 * `shown` is the ordered list of session ids on screen. `groupOf` gives a
 * session's top-level group, or undefined for an id that isn't live (a
 * relaunch reuses the id, so those keep their slot).
 */

type GroupOf = (id: string) => string | undefined;

/**
 * The group the grid shows: the one it was last switched to while any of its
 * sessions are still on screen, else the first unpinned pane's group (a pinned
 * pane from another group never decides it). With only pinned panes left it
 * stays the last group if one of them belongs to it, else the first pane's.
 */
export function activeGroupOf(shown: string[], groupOf: GroupOf, pinned: ReadonlySet<string>, last: string | null): string | null {
  if (last && shown.some((id) => groupOf(id) === last && !pinned.has(id))) return last;
  const live = shown.filter((id) => groupOf(id) !== undefined);
  const unpinned = live.find((id) => !pinned.has(id));
  if (unpinned) return groupOf(unpinned)!;
  if (last && live.some((id) => groupOf(id) === last)) return last;
  return live.length ? groupOf(live[0])! : null;
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
