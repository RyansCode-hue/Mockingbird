import React, { useEffect, useMemo, useState } from "react";
import { isErr, type GitChange, type GraphCommit, type ScmGraph, type IpcResult } from "../shared/types";
import { layoutGraph, laneCount, type GraphRow } from "./graphLayout";
import { ago } from "./format";
import { settled } from "./settled";

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const H = 24;
const W = 12;
const MAX_LANES = 10;
const COLORS = ["var(--teal)", "var(--amber)", "var(--m-3)", "var(--m-4)", "var(--m-5)", "var(--m-2)", "var(--m-1)", "var(--m-0)"];
const color = (lane: number) => COLORS[lane % COLORS.length];
const x = (lane: number) => W * Math.min(lane, MAX_LANES - 1) + W / 2 + 2;

/** A line from (x1, y1) to (x2, y2), bending smoothly when it changes lane. */
function link(x1: number, y1: number, x2: number, y2: number) {
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const m = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${m} ${x2} ${m} ${x2} ${y2}`;
}

function RowGraph({ sha, row, width, head, merge }: { sha: string; row: GraphRow; width: number; head: boolean; merge: boolean }) {
  const paths: React.ReactNode[] = [];
  const cx = x(row.lane);
  const cy = H / 2;
  row.before.forEach((s, j) => {
    if (!s) return;
    // a lane waiting for this commit ends at its dot; any other lane passes through
    if (s === sha) paths.push(<path key={`in${j}`} d={link(x(j), 0, cx, cy)} style={{ stroke: color(j) }} />);
    else if (row.after.includes(s)) paths.push(<path key={`pass${j}`} d={link(x(j), 0, x(row.after.indexOf(s)), H)} style={{ stroke: color(j) }} />);
  });
  row.parents.forEach((p, i) => {
    const k = row.after.indexOf(p);
    if (k < 0) return; // beyond what's loaded
    paths.push(<path key={`out${i}`} d={link(cx, cy, x(k), H)} style={{ stroke: color(k) }} />);
  });
  return (
    <svg className="gr-svg" width={width} height={H} aria-hidden="true">
      {paths}
      {head ? (
        <>
          <circle cx={cx} cy={cy} r={4.5} className="gr-ring" style={{ stroke: color(row.lane) }} />
          <circle cx={cx} cy={cy} r={2} style={{ fill: color(row.lane) }} />
        </>
      ) : merge ? (
        <circle cx={cx} cy={cy} r={3.5} className="gr-ring" style={{ stroke: color(row.lane) }} />
      ) : (
        <circle cx={cx} cy={cy} r={3.5} style={{ fill: color(row.lane) }} />
      )}
    </svg>
  );
}

/** The lanes that carry on past a commit, drawn beside its expanded file list. */
function PassThrough({ lanes, width }: { lanes: (string | null)[]; width: number }) {
  return (
    <svg className="gr-svg" width={width} height={H} aria-hidden="true">
      {lanes.map((sha, j) => sha && <path key={j} d={`M${x(j)} 0V${H}`} style={{ stroke: color(j) }} />)}
    </svg>
  );
}

function Refs({ c }: { c: GraphCommit }) {
  return (
    <>
      {c.refs.map((r) => (
        <span key={`${r.kind}:${r.name}`} className={`gr-ref ${r.kind}`} title={{ head: "Checked out here", local: "Local branch", remote: "Remote branch", tag: "Tag" }[r.kind]}>
          {r.name}
        </span>
      ))}
    </>
  );
}

/**
 * VS Code's source-control graph for a session's folder: the checked-out
 * branch, the branch it tracks and the base it was made from, with merges and
 * forks drawn as lanes. A commit opens to its files; a file opens its diff.
 */
export function CommitGraph({
  sessionId,
  refreshKey,
  onOpenDiff,
}: {
  sessionId: string;
  /** Changes when the folder's git state does (a commit, push, pull or fetch). */
  refreshKey: string;
  onOpenDiff: (path: string, sha: string, status: GitChange["status"]) => void;
}) {
  const [limit, setLimit] = useState(150);
  const [graph, setGraph] = useState<IpcResult<ScmGraph> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, IpcResult<GitChange[]>>>({});

  useEffect(() => {
    let live = true;
    settled<IpcResult<ScmGraph>>(window.mb.scmGraph(sessionId, limit), "Couldn't read the commit graph").then(
      (r) => live && setGraph((g) => (JSON.stringify(g) === JSON.stringify(r) ? g : r))
    );
    return () => {
      live = false;
    };
  }, [sessionId, limit, refreshKey]);

  const commits = graph && !isErr(graph) ? graph.commits : [];
  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const width = Math.min(laneCount(rows), MAX_LANES) * W + 4;

  const toggle = (sha: string) => {
    setOpen((o) => (o === sha ? null : sha));
    if (!files[sha]) settled<IpcResult<GitChange[]>>(window.mb.scmCommitFiles(sessionId, sha), "Couldn't read the commit's files").then((r) => setFiles((f) => ({ ...f, [sha]: r })));
  };

  if (graph === null) return <div className="fp-note">loading…</div>;
  if (isErr(graph)) return <div className="fp-note err">{graph.error}</div>;
  if (!commits.length) return <div className="fp-note">No commits yet</div>;
  return (
    <div className="gr">
      {commits.map((c, i) => {
        const row = rows[i];
        const head = c.sha === graph.head;
        const list = files[c.sha];
        return (
          <React.Fragment key={c.sha}>
            <div
              className={`gr-row ${open === c.sha ? "open" : ""}`}
              title={`${c.subject}\n${c.author} · ${ago(c.at)} · ${c.sha.slice(0, 8)}${c.parents.length > 1 ? " · merge" : ""}`}
              onClick={() => toggle(c.sha)}
            >
              <RowGraph sha={c.sha} row={row} width={width} head={head} merge={c.parents.length > 1} />
              <span className={`gr-subj ${head ? "head" : ""}`}>{c.subject}</span>
              <Refs c={c} />
            </div>
            {open === c.sha &&
              (list === undefined ? (
                <div className="gr-files">
                  <PassThrough lanes={row.after} width={width} />
                  <span className="fp-note">loading…</span>
                </div>
              ) : isErr(list) ? (
                <div className="gr-files">
                  <PassThrough lanes={row.after} width={width} />
                  <span className="fp-note err">{list.error}</span>
                </div>
              ) : (
                list.map((f) => (
                  <div key={f.path} className={`gr-files fp-row st-${f.status}`} title={f.from ? `${f.from} → ${f.path}` : f.path} onClick={() => onOpenDiff(f.path, c.sha, f.status)}>
                    <PassThrough lanes={row.after} width={width} />
                    <span className="fp-name">
                      {baseName(f.path)}
                      <span className="fp-dir">{dirName(f.path)}</span>
                    </span>
                    <span className="fp-badge">{f.status}</span>
                  </div>
                ))
              ))}
          </React.Fragment>
        );
      })}
      {graph.more && (
        <button className="outline gr-more" onClick={() => setLimit((n) => n + 150)}>
          Show more commits
        </button>
      )}
    </div>
  );
}
