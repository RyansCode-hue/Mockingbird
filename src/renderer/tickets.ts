/**
 * Starting a session from an Azure DevOps ticket, shared by the Dashboard's
 * work-item dialog and New session: the board's tickets and their workflow
 * order, and the chosen repo's branches.
 */
import { useEffect, useState } from "react";
import type { AdoWorkItem, RepoBranches } from "../shared/types";
import { orderColumns } from "./boardView";

/** Kickoff prompt for a session started from an Azure DevOps ticket. */
export function ticketKickoffPrompt(id: number | string, title: string, description: string): string {
  return (
    `You're picking up Azure DevOps ticket #${id}: ${title}.\n\n` +
    (description.trim() ? `Ticket description:\n${description.trim()}\n\n` : "") +
    `Get familiar with the relevant code first and propose an approach before making changes.`
  );
}

/** "Filter orgs by foundation" → "filterOrgsByFoundation" (branch-friendly). */
export function suggestTicketName(title: string): string {
  const words = title.replace(/[^a-zA-Z0-9 ]+/g, " ").trim().split(/\s+/).slice(0, 5);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("");
}

const STATE_ORDER = [
  "New", "Approved", "Committed", "To Do", "Open", "Active", "In Progress", "Doing",
  "Resolved", "In Review", "Review", "Done", "Closed",
];
/** A generic workflow position for a state, for when Azure DevOps' own order isn't known. */
export const stateRank = (s: string) => {
  const i = STATE_ORDER.indexOf(s);
  return i < 0 ? STATE_ORDER.length : i;
};

// Terminal columns. A ticket you'd start work on never sits in one, so the
// New Session picker leaves them out — you pick from the working columns of
// the board (Approved/Planning/Parked/In Progress/QA and the like).
const DONE_STATES = ["done", "closed", "removed", "completed", "resolved", "cut", "abandoned"];
const isWorkingState = (state: string) => {
  const s = state.toLowerCase();
  return !DONE_STATES.some((d) => s === d || s.startsWith(d + " ") || s.endsWith(" " + d));
};

/**
 * Group tickets into board columns. Order of preference: the column order you
 * dragged into place on the Dashboard (`custom`), then Azure DevOps' own
 * workflow order for the work item type, then a generic fallback. Terminal
 * columns are dropped entirely — you don't start work from Done.
 */
export function ticketsByColumn(items: AdoWorkItem[], workflowOrder: string[], custom: string[] = []): { state: string; items: AdoWorkItem[] }[] {
  const byState = new Map<string, AdoWorkItem[]>();
  for (const t of items) if (isWorkingState(t.state)) byState.set(t.state, [...(byState.get(t.state) ?? []), t]);
  const rank = (c: string) => {
    const i = workflowOrder.indexOf(c);
    return i < 0 ? workflowOrder.length + stateRank(c) : i;
  };
  const states = [...byState.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return orderColumns(states, custom).map((state) => ({ state, items: byState.get(state)!.sort((a, b) => a.id - b.id) }));
}

/**
 * The repo's branches, and the base a new branch is cut from — its dev/uat-style
 * branch until one is picked. Both follow `repoPath`; `error` says why the list
 * couldn't be read (the base picker is empty then).
 */
export function useRepoBranches(repoPath: string | null | undefined) {
  const [branches, setBranches] = useState<RepoBranches | null>(null);
  const [base, setBase] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setBranches(null);
    setBase("");
    setError("");
    if (!repoPath) return;
    let alive = true;
    window.mb.repoBranches(repoPath).then((r: RepoBranches | { error: string }) => {
      if (!alive) return;
      if ("error" in r) return setError(`Couldn't list the repo's branches: ${r.error}`);
      setBranches(r);
      setBase(r.defaultBase ?? "");
    });
    return () => {
      alive = false;
    };
  }, [repoPath]);
  return { branches, base, setBase, error };
}

/**
 * Every type's states in Azure DevOps' workflow order, which is the column
 * order of the real board. `error` names a type whose states couldn't be read.
 */
export async function workflowStates(types: string[]): Promise<{ states: string[]; error: string }> {
  const lists: (string[] | { error: string })[] = await Promise.all(types.map((t) => window.mb.adoStates(t)));
  const failed = lists.findIndex((l) => !Array.isArray(l));
  return {
    states: [...new Set(lists.filter((l): l is string[] => Array.isArray(l)).flat())],
    error: failed < 0 ? "" : `Couldn't read the states a ${types[failed]} can be in: ${(lists[failed] as { error: string }).error}`,
  };
}

export interface AdoTickets {
  /** Everyone's tickets; null while loading, and when the board couldn't be read. */
  items: AdoWorkItem[] | null;
  /** Who the token belongs to ("" when unknown). */
  me: string;
  stateOrder: string[];
  /** Why the board, or some of its states, couldn't be read. */
  error: string;
}

/** The board's tickets for a ticket picker, read once. */
export function useAdoTickets(): AdoTickets {
  const [t, setT] = useState<AdoTickets>({ items: null, me: "", stateOrder: [], error: "" });
  useEffect(() => {
    let alive = true;
    window.mb.adoList().then(async (r: { items: AdoWorkItem[]; me: string } | { error: string }) => {
      if (!alive) return;
      if ("error" in r) return setT((p) => ({ ...p, error: r.error }));
      setT((p) => ({ ...p, items: r.items, me: r.me }));
      const { states, error } = await workflowStates([...new Set(r.items.map((i) => i.type))]);
      if (alive) setT((p) => ({ ...p, stateOrder: states, error }));
    });
    return () => {
      alive = false;
    };
  }, []);
  return t;
}
