import { useEffect, useState } from "react";
import { isErr } from "../shared/types";
import type { PlanView } from "../shared/plans";

/**
 * The Orchestrators' held plans (W17), as main has them (plans:list), read again whenever one is held, replaced, laid
 * out or dismissed (plans:changed). `error` says why they couldn't be read: no plans listed then isn't "none".
 */
export function usePlans(): { plans: PlanView[]; error: string | null; reread: () => void } {
  const [state, setState] = useState<{ plans: PlanView[]; error: string | null }>({ plans: [], error: null });
  const reread = () =>
    void window.mb.plansList().then(
      (r: PlanView[] | { error: string }) => {
        if (isErr(r)) {
          console.warn(`[mockingbird] the held plans: ${r.error}`);
          setState((s) => ({ ...s, error: r.error }));
        } else setState({ plans: r, error: null });
      },
      (err: unknown) => {
        console.warn("[mockingbird] the held plans:", err);
        setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
      }
    );
  useEffect(() => {
    reread();
    return window.mb.onPlansChanged(() => reread());
  }, []);
  return { ...state, reread };
}
