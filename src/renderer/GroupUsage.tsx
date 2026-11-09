import { useEffect, useState } from "react";
import { AGENT_NAME, formatShare, formatTokens, isErr, totalTokens, type AgentKind, type GroupMeter, type Meters } from "../shared/types";
import { tokenBreakdown } from "./usageFormat";

/**
 * A group's or ticket's usage: its sessions' tokens over all their
 * conversations (each counted once), measured from the transcripts, and the
 * estimated share of each agent's current 5-hour limit.
 */

/** "≈14% of Claude's 5h", "≈14% Claude · 3% Codex", or "" when no share is known. */
export function shareText(g: GroupMeter): string {
  const parts = (Object.entries(g.window) as [AgentKind, { sharePct: number | null }][]).filter(([, w]) => w.sharePct !== null);
  if (!parts.length) return "";
  if (parts.length === 1) return `≈${formatShare(parts[0][1].sharePct!)} of ${AGENT_NAME[parts[0][0]]}'s 5h`;
  return `≈${parts.map(([a, w]) => `${formatShare(w.sharePct!)} ${AGENT_NAME[a]}`).join(" · ")} of 5h`;
}

/** The tooltip: what's counted, the breakdown, and how the share is estimated. */
export function usageTitle(g: GroupMeter, what: string): string {
  const lines = [`${what}: ${formatTokens(totalTokens(g.tokens))} tokens over ${g.sessions} session${g.sessions === 1 ? "" : "s"}, open or resumable`, tokenBreakdown(g.tokens)];
  for (const [a, w] of Object.entries(g.window) as [AgentKind, { tokens: number; sharePct: number | null }][]) {
    lines.push(`${AGENT_NAME[a]}'s current 5-hour window: ${formatTokens(w.tokens)} tokens${w.sharePct !== null ? ` ≈ ${formatShare(w.sharePct)} of the limit` : ""}`);
  }
  if (Object.keys(g.window).length) lines.push("", "The share is an estimate: these sessions' part of what this Mac used in the window, weighted by model. Use elsewhere isn't counted, so it can read high.");
  return lines.join("\n");
}

/** A group's usage in a ticket's detail. */
function GroupUsage({ g, what }: { g: GroupMeter | undefined; what: string }) {
  if (!g || totalTokens(g.tokens) === 0) return <div className="tk-usage none">No usage yet: no session of this ticket has replied.</div>;
  const share = shareText(g);
  return (
    <div className="tk-usage" title={usageTitle(g, what)}>
      <span className="v">{formatTokens(totalTokens(g.tokens))} tokens</span>
      <span className="dim">
        {" "}
        · {g.sessions} session{g.sessions === 1 ? "" : "s"}
        {share ? ` · ${share}` : ""}
      </span>
    </div>
  );
}

/** This window's token meters, kept current: for views that aren't handed them. */
export function useMeters(): Meters | null {
  const [m, setM] = useState<Meters | null>(null);
  useEffect(() => {
    let live = true;
    window.mb.metersGet().then(
      (r: Meters | { error: string }) => {
        if (!live) return;
        if (isErr(r)) console.warn(`the token meters: ${r.error}`);
        else setM(r);
      },
      (err: unknown) => console.warn("the token meters:", err)
    );
    // a push that says why there are none lets go of the reading before it, rather than keep showing it
    const off = window.mb.onMetersChanged((next: Meters | { error: string }) => {
      if (!live) return;
      if (isErr(next)) {
        console.warn(`the token meters: ${next.error}`);
        setM(null);
      } else setM(next);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return m;
}

/** A ticket's usage in its detail (Dashboard, House): its sessions here, summed. */
export function TicketUsage({ ticket }: { ticket: string }) {
  const meters = useMeters();
  if (!meters) return null;
  return (
    <div className="tk-usage-sec">
      <label>Usage on this Mac</label>
      <GroupUsage g={meters.tickets?.[ticket]} what={`Ticket #${ticket}`} />
    </div>
  );
}
