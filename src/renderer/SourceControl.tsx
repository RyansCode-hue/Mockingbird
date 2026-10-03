import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GitChange, GitChanges, ScmEntry, ScmStatus } from "../shared/types";

type Result<T> = T | { error: string };
const isErr = (r: unknown): r is { error: string } => !!r && typeof r === "object" && "error" in (r as object);
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const TITLE: Record<ScmEntry["status"], string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", U: "Untracked", C: "Conflict" };

/** Which diff a row opens: staged/unstaged from Source Control, or the whole branch against its base. */
export type DiffSource = { kind: "scm"; staged: boolean; untracked: boolean } | { kind: "branch"; untracked: boolean };

/**
 * VS Code's Source Control view for a session's folder: conflicts, staged and
 * unstaged changes with stage / unstage / discard per file or all at once, a
 * commit box (⌘↵), push, and — collapsed — everything the branch changed since
 * its base, to review before a PR.
 */
export function SourceControl({
  sessionId,
  selected,
  onOpenDiff,
  onOpenFile,
}: {
  sessionId: string;
  selected: string | null;
  onOpenDiff: (path: string, source: DiffSource, status: ScmEntry["status"]) => void;
  onOpenFile: (path: string) => void;
}) {
  const [status, setStatus] = useState<Result<ScmStatus> | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set(["branch"]));
  const [branch, setBranch] = useState<Result<GitChanges> | null>(null);
  const broken = useRef(false);

  const load = useCallback(async () => {
    const r: Result<ScmStatus> = await window.mb.scmStatus(sessionId);
    broken.current = isErr(r);
    setStatus((s) => (JSON.stringify(s) === JSON.stringify(r) ? s : r));
  }, [sessionId]);

  // the session edits files underneath the view, so it re-reads while visible;
  // a folder that isn't a repository stops the poll (the refresh button retries)
  useEffect(() => {
    setStatus(null);
    setBranch(null);
    load();
    const t = setInterval(() => !document.hidden && !broken.current && load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (closed.has("branch")) return;
    window.mb.filesChanges(sessionId, "branch").then((r: Result<GitChanges>) => setBranch(r));
  }, [closed, sessionId, status]);

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError("");
    const r = await fn();
    setBusy("");
    if (isErr(r)) setError(r.error);
    await load();
    return r;
  };

  if (status === null) return <div className="fp-note">loading…</div>;
  if (isErr(status)) return <div className="fp-note err">{status.error}</div>;

  const { staged, unstaged, conflicted } = status;
  const commit = async () => {
    if (!message.trim()) return setError("Write a commit message first");
    if (!staged.length) {
      if (!unstaged.length) return setError("There's nothing to commit");
      if (!window.confirm(`Nothing is staged. Stage all ${unstaged.length} change${unstaged.length === 1 ? "" : "s"} and commit?`)) return;
      const r = await act("stage", () => window.mb.scmStage(sessionId, unstaged.map((e) => e.path)));
      if (isErr(r)) return;
    }
    const r = await act("commit", () => window.mb.scmCommit(sessionId, message));
    if (!isErr(r)) setMessage("");
  };
  const discard = (entries: ScmEntry[]) => {
    const untracked = entries.filter((e) => e.status === "U").length;
    const tracked = entries.length - untracked;
    const what = entries.length === 1 ? baseName(entries[0].path) : `${entries.length} files`;
    const how = [tracked && "their changes can't be recovered", untracked && "new files go to the Trash"].filter(Boolean).join("; ");
    if (!window.confirm(`Discard changes to ${what}? (${how})`)) return;
    act("discard", () => window.mb.scmDiscard(sessionId, entries.map((e) => ({ path: e.path, untracked: e.status === "U" }))));
  };
  const toggle = (k: string) =>
    setClosed((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const row = (e: ScmEntry, group: "staged" | "unstaged" | "conflicted") => (
    <div
      key={`${group}:${e.path}`}
      className={`fp-row sc-row st-${e.status} ${selected === e.path ? "sel" : ""}`}
      title={e.from ? `${e.from} → ${e.path}` : e.path}
      onClick={() => onOpenDiff(e.path, { kind: "scm", staged: group === "staged", untracked: e.status === "U" }, e.status)}
    >
      <span className="fp-name">
        {baseName(e.path)}
        <span className="fp-dir">{dirName(e.path)}</span>
      </span>
      <span className="sc-acts">
        {e.status !== "D" && (
          <button className="icon" title="Open file" onClick={(ev) => (ev.stopPropagation(), onOpenFile(e.path))}>
            ⧉
          </button>
        )}
        {group === "unstaged" && (
          <button className="icon" title="Discard changes" onClick={(ev) => (ev.stopPropagation(), discard([e]))}>
            ↺
          </button>
        )}
        {group === "staged" ? (
          <button className="icon" title="Unstage" onClick={(ev) => (ev.stopPropagation(), act("unstage", () => window.mb.scmUnstage(sessionId, [e.path])))}>
            −
          </button>
        ) : (
          <button className="icon" title="Stage" onClick={(ev) => (ev.stopPropagation(), act("stage", () => window.mb.scmStage(sessionId, [e.path])))}>
            +
          </button>
        )}
      </span>
      <span className="fp-badge" title={TITLE[e.status]}>{e.status}</span>
    </div>
  );

  const section = (key: string, title: string, list: ScmEntry[], group: "staged" | "unstaged" | "conflicted", actions?: React.ReactNode) =>
    list.length > 0 && (
      <>
        <div className="sc-sec" onClick={() => toggle(key)}>
          <span className="sc-chev">{closed.has(key) ? "▸" : "▾"}</span>
          {title}
          <span className="fp-count">{list.length}</span>
          <span className="sc-acts" onClick={(ev) => ev.stopPropagation()}>
            {actions}
          </span>
        </div>
        {!closed.has(key) && list.map((e) => row(e, group))}
      </>
    );

  const pushLabel = !status.upstream ? "Publish branch" : status.ahead ? `Push ↑${status.ahead}` : "Push";
  return (
    <div className="sc">
      <div className="sc-branch" title={status.upstream ? `Tracking ${status.upstream}` : "Not on origin yet"}>
        <span className="sc-br">⎇ {status.branch ?? "detached HEAD"}</span>
        {status.upstream && (
          <span className="sc-ab">
            ↑{status.ahead} ↓{status.behind}
          </span>
        )}
        <button
          className="outline sc-push"
          disabled={!!busy || !status.branch || (!!status.upstream && status.ahead === 0)}
          title={status.upstream ? `Push to ${status.upstream}` : "Push this branch to origin and track it"}
          onClick={() => act("push", () => window.mb.scmPush(sessionId))}
        >
          {busy === "push" ? "Pushing…" : pushLabel}
        </button>
      </div>
      <textarea
        className="sc-msg"
        rows={2}
        placeholder={`Message (⌘↵ to commit on ${status.branch ?? "HEAD"})`}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          }
        }}
      />
      <button className="primary sc-commit" disabled={!!busy || (!staged.length && !unstaged.length)} onClick={commit}>
        {busy === "commit" ? "Committing…" : staged.length ? `Commit ${staged.length}` : "Commit"}
      </button>
      {error && <div className="fp-note err">{error}</div>}
      <div className="fp-scroll sc-list">
        {!staged.length && !unstaged.length && !conflicted.length && <div className="fp-note">No changes — the working tree matches the last commit.</div>}
        {section("conflicted", "Merge conflicts", conflicted, "conflicted")}
        {section(
          "staged",
          "Staged changes",
          staged,
          "staged",
          <button className="icon" title="Unstage all" onClick={() => act("unstage", () => window.mb.scmUnstage(sessionId, staged.map((e) => e.path)))}>
            −
          </button>
        )}
        {section(
          "unstaged",
          "Changes",
          unstaged,
          "unstaged",
          <>
            <button className="icon" title="Discard all changes" onClick={() => discard(unstaged)}>
              ↺
            </button>
            <button className="icon" title="Stage all changes" onClick={() => act("stage", () => window.mb.scmStage(sessionId, unstaged.map((e) => e.path)))}>
              +
            </button>
          </>
        )}
        <div className="sc-sec" onClick={() => toggle("branch")}>
          <span className="sc-chev">{closed.has("branch") ? "▸" : "▾"}</span>
          Whole branch
          {branch && !isErr(branch) && <span className="fp-count">{branch.changes.length}</span>}
        </div>
        {!closed.has("branch") &&
          (branch === null ? (
            <div className="fp-note">loading…</div>
          ) : isErr(branch) ? (
            <div className="fp-note err">{branch.error}</div>
          ) : branch.changes.length === 0 ? (
            <div className="fp-note">No changes since {branch.base}</div>
          ) : (
            <>
              <div className="fp-note">Everything since it forked from {branch.base} — commits and uncommitted work</div>
              {branch.changes.map((c: GitChange) => (
                <div
                  key={`b:${c.path}`}
                  className={`fp-row sc-row st-${c.status} ${selected === c.path ? "sel" : ""}`}
                  title={c.from ? `${c.from} → ${c.path}` : c.path}
                  onClick={() => onOpenDiff(c.path, { kind: "branch", untracked: c.status === "U" }, c.status)}
                >
                  <span className="fp-name">
                    {baseName(c.path)}
                    <span className="fp-dir">{dirName(c.path)}</span>
                  </span>
                  <span className="fp-badge">{c.status}</span>
                </div>
              ))}
            </>
          ))}
      </div>
    </div>
  );
}
