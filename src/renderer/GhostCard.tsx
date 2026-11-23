import { useEffect, useState, type ReactNode } from "react";
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
    // a not-started step never ran: there's no output to read, and main refuses the read
    if (s.planned) return;
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
 *
 * A step not started yet (W8, Inbox.dc.html's Tester) is drawn here too, as a faded card rather than an outline: its
 * title, "Not started" and what starts it in place of a last line, where it will work as its foot, and no buttons. Its
 * prompt is its line's tooltip. It takes the keyboard (a press on it, or Tab): Enter edits it, the menu key and ⇧F10
 * open its menu. It's selected as a workspace is (`selected`: the landscape's selection, and its bar). Either kind can
 * show a model chip (`modelChip`) and, where wires are made, the edge handle a wire is dragged from (`handle`).
 */
export function GhostCard({
  ghost,
  band,
  actions,
  status,
  onMore,
  inv,
  planned,
  plannedShort,
  modelChip,
  handle = false,
  selected = false,
}: {
  ghost: GhostView;
  band: Band;
  /** Its actions (ghostActions): its front session's, a stack's over all its closed tabs. */
  actions: ModelAction[];
  /** Its status line (closedStatus): Closed, its folder gone, or taken over by a teammate; a not-started step's, where it will work. */
  status: string;
  onMore: (from: HTMLElement) => void;
  /** 1 / the camera's zoom when it rendered (the landscape keeps --ls-inv current as it zooms). */
  inv: number;
  /** A not-started step's line in place of what it did last: "Not started. Starts when Reviewer hands off." */
  planned?: string;
  /** Its line zoomed out, one short enough to leave room for its foot (plannedShort): "Waits for approve". */
  plannedShort?: string;
  /** Its model chip (ModelChip), beside its kind: a not-started step's, or a closed one's in a pipeline. */
  modelChip?: ReactNode;
  /** The edge handle a wire is dragged from, as a workspace has (Landscape.tsx draws the wire). */
  handle?: boolean;
  /** A not-started step selected on the landscape. */
  selected?: boolean;
}) {
  const s = ghost.front;
  const { line, error } = useClosedLine(s);
  const r = ghost.rect;
  const notYet = !!s.planned && planned !== undefined;
  const taken = takenOverWhy(s, "");
  const gone = !!actions.find((a) => a.key === "fresh");
  /** Action `k` as a button: while it can be picked, or while it's off only because it's under way. */
  const shown = (k: string) => usable(actions, k) ?? (actionOf(actions, k)?.title === CLOSED_BUSY_WHY ? actionOf(actions, k) : undefined);
  // a not-started step's card has no buttons (Inbox.dc.html's Tester): Start now and Forget are its ⋯ and right-click's
  const buttons = notYet ? [] : (["reopen", "fresh", "takeback"] as const).map(shown).filter((a): a is ModelAction => !!a);
  const forget = notYet ? undefined : shown("forget");
  const where = notYet ? "" : [s.ticketId ? `#${ticketIdOf(s.ticketId)}` : null, s.branch && s.branch !== titleOf(s) ? s.branch : null].filter(Boolean).join(" · ");
  const name = ghost.stack ? ghost.members.map(titleOf).join(" · ") : titleOf(s);
  const lineText = notYet ? (band === "live" ? planned : (plannedShort ?? planned)) : error ? "Couldn't read what it did last" : (line ?? "It wrote nothing before it closed");
  const compact = band === "cards";
  const prompt = notYet ? s.planned!.prompt?.trim() : undefined;
  return (
    <div
      className={["ls-ghost", compact ? "compact" : "", notYet ? "planned" : "", notYet && selected ? "selected" : "", notYet && band === "live" ? "roomy" : "", taken ? "taken" : "", gone ? "gone" : "", ghost.hidden ? "hidden" : ""].filter(Boolean).join(" ")}
      data-ghost={ghost.key}
      data-front={s.id}
      data-area={ghost.area}
      tabIndex={notYet ? 0 : undefined}
      role={notYet ? "group" : undefined}
      aria-label={notYet ? `${name}, a step not started yet: Enter edits it, the menu key opens its menu` : undefined}
      onPointerDown={notYet ? (e) => !(e.target as Element).closest("button") && e.currentTarget.focus({ preventScroll: true }) : undefined}
      onKeyDown={
        notYet
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter") {
                e.preventDefault();
                usable(actions, "edit")?.onPick();
              } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                e.preventDefault();
                onMore(e.currentTarget.querySelector<HTMLElement>(".ls-more") ?? e.currentTarget);
              }
            }
          : undefined
      }
      // inset by --ci zoomed out to cards, as cards are, its height --gh there kept clear of the next area's name line
      // (styles.css, Landscape's paintCompact)
      style={{ left: `calc(${r.x}px + var(--ci))`, top: `calc(${r.y}px + var(--ci))`, width: `calc(${r.w}px - 2 * var(--ci))`, ["--gh" as string]: `${r.h}px`, ["--ls-inv" as string]: inv }}
      title={taken ?? undefined}
    >
      <div className="lg-rows">
        <div className="lg-head" data-row="head">
          <span className="lg-dot" aria-hidden="true" />
          {/* its title wins the room: the chip gives way first, whole (styles.css) */}
          <span className="lg-name">
            <span className="lg-title" title={name}>
              {name}
            </span>
            <span className="chip lg-kind">{ghost.stack ? `stack · ${ghost.members.length}` : kindLabel(s)}</span>
            {!compact && modelChip}
          </span>
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
        <div className="lg-line" data-row="line" title={notYet ? (prompt ? `${planned}\n\nIts prompt:\n${prompt}` : planned) : lineText}>
          {lineText}
        </div>
        <div className="lg-foot" data-row="foot">
          <span className="lg-status">{status}</span>
          {where && <span className="lg-where">{where}</span>}
        </div>
      </div>
      {handle && !compact && !ghost.stack && <div className="ls-wh" aria-hidden="true" data-tip="Drag to another workspace to wire them" style={{ ["--ls-inv" as string]: inv }} />}
    </div>
  );
}
