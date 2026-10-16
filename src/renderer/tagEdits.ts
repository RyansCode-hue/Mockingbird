import { BLOCKED_TAG, blockedReasons, changedTags, stillBlockedNote, unblockPlan, type TagChange } from "../shared/cardRules";
import { isErr, type AdoCardRules, type AdoWorkItem } from "../shared/types";

/** Writes a tag change to Azure DevOps; answers with the tags it stored. */
export type TagWrite = (id: number, change: TagChange) => Promise<{ id: number; tags: string[] } | { error: string }>;

/**
 * One tag edit on a work item: the card shows it at once, it's written, and
 * the card then shows the tags Azure DevOps stored (a teammate's tag added
 * meanwhile among them). When the write fails, the card goes back to the
 * tags it had and the error is returned for the view to show.
 */
export async function editTags(item: AdoWorkItem, change: TagChange, write: TagWrite, show: (id: number, tags: string[]) => void): Promise<{ tags: string[] } | { error: string }> {
  show(item.id, changedTags(item.tags, change));
  let r: Awaited<ReturnType<TagWrite>>;
  try {
    r = await write(item.id, change);
  } catch (err) {
    r = { error: err instanceof Error ? err.message : String(err) };
  }
  if (isErr(r)) {
    show(item.id, item.tags);
    return r;
  }
  show(item.id, r.tags);
  return { tags: r.tags };
}

/**
 * Mark blocked or Unblock, for a card's menu and its dialog. Mark blocked adds
 * the "blocked" tag; Unblock removes it, and `note` says what still blocks
 * the item when a tag isn't all of it. With no "blocked" tag to remove,
 * `change` is null: there's nothing Unblock can write.
 */
export function blockAction(it: AdoWorkItem, rules: AdoCardRules | null): { key: "block" | "unblock"; label: string; change: TagChange | null; note: string | null } {
  if (!blockedReasons(it, rules).length) return { key: "block", label: "Mark blocked", change: { add: [BLOCKED_TAG] }, note: null };
  const plan = unblockPlan(it, rules);
  return { key: "unblock", label: "Unblock", change: plan.remove.length ? { remove: plan.remove } : null, note: stillBlockedNote(it.id, plan) };
}

/** Add tag's suggestions: tags on the board's work items, most used first, then the project's; none the item already has. */
export function tagSuggestions(items: AdoWorkItem[], project: string[], own: string[]): string[] {
  const has = new Set(own.map((t) => t.toLowerCase()));
  const uses = new Map<string, { tag: string; n: number }>();
  for (const t of items.flatMap((i) => i.tags)) {
    const k = t.toLowerCase();
    const u = uses.get(k);
    if (u) u.n++;
    else uses.set(k, { tag: t, n: 1 });
  }
  const board = [...uses.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).map((u) => u.tag);
  const out: string[] = [];
  for (const t of [...board, ...[...project].sort((a, b) => a.localeCompare(b))]) {
    const k = t.toLowerCase();
    if (has.has(k)) continue;
    has.add(k);
    out.push(t);
  }
  return out;
}
