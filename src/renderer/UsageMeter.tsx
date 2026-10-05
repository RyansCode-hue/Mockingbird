import { useEffect, useState } from "react";
import { tokenBreakdown } from "./TerminalPane";
import { resetText, pctNow } from "./usageFormat";
import { Popover } from "./Popover";
import { AGENT_NAME, formatTokens, totalTokens, type UsageReport, type UsageLimit, type Meters } from "../shared/types";
import { fmtElapsed } from "../shared/format";
import { usePersisted } from "./prefs";

/** The status bar's plan-usage meter and its popover. */

type UsageShow = "claude" | "codex" | "both";

/**
 * Plan usage in the status bar — Claude, Codex, or both — with a popover of
 * every limit. Both agents report account-wide numbers from their sessions.
 */
export function UsageMeter({ usage, meters }: { usage: UsageReport | null; meters: Meters | null }) {
  const [show, setShow] = usePersisted<UsageShow>("mb.usageShow", "both");
  const [open, setOpen] = useState(false);
  // resets pass while the app sits open with no session reporting
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const agents: ("claude" | "codex")[] = show === "both" ? ["claude", "codex"] : [show];
  const shown = agents.map((a) => ({ a, u: usage?.[a] ?? null }));
  const compact = shown.filter((x) => x.u);
  const short = (l: UsageLimit) => (l.label.startsWith("5-hour") ? "5h" : l.label.startsWith("Weekly") ? "wk" : l.label);
  const todayTotal = Object.values(meters?.today ?? {}).reduce((n, t) => n + totalTokens(t!), 0);

  return (
    <span className="usage-wrap">
      <span className="usage" onClick={() => setOpen((o) => !o)} title="Plan usage — click for details">
        {compact.length === 0 ? (
          <span className="dim">usage</span>
        ) : (
          compact.map(({ a, u }) => (
            <span key={a} className="usage-agent">
              {agents.length > 1 && <span className="dim">{AGENT_NAME[a]}</span>}
              {u!.limits
                .filter((l) => l.label === "5-hour limit" || l.label.startsWith("Weekly · all") || l.label === "Weekly limit")
                .map((l) => (
                  <span key={l.label} className={pctNow(l, now) >= 90 ? "hot" : ""}>
                    {short(l)} {Math.round(pctNow(l, now))}%
                  </span>
                ))}
            </span>
          ))
        )}
        {todayTotal > 0 && (
          <span className="usage-agent">
            <span className="dim">today</span>
            <span>{formatTokens(todayTotal)}</span>
          </span>
        )}
      </span>
      {open && (
        <Popover className="usage-pop" onClose={() => setOpen(false)}>
          {shown.map(({ a, u }) => (
            <div key={a} className="usage-sec">
              <div className="usage-head">
                {AGENT_NAME[a]} plan usage limits{u?.plan ? ` · ${u.plan}` : ""}
              </div>
              {!u ? (
                <div className="usage-empty">
                  {a === "claude"
                    ? "No report yet — appears after a Claude session's first response."
                    : "No report yet — appears after a Codex session's first turn."}
                </div>
              ) : (
                <>
                  {u.limits.map((l) => {
                    const pct = pctNow(l, now);
                    return (
                      <div key={l.label} className="usage-row">
                        <div className="usage-line">
                          <span className="usage-label">{l.label}</span>
                          <span
                            className="usage-reset"
                            title={l.note ? "Claude Code reports this window with a reply in a Claude pane; Collaborate turns don't report it" : undefined}
                          >
                            {l.note ?? resetText(l.resetsAt, now)}
                          </span>
                          <span className="usage-pct">{l.note ? "—" : `${Math.round(pct)}%`}</span>
                        </div>
                        <div className="usage-bar">
                          <span className={pct >= 90 ? "hot" : ""} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                        </div>
                      </div>
                    );
                  })}
                  {meters?.today[a] && (
                    <div className="usage-row usage-today" title={tokenBreakdown(meters.today[a]!)}>
                      <div className="usage-line">
                        <span className="usage-label">Today on this Mac</span>
                        <span className="usage-reset">{meters.today[a]!.replies.toLocaleString()} replies</span>
                        <span className="usage-pct">{formatTokens(totalTokens(meters.today[a]!))}</span>
                      </div>
                    </div>
                  )}
                  <div className="usage-foot">
                    reported {fmtElapsed(u.at)} ago{a === "codex" ? " · read from Codex's session logs" : ""}
                  </div>
                </>
              )}
            </div>
          ))}
          <div className="usage-show">
            <span className="seg" title="Whose usage to list">
              {(["claude", "codex", "both"] as const).map((v) => (
                <button key={v} className={show === v ? "on" : ""} onClick={() => setShow(v)}>
                  {v === "both" ? "Both" : AGENT_NAME[v]}
                </button>
              ))}
            </span>
          </div>
        </Popover>
      )}
    </span>
  );
}
