import { useEffect, useState } from "react";
import { tokenBreakdown } from "./TerminalPane";
import { resetText, pctNow, headlineOf, contextLine, contextPct, contextTarget } from "./usageFormat";
import { Popover } from "./Popover";
import { AGENT_NAME, formatTokens, isErr, totalTokens, type ContextWindow, type SessionInfo, type UsageReport, type Meters } from "../shared/types";
import { fmtElapsed } from "../shared/format";
import { usePersisted } from "./prefs";
import { useFill } from "./motion";

/** The status bar's plan-usage meter and its popover. */

type UsageShow = "claude" | "codex" | "both";

const CONTEXT_POLL_MS = 2000;

/** A 0–100 bar; it springs to a new value only on a real change of `of` (useFill), never on a poll that moved nothing. */
function Bar({ pct, of }: { pct: number; of?: string }) {
  const fill = useFill<HTMLSpanElement>(pct, of);
  return (
    <div className="usage-bar">
      <span ref={fill} className={pct >= 90 ? "hot" : ""} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The focused session's context window, re-read while the popover is open. */
function ContextRow({ session }: { session: SessionInfo | null }) {
  const target = contextTarget(session);
  const id = "id" in target ? target.id : null;
  const [cw, setCw] = useState<{ id: string; v: ContextWindow } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    const read = () =>
      window.mb.contextWindow(id).then(
        (r: ContextWindow | { error: string }) => {
          if (!live) return;
          if (isErr(r)) console.warn(`context window of ${id}: ${r.error}`);
          setCw({ id, v: isErr(r) ? { state: "error", why: `Couldn't read it: ${r.error}` } : r });
        },
        (err: unknown) => {
          console.warn(`context window of ${id}:`, err);
          if (live) setCw({ id, v: { state: "error", why: `Couldn't read it: ${(err as Error)?.message ?? err}` } });
        }
      );
    void read();
    const t = setInterval(read, CONTEXT_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);
  const v: ContextWindow = "why" in target ? { state: "none", why: target.why } : cw?.id === id ? cw.v : { state: "none", why: "Reading…" };
  const pct = v.state === "reading" ? contextPct(v.tokens, v.window) : 0;
  return (
    <div className="usage-sec usage-ctx">
      <div className="usage-row">
        <div className="usage-line">
          <span className="usage-label">Context window</span>
          {v.state === "reading" && <span className="usage-pct">{contextLine(v.tokens, v.window)}</span>}
        </div>
        {v.state === "reading" ? (
          <Bar pct={pct} of={id ?? ""} />
        ) : (
          <div className={`usage-empty${v.state === "error" ? " bad" : ""}`}>{v.why}</div>
        )}
      </div>
      {v.state === "reading" && session && (
        <div className="usage-foot" title={session.title}>
          <span className="usage-ctx-title">{session.title}</span>
          <span>· {AGENT_NAME[v.agent]} · reported {fmtElapsed(v.at)} ago</span>
        </div>
      )}
    </div>
  );
}

/**
 * Plan usage in the status bar — Claude, Codex, or both — with a popover of
 * every limit, under the focused session's context window. Both agents report
 * account-wide numbers from their sessions.
 */
export function UsageMeter({ usage, meters, focused }: { usage: UsageReport | null; meters: Meters | null; focused: SessionInfo | null }) {
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
                .filter((l) => headlineOf(l))
                .map((l) => (
                  <span key={l.label} className={pctNow(l, now) >= 90 ? "hot" : ""}>
                    {headlineOf(l)} {Math.round(pctNow(l, now))}%
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
          <ContextRow session={focused} />
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
                            title={l.note ? "Claude Code reports this window with a reply in a Claude pane; Council turns don't report it" : undefined}
                          >
                            {l.note ?? resetText(l.resetsAt, now)}
                          </span>
                          <span className="usage-pct">{l.note ? "—" : `${Math.round(pct)}%`}</span>
                        </div>
                        <Bar pct={Math.min(100, Math.max(0, pct))} />
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
