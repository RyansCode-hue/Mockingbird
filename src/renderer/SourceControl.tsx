import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GitChange, GitChanges, ScmEntry, ScmStatus } from "../shared/types";
import { useFolderRefresh } from "./folderWatch";
import { SparkleIcon } from "./Icons";
import { CommitGraph } from "./CommitGraph";

type Result<T> = T | { error: string };
const isErr = (r: unknown): r is { error: string } => !!r && typeof r === "object" && "error" in (r as object);
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const TITLE: Record<ScmEntry["status"], string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", U: "Untracked", C: "Conflict" };

/** Which diff a row opens: staged/unstaged from Source Control, the whole branch against its base, or one commit from the graph. */
export type DiffSource =
  | { kind: "scm"; staged: boolean; untracked: boolean }
  | { kind: "branch"; untracked: boolean }
  | { kind: "commit"; sha: string; untracked: false };

/**
 * VS Code's Source Control view for a session's folder: conflicts, staged and
 * unstaged changes with stage / unstage / discard per file or all at once, a
 * commit box (⌘↵), push, and — collapsed — everything the branch changed since
 * its base, to review before a PR.
 */
export function SourceControl({
  sessionId,
  root,
  selected,
  onOpenDiff,
  onOpenFile,
  onAskSession,
}: {
  sessionId: string;
  /** The session's folder: its changes refresh the view. */
  root: string;
  selected: string | null;
  onOpenDiff: (path: string, source: DiffSource, status: ScmEntry["status"]) => void;
  onOpenFile: (path: string) => void;
  /** Type a request into the session's prompt — to hand a git failure to the agent. */
  onAskSession?: (text: string) => void;
}) {
  const [status, setStatus] = useState<Result<ScmStatus> | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // what was being done when the error happened, to tell the agent
  const [failed, setFailed] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set(["branch"]));
  // refetch the graph only when what it draws can have moved
  const graphKey = status && !isErr(status) ? `${status.branch}|${status.upstream}|${status.ahead}|${status.behind}` : "";
  const [branch, setBranch] = useState<Result<GitChanges> | null>(null);
  const broken = useRef(false);
  // the message box grows with what's in it (a generated body), up to a point
  const msgRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = msgRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 220)}px`;
  }, [message, status]);

  const load = useCallback(async () => {
    const r: Result<ScmStatus> = await window.mb.scmStatus(sessionId);
    broken.current = isErr(r);
    setStatus((s) => (JSON.stringify(s) === JSON.stringify(r) ? s : r));
  }, [sessionId]);

  // the session edits files underneath the view, so it re-reads when the folder
  // changes; a folder that isn't a repository isn't asked again
  useEffect(() => {
    setStatus(null);
    setBranch(null);
    load();
  }, [load]);
  useFolderRefresh(root, () => !broken.current && load());

  // read once for the section's title (which base, how many files), then kept fresh while it's open
  const branchOpen = !closed.has("branch");
  useEffect(() => {
    if (!branchOpen && branch !== null) return;
    window.mb.filesChanges(sessionId, "branch").then((r: Result<GitChanges>) => setBranch(r));
  }, [branchOpen, sessionId, status]);

  const generate = async () => {
    setBusy("generate");
    setError("");
    setFailed(""); // not a git failure: nothing to hand the agent
    const r: Result<{ message: string; scope: "staged" | "all"; agent: string }> = await window.mb.scmCommitMessage(sessionId);
    setBusy("");
    if (isErr(r)) setError(r.error);
    else setMessage(r.message);
  };

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError("");
    const r = await fn();
    setBusy("");
    if (isErr(r)) {
      setError(r.error);
      setFailed(what);
    }
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

  const section = (key: string, title: string, list: ScmEntry[], group: "staged" | "unstaged" | "conflicted", actions?: React.ReactNode, hint?: string) =>
    list.length > 0 && (
      <>
        <div className="sc-sec" title={hint} onClick={() => toggle(key)}>
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

  const pushLabel = !status.published ? "Publish branch" : status.ahead ? `Push ↑${status.ahead}` : "Push";
  const s = (n: number) => (n === 1 ? "" : "s");
  return (
    <div className="sc">
      <div className="sc-branch">
        <span className="sc-who">
          <span className="sc-br" title={status.branch ?? undefined}>⎇ {status.branch ?? "detached HEAD"}</span>
          <span
            className="sc-ab"
            title={
              status.upstream
                ? `Compared with ${status.upstream} (as of the last fetch): ↑${status.ahead} commit${s(status.ahead)} here that it doesn't have, ↓${status.behind} commit${s(status.behind)} there that this branch doesn't have`
                : "This branch doesn't track a remote branch yet"
            }
          >
            {status.upstream ? `↑${status.ahead} ↓${status.behind} vs ${status.upstream}` : "not on origin yet"}
          </span>
        </span>
        <span className="sc-sync">
          <button className="icon" disabled={!!busy} title="Fetch — check origin for new commits (updates ↑↓ and the graph)" onClick={() => act("fetch", () => window.mb.scmFetch(sessionId))}>
            {busy === "fetch" ? "…" : "⇣"}
          </button>
          {status.upstream && status.behind > 0 && (
            <button
              className="outline"
              disabled={!!busy}
              title={`Bring the ${status.behind} new commit${s(status.behind)} on ${status.upstream} into this branch — fast-forward only, so nothing is merged or rewritten; if both sides have moved it says so and changes nothing`}
              onClick={() => act("pull", () => window.mb.scmPull(sessionId))}
            >
              {busy === "pull" ? "Pulling…" : "Pull"}
            </button>
          )}
          <button
            className="outline"
            disabled={!!busy || !status.branch || (status.published && status.ahead === 0)}
            title={status.published ? `Push to ${status.upstream}` : `Push this branch to origin/${status.branch} and track it there${status.upstream ? ` (it tracks ${status.upstream} until then — pushing never goes there)` : ""}`}
            onClick={() => act("push", () => window.mb.scmPush(sessionId))}
          >
            {busy === "push" ? "Pushing…" : pushLabel}
          </button>
        </span>
      </div>
      <div className="sc-msg-wrap">
        <textarea
          ref={msgRef}
          className="sc-msg"
          rows={2}
          placeholder={busy === "generate" ? "Writing a message from the changes…" : `Message (⌘↵ to commit on ${status.branch ?? "HEAD"})`}
          value={message}
          disabled={busy === "generate"}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
        />
        <button
          className={`icon sc-gen ${busy === "generate" ? "busy" : ""}`}
          disabled={!!busy || (!staged.length && !unstaged.length)}
          title={`Generate a commit message from ${staged.length ? "the staged changes" : "all changes (nothing is staged)"} — written by the session's agent`}
          aria-label="Generate commit message"
          onClick={generate}
        >
          <SparkleIcon />
        </button>
      </div>
      <button className="primary sc-commit" disabled={!!busy || (!staged.length && !unstaged.length)} onClick={commit}>
        {busy === "commit" ? "Committing…" : staged.length ? `Commit ${staged.length}` : "Commit"}
      </button>
      {error && (
        <div className="fp-note err sc-err">
          {error}
          {onAskSession && failed && (
            <button
              className="outline"
              data-tip="Types this error into the session's prompt so the agent can fix it — you press Enter"
              onClick={() =>
                onAskSession(
                  `In this worktree, git ${failed} failed: ${error.replace(/^git [\w-]+:\s*/, "").replace(/\s+/g, " ").trim()} — please fix it, then tell me what you did.`
                )
              }
            >
              Ask the session to fix
            </button>
          )}
        </div>
      )}
      <div className="fp-scroll sc-list">
        {!staged.length && !unstaged.length && !conflicted.length && <div className="fp-note">No changes — the working tree matches the last commit.</div>}
        {section("conflicted", "Merge conflicts", conflicted, "conflicted", undefined, "Files git couldn't merge — fix them, then stage")}
        {section(
          "staged",
          "Staged changes",
          staged,
          "staged",
          <button className="icon" title="Unstage all" onClick={() => act("unstage", () => window.mb.scmUnstage(sessionId, staged.map((e) => e.path)))}>
            −
          </button>,
          "What the next commit will contain"
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
          </>,
          "Uncommitted edits since the last commit that aren't staged yet"
        )}
        <div
          className="sc-sec"
          title={`Everything this branch changed since it split off ${branch && !isErr(branch) ? branch.base : "its base branch"} — commits and uncommitted work together: what a pull request would contain`}
          onClick={() => toggle("branch")}
        >
          <span className="sc-chev">{closed.has("branch") ? "▸" : "▾"}</span>
          Branch vs {branch && !isErr(branch) ? branch.base : "base"}
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
              <div className="fp-note">What a pull request into {branch.base.replace(/^origin\//, "")} would contain — this branch's commits and uncommitted work</div>
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
        <div className="sc-sec" title="The commit history of this branch, the branch it tracks and the base it was made from" onClick={() => toggle("graph")}>
          <span className="sc-chev">{closed.has("graph") ? "▸" : "▾"}</span>
          Graph
        </div>
        {!closed.has("graph") && (
          <CommitGraph
            sessionId={sessionId}
            refreshKey={graphKey}
            onOpenDiff={(path, sha, st) => onOpenDiff(path, { kind: "commit", sha, untracked: false }, st)}
          />
        )}
      </div>
    </div>
  );
}
