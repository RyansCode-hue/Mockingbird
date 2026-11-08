import { useState } from "react";
import { ticketIdOf, type SessionInfo } from "../shared/types";
import { titleOf } from "./appModel";
import { ChevronIcon, CloseIcon } from "./Icons";
import { useContextMenu } from "./ContextMenu";
import { actionOf, menuOf, type ModelAction } from "./workspaceActions";

/**
 * The Closed sessions list (docs/landscape.md, Ghost cards): this Mac's closed sessions with no ghost on the landscape
 * (left in the grid's Previous, or closed off the landscape), under the area tree above the Connected line; every closed
 * session while the landscape has no layout yet, so each can always be reached. A row reopens its session (placed as a
 * new workspace in its group's area, or loose when that's gone) or forgets it; Reopen all reopens every one that can be.
 * Its rows' actions are the ghost model's (ghostActions), so a copy a teammate continues is taken back, never reopened,
 * exactly as its ghost would be; right-click offers every action.
 */
export function ClosedSessions({
  list,
  actionsFor,
  all,
  statusFor,
}: {
  list: readonly SessionInfo[];
  /** A row's actions (ghostActions with the list's env). */
  actionsFor: (s: SessionInfo) => ModelAction[];
  /** Reopen all and Clear, over the whole list (ghostsActions). */
  all: ModelAction[];
  /** Its status line (closedStatus). */
  statusFor: (s: SessionInfo) => string;
}) {
  const [open, setOpen] = useState(true);
  const menu = useContextMenu("Closed sessions");
  if (!list.length) return null;
  const reopenAll = actionOf(all, "reopenAll");
  return (
    <section className="lt-closed" data-closed-list aria-label="Closed sessions">
      <div className="lt-closed-head" onContextMenu={(e) => (e.preventDefault(), menu.openAt({ x: e.clientX, y: e.clientY }, menuOf(all)))}>
        <button type="button" className="lt-closed-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ChevronIcon open={open} />
          <span>Closed sessions ({list.length})</span>
        </button>
        {reopenAll && (
          <button type="button" className="lt-closed-all" data-act="reopenAll" disabled={reopenAll.disabled} title={reopenAll.title} onClick={() => reopenAll.onPick()}>
            ↺ Reopen all
          </button>
        )}
      </div>
      {open && (
        <div className="lt-closed-rows">
          {list.map((s) => {
            const acts = actionsFor(s);
            const where = [s.ticketId ? `#${ticketIdOf(s.ticketId)}` : null, s.branch && s.branch !== titleOf(s) ? s.branch : null].filter(Boolean).join(" · ");
            const reopen = actionOf(acts, "reopen");
            const forget = actionOf(acts, "forget");
            // what it offers instead of Reopen: Start fresh (its folder can't run), Take it back (a teammate continues it)
            const instead = (["fresh", "takeback"] as const).map((k) => actionOf(acts, k)).filter((a): a is ModelAction => !!a && !a.disabled);
            return (
              <div
                key={s.id}
                className="lt-closed-row"
                data-closed-sid={s.id}
                title={`${titleOf(s)}\n${s.cwd}`}
                onContextMenu={(e) => (e.preventDefault(), menu.openAt({ x: e.clientX, y: e.clientY }, menuOf(acts)))}
              >
                <span className="dot dead" aria-hidden="true" />
                <span className="lt-closed-name">
                  <span className="lt-t">{titleOf(s)}</span>
                  <span className="lt-closed-sub">{[statusFor(s), where].filter(Boolean).join(" · ")}</span>
                </span>
                {instead.length
                  ? instead.map((a) => (
                      <button key={a.key} type="button" className="lt-closed-act" data-act={a.key} title={a.title} onClick={() => a.onPick()}>
                        {a.label}
                      </button>
                    ))
                  : reopen && (
                      <button type="button" className="lt-closed-act" data-act="reopen" aria-label={`Reopen ${titleOf(s)}`} disabled={reopen.disabled} title={reopen.title} onClick={() => reopen.onPick()}>
                        ↺
                      </button>
                    )}
                {forget && (
                  <button type="button" className="lt-closed-act danger" data-act="forget" aria-label={`Forget ${titleOf(s)}`} disabled={forget.disabled} title={forget.title} onClick={() => forget.onPick()}>
                    <CloseIcon />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {menu.menu}
    </section>
  );
}
