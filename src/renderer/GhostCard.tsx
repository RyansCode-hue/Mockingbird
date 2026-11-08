import { useEffect, useState } from "react";
import { isErr, ticketIdOf, type SessionInfo } from "../shared/types";
import { lastMeaningfulLine, terminalLines } from "../shared/terminalText";
import type { Band, GhostView } from "./landscapeModel";
import { titleOf } from "./appModel";
import { kindLabel } from "./WorkspaceCard";
import { MoreIcon } from "./Icons";
import { runCheck } from "./settled";
import { CLOSED_BUSY_WHY, actionOf, takenOverWhy, usable, type ModelAction } from "./workspaceActions";

/**
 * A closed session's last line, from the output main saved when it closed (sessions:closedOutput): what its ghost
 * says it did last. Read once per session; a failure is logged and said on the card.
 */
export function useClosedLine(s: SessionInfo): { line: string | null; error: string | null } {
  const [got, setGot] = useState<{ line: string | null; error: string | null }>({ line: null, error: null });
  const agent = s.shell ? null : (s.agent ?? "claude");
  useEffect(() => {
    let alive = true;
    void runCheck(`${s.id}'s saved output for its ghost`, window.mb.closedOutput(s.id)).then((r) => {
      if (!alive) return;
      if (isErr(r)) return setGot({ line: null, error: r.error });
      setGot({ line: lastMeaningfulLine(terminalLines(r || ""), { agent }), error: null });
    });
    return () => void (alive = false);
  }, [s.id]);
  return got;
}

/**
 * A ghost (docs/landscape.md, Ghost cards): a closed workspace, a dashed outline where it was. It shows its title, its
 * actions under it (its owner's ghost model: Reopen, Start fresh for one whose worktree is gone, Take it back for one a
 * teammate continues, Forget), its last line, and its status with ticket and branch; ⋯ and right-click offer every
 * action (zoomed out to cards, right-click only: its title keeps the room). Its type is at landscape scale at 100% and
 * keeps its size on screen zoomed out (--ls-inv), where it's drawn inset in its place as cards are. A button whose action
 * is under way (being reopened or forgotten) stays, off, saying so. Its rows are in the order a ghost too short for
 * them all gives them up from the end (styles.css leaves out whole rows that don't fit, never drawing past its place):
 * title, actions, last line, status.
 */
export function GhostCard({
  ghost,
  band,
  actions,
  status,
  onMore,
  inv,
}: {
  ghost: GhostView;
  band: Band;
  /** Its actions (ghostActions): its front session's, a stack's over all its closed tabs. */
  actions: ModelAction[];
  /** Its status line (closedStatus): Closed, its folder gone, or taken over by a teammate. */
  status: string;
  onMore: (from: HTMLElement) => void;
  /** 1 / the camera's zoom when it rendered (the landscape keeps --ls-inv current as it zooms). */
  inv: number;
}) {
  const s = ghost.front;
  const { line, error } = useClosedLine(s);
  const r = ghost.rect;
  const taken = takenOverWhy(s, "");
  const gone = !!actions.find((a) => a.key === "fresh");
  /** Action `k` as a button: while it can be picked, or while it's off only because it's under way. */
  const shown = (k: string) => usable(actions, k) ?? (actionOf(actions, k)?.title === CLOSED_BUSY_WHY ? actionOf(actions, k) : undefined);
  const buttons = (["reopen", "fresh", "takeback"] as const).map(shown).filter((a): a is ModelAction => !!a);
  const forget = shown("forget");
  const where = [s.ticketId ? `#${ticketIdOf(s.ticketId)}` : null, s.branch && s.branch !== titleOf(s) ? s.branch : null].filter(Boolean).join(" · ");
  const name = ghost.stack ? ghost.members.map(titleOf).join(" · ") : titleOf(s);
  const lineText = error ? "Couldn't read what it did last" : (line ?? "It wrote nothing before it closed");
  const compact = band === "cards";
  return (
    <div
      className={["ls-ghost", compact ? "compact" : "", taken ? "taken" : "", gone ? "gone" : "", ghost.hidden ? "hidden" : ""].filter(Boolean).join(" ")}
      data-ghost={ghost.key}
      data-front={s.id}
      data-area={ghost.area}
      // inset by --ci zoomed out to cards, as cards are, its height --gh there kept clear of the next area's name line
      // (styles.css, Landscape's paintCompact)
      style={{ left: `calc(${r.x}px + var(--ci))`, top: `calc(${r.y}px + var(--ci))`, width: `calc(${r.w}px - 2 * var(--ci))`, ["--gh" as string]: `${r.h}px`, ["--ls-inv" as string]: inv }}
      title={taken ?? undefined}
    >
      <div className="lg-rows">
        <div className="lg-head" data-row="head">
          <span className="lg-dot" aria-hidden="true" />
          <span className="lg-title" title={name}>
            {name}
          </span>
          <span className="chip lg-kind">{ghost.stack ? `stack · ${ghost.members.length}` : kindLabel(s)}</span>
          {!compact && (
          <button
            type="button"
            className="ls-more"
            aria-haspopup="menu"
            aria-label={`${name}: its actions`}
            data-tip="Its actions — or right-click it"
            onClick={(e) => {
              e.stopPropagation();
              onMore(e.currentTarget);
            }}
          >
            <MoreIcon />
          </button>
          )}
        </div>
        {(buttons.length > 0 || forget) && (
          <div className="lg-acts" data-row="acts">
            {buttons.map((a) => (
              <button key={a.key} type="button" className={`outline ${a.primary ? "strong" : ""}`} title={a.title} data-act={a.key} disabled={a.disabled} onClick={(e) => (e.stopPropagation(), a.onPick())}>
                {a.key === "reopen" ? "↺ Reopen" : a.label}
              </button>
            ))}
            {forget && (
              <button type="button" className="lg-forget" title={forget.title} data-act="forget" disabled={forget.disabled} onClick={(e) => (e.stopPropagation(), forget.onPick())}>
                Forget
              </button>
            )}
          </div>
        )}
        <div className="lg-line" data-row="line" title={lineText}>
          {lineText}
        </div>
        <div className="lg-foot" data-row="foot">
          <span className="lg-status">{status}</span>
          {where && <span className="lg-where">{where}</span>}
        </div>
      </div>
    </div>
  );
}
