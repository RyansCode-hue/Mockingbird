import { useEffect, useState } from "react";
import { Pick } from "./Menu";
import { enterConfirms } from "./keys";
import { titleOf } from "./appModel";
import { isErr, splitGroupKey, topOfKey, type SessionInfo, type WorktreeStateInfo } from "../shared/types";
import { plural } from "../shared/format";
import { baseName } from "../shared/paths";
import { Modal } from "./Modal";

/** The grid's small dialogs: rename, move to a group, restart all, close a session. */

// ---- rename dialog (groups + workspaces) ----
export function RenameDialog({
  title,
  initial,
  onSave,
  onClose,
}: {
  title: string;
  initial: string;
  onSave: (v: string) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <Modal className="modal close-dlg" onClose={onClose}>
      <h3>{title}</h3>
      <input
        type="text"
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && v.trim()) onSave(v.trim());
        }}
      />
      <div className="row">
        <button className="outline" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!v.trim()} onClick={() => onSave(v.trim())}>Save</button>
      </div>
    </Modal>
  );
}

// ---- move-to-group dialog ----
export function GroupDialog({
  session,
  groups,
  onMove,
  onClose,
}: {
  session: SessionInfo;
  groups: string[];
  onMove: (group: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const cur = session.taskGroup ?? "";
  const curTop = cur ? splitGroupKey(cur).top : "";
  const curSub = cur ? (splitGroupKey(cur).sub ?? "") : "";
  const tops = [...new Set(groups.map(topOfKey))];
  const [top, setTop] = useState(curTop && tops.includes(curTop) ? curTop : (tops[0] ?? "__new__"));
  const [newTop, setNewTop] = useState("");
  const [sub, setSub] = useState(curSub);
  const isNew = top === "__new__";
  const effTop = (isNew ? newTop : top).trim().replace(/\//g, "-");

  const move = async (g: string | null) => {
    await onMove(g);
    onClose();
  };
  const apply = () => {
    if (!effTop) return;
    const cleanSub = sub.trim().replace(/\//g, "-");
    move(cleanSub ? `${effTop}/${cleanSub}` : effTop);
  };

  return (
    <Modal className="modal close-dlg" onClose={onClose}>
      <h3>Move {titleOf(session)}</h3>
      <div className="sub-h">
        Pick the group — and optionally a workspace inside it — then Move. Nothing changes until
        you click Move.
      </div>
      <label>Group</label>
      <Pick value={top} onChange={(e) => setTop(e.target.value)}>
        {tops.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
        <option value="__new__">new group…</option>
      </Pick>
      {isNew && (
        <input
          type="text"
          autoFocus
          placeholder="new group name"
          value={newTop}
          onChange={(e) => setNewTop(e.target.value)}
          style={{ marginTop: 6 }}
        />
      )}
      <label>
        Workspace <span className="wi-note">optional — sessions in the same workspace share one tabbed pane</span>
      </label>
      <input
        type="text"
        list="mb-subs"
        placeholder="none"
        value={sub}
        onChange={(e) => setSub(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
        }}
      />
      <datalist id="mb-subs">
        {[...new Set(groups.filter((g) => g.startsWith(effTop + "/")).map((g) => splitGroupKey(g).sub))]
          .filter((s): s is string => !!s)
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
      <div className="row">
        {cur && (
          <button className="outline" style={{ marginRight: "auto" }} onClick={() => move(null)}>
            Remove from group
          </button>
        )}
        <button className="outline" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!effTop} onClick={apply}>Move</button>
      </div>
    </Modal>
  );
}

// ---- restart-all dialog ----
/**
 * Restart every Claude pane in place. The CLI prints "Update installed ·
 * Restart to update" when it upgrades itself, and each running claude keeps the
 * old binary until it is restarted — this does the whole grid at once.
 */
export function RestartAllDialog({
  sessions,
  onClose,
  onDone,
}: {
  sessions: SessionInfo[];
  onClose: () => void;
  onDone: (restarted: string[]) => void;
}) {
  const [includeBusy, setIncludeBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const live = sessions.filter((s) => s.status !== "dead" && !s.shell);
  const active = live.filter((s) => s.status === "working" || s.status === "waiting");
  const count = includeBusy ? live.length : live.length - active.length;

  const run = async () => {
    setBusy(true);
    setError("");
    const r = await window.mb.restartAllSessions(includeBusy);
    if (isErr(r)) {
      setError(r.error);
      setBusy(false);
      return;
    }
    if (r.failed?.length) {
      setError(`${r.failed.length} couldn't restart: ${r.failed.map((f: any) => f.error).join("; ")}`);
      setBusy(false);
      onDone(r.restarted ?? []);
      return;
    }
    onDone(r.restarted ?? []);
    onClose();
  };

  return (
    <Modal className="modal close-dlg" onClose={onClose}>
      <h3>Restart agent sessions?</h3>
      <div className="sub-h">
        Each pane relaunches with <code>--continue</code>, so conversations, grid position, and
        groups are kept. Plain terminals and dead panes are left alone.
      </div>
      {active.length > 0 && (
        <label className="check-line" style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={includeBusy}
            onChange={(e) => setIncludeBusy(e.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>
            also restart the {plural(active.length, "session")} that{" "}
            {active.length === 1 ? "is" : "are"} working or waiting — their in-flight turn is lost
          </span>
        </label>
      )}
      {error && <div className="err">{error}</div>}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="outline" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={run} disabled={busy || count === 0}>
          {busy ? "restarting…" : count === 0 ? "nothing to restart" : `Restart ${plural(count, "session")}`}
        </button>
      </div>
    </Modal>
  );
}

// ---- close-session dialog (design 1e) ----
type CleanupMode = "keep" | "push" | "discard";

export function CloseSessionDialog({
  session,
  wt,
  onCancel,
  onDone,
  forceClose,
}: {
  session: SessionInfo;
  /** The worktree's state, or why it couldn't be read — then the only choice is to keep it. */
  wt: WorktreeStateInfo | { error: string };
  onCancel: () => void;
  onDone: () => void;
  /** Closes the session's pane and process; answers why it couldn't. */
  forceClose: (s: SessionInfo, forget: boolean) => Promise<string | null>;
}) {
  // the safe option is always preselected; the destructive one is never the default
  const [mode, setMode] = useState<CleanupMode>("keep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const wtName = baseName(session.cwd);
  const st = isErr(wt) ? null : wt;
  const stateStr = st
    ? [st.dirty ? plural(st.dirtyFiles, "uncommitted file") : null, st.ahead ? plural(st.ahead, "unpushed commit") : null]
        .filter(Boolean)
        .join(" and ")
    : "";

  const confirm = async () => {
    setBusy(true);
    setError("");
    const stop = (why: string) => {
      setError(why);
      setBusy(false);
    };
    try {
      // the session closes but stays resumable under Previous (scrollback and
      // undo snapshots included) until its worktree has been pushed or removed
      const closeErr = await forceClose(session, false);
      if (closeErr) return stop(`Couldn't close the session: ${closeErr}`);
      if (mode !== "keep") {
        if (!session.repoPath) return stop("The session closed, but it has no repository to clean its worktree up in.");
        const r = await window.mb.worktreeCleanup(session.repoPath, session.cwd, mode);
        if (isErr(r)) return stop(r.error);
        const forgot = await window.mb.killSession(session.id, true);
        if (isErr(forgot)) return stop(`The worktree is done with, but the session couldn't be removed from Previous: ${forgot.error}`);
        if (r?.branchKept) alert(`The worktree is removed, but its branch is still there: ${r.branchKept}`);
      }
      onDone();
    } catch (err) {
      stop(String(err));
    }
  };

  const opts: { mode: CleanupMode; label: string; consequence: string; destructive?: boolean }[] = [
    {
      mode: "keep",
      label: "Keep worktree, close pane",
      consequence: "nothing is lost · resumable under Previous",
    },
    ...(st
      ? [
          {
            mode: "push" as const,
            label: "Push branch, then remove worktree",
            consequence: st.dirty ? `commits WIP on ${st.branch}, pushes, removes the worktree` : `pushes ${st.branch}, removes the worktree`,
          },
          {
            mode: "discard" as const,
            label: "Discard everything and delete",
            consequence: "removes the worktree and deletes the branch · not recoverable",
            destructive: true,
          },
        ]
      : []),
  ];

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // with focus on Cancel (or the confirm button) Enter clicks that button instead
      if (e.key === "Enter" && !busy && enterConfirms(e.target as Element)) {
        e.preventDefault();
        confirm();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <Modal className="modal close-dlg" onClose={onCancel}>
      <h3>Close {titleOf(session)}?</h3>
      <div className="sub-h">
        {st ? (
          <>
            Worktree <span className="wt-name">{wtName}</span> has {stateStr || "local work"}.
          </>
        ) : (
          <>
            Couldn't read worktree <span className="wt-name">{wtName}</span> ({isErr(wt) ? wt.error : ""}). It may hold
            work, so it stays on disk.
          </>
        )}
      </div>
      {opts.map((o) => (
        <button
          key={o.mode}
          className={`opt ${mode === o.mode ? "sel" : ""} ${o.destructive ? "destructive" : ""}`}
          onClick={() => setMode(o.mode)}
        >
          <span className="t">
            <span className="radio" />
            {o.label}
          </span>
          <div className="c">{o.consequence}</div>
        </button>
      ))}
      {error && <div className="err">{error}</div>}
      <div className="row">
        <span className="kbd foot-hint">⏎ to confirm</span>
        <button className="outline" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy} onClick={confirm}>
          {busy ? "Closing…" : "Close session"}
        </button>
      </div>
    </Modal>
  );
}
