/**
 * Starting a session from an Azure DevOps ticket, shared by the Dashboard's
 * work-item dialog and New session: the board's tickets and their workflow
 * order, and the chosen repo's branches.
 */
import { useEffect, useState } from "react";
import type { AdoWorkItem, RepoBranches } from "../shared/types";

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
