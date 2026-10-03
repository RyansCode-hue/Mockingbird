import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo, FileEntry, FileContent, GitChange, GitChanges } from "../shared/types";
import { highlightLines, languageFor } from "./highlight";
import { tabKey, type EditorState, type OpenFile } from "./editorTabs";
import { useFolderRefresh } from "./folderWatch";

type Result<T> = T | { error: string };
const isErr = (r: unknown): r is { error: string } => !!r && typeof r === "object" && "error" in (r as object);

function loadLS<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

const STATUS_TITLE: Record<GitChange["status"], string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  U: "Untracked",
};

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const SLIDE_MS = 200;

/**
 * The Explorer view's tree for the focused session's folder. Changed files and
 * the folders holding them are marked; a click opens a file in its own tab.
 * a double-click keeps it open. Only mounted while the view shows, so a hidden
 * explorer polls nothing.
 */
export function ExplorerTree({
  session,
  activePath,
  onOpen,
}: {
  session: SessionInfo | null;
  /** The active editor tab's file, if it's in this folder: highlighted in the tree. */
  activePath: string | null;
  onOpen: (path: string, status: GitChange["status"] | undefined) => void;
}) {
  // expanded folders are remembered per folder-on-disk, so flipping between
  // sessions restores each tree the way it was left
  const [expandedByRoot, setExpandedByRoot] = useState<Record<string, string[]>>(() => loadLS("mb.files.expanded", {}));
  useEffect(() => localStorage.setItem("mb.files.expanded", JSON.stringify(expandedByRoot)), [expandedByRoot]);
  const [dirs, setDirs] = useState<Record<string, Result<FileEntry[]>>>({});
  const [changes, setChanges] = useState<Result<GitChanges> | null>(null);

  const sid = session?.id ?? null;
  const root = session?.cwd ?? null;
  const expanded = useMemo(() => new Set(root ? expandedByRoot[root] ?? [] : []), [expandedByRoot, root]);

  const loadDir = useCallback(async (id: string, rel: string) => {
    const r: Result<FileEntry[]> = await window.mb.filesList(id, rel);
    setDirs((d) => (JSON.stringify(d[rel]) === JSON.stringify(r) ? d : { ...d, [rel]: r }));
  }, []);

  // the tree marks what changed since the last commit
  const loadChanges = useCallback(async (id: string) => {
    const r: Result<GitChanges> = await window.mb.filesChanges(id, "working");
    setChanges((c) => (JSON.stringify(c) === JSON.stringify(r) ? c : r));
    return r;
  }, []);

  // a different session folder is a different tree
  useEffect(() => {
    setDirs({});
    setChanges(null);
  }, [root]);

  // A failing change list (not a git repo) isn't asked again on every change —
  // the tree still refreshes; the refresh button retries the change list.
  const gitBroken = useRef(false);
  const refresh = useCallback(
    (retryGit = false) => {
      if (!sid) return;
      loadDir(sid, "");
      for (const rel of expanded) loadDir(sid, rel);
      if (gitBroken.current && !retryGit) return;
      loadChanges(sid).then((r) => (gitBroken.current = isErr(r)));
    },
    [sid, expanded, loadDir, loadChanges]
  );
  useEffect(() => refresh(true), [sid, root]);
  // sessions edit files underneath us: refresh when the folder changes
  useFolderRefresh(root, refresh);

  const toggleDir = (rel: string) => {
    if (!root || !sid) return;
    const opening = !expanded.has(rel);
    if (opening) loadDir(sid, rel);
    setExpandedByRoot((m) => {
      const next = new Set(m[root] ?? []);
      if (opening) next.add(rel);
      else next.delete(rel);
      return { ...m, [root]: [...next] };
    });
  };

  const changeList = changes && !isErr(changes) ? changes.changes : [];
  const changeByPath = useMemo(() => new Map(changeList.map((c) => [c.path, c])), [changeList]);
  const dirtyDirs = useMemo(() => {
    const s = new Set<string>();
    for (const c of changeList) {
      if (c.status === "D") continue;
      for (let d = dirName(c.path); d; d = dirName(d)) s.add(d);
    }
    return s;
  }, [changeList]);

  const renderTree = (rel: string, depth: number): React.ReactNode => {
    const list = dirs[rel];
    if (!list) return <div className="fp-note" style={{ paddingLeft: 12 + depth * 12 }}>loading…</div>;
    if (isErr(list)) return <div className="fp-note err" style={{ paddingLeft: 12 + depth * 12 }}>{list.error}</div>;
    if (list.length === 0 && depth === 0) return <div className="fp-note">empty folder</div>;
    return list.map((e) => {
      const ch = changeByPath.get(e.path);
      const cls = ch ? `st-${ch.status}` : e.dir && dirtyDirs.has(e.path) ? "st-dir" : "";
      return (
        <React.Fragment key={e.path}>
          <div
            className={`fp-row ${cls} ${activePath === e.path ? "sel" : ""}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            title={e.path}
            onClick={() => (e.dir ? toggleDir(e.path) : onOpen(e.path, ch?.status))}
          >
            <span className="fp-tw">{e.dir ? (expanded.has(e.path) ? "▾" : "▸") : ""}</span>
            <span className="fp-name">{e.name}</span>
            {ch && <span className="fp-badge" title={STATUS_TITLE[ch.status]}>{ch.status}</span>}
            {!ch && cls === "st-dir" && <span className="fp-badge">●</span>}
          </div>
          {e.dir && expanded.has(e.path) && renderTree(e.path, depth + 1)}
        </React.Fragment>
      );
    });
  };

  if (!session) return <div className="fp-note">Click into a session to browse its folder.</div>;
  return (
    <>
      <div className="fp-head">
        <span className="fp-title" title={root ?? undefined}>
          {baseName(root!)}
          {session.branch && <span className="fp-branch"> · {session.branch}</span>}
        </span>
        <button
          className="icon"
          title="Collapse all folders"
          onClick={() => root && setExpandedByRoot((m) => ({ ...m, [root]: [] }))}
        >
          ⊟
        </button>
        <button className="icon" title="Refresh" onClick={() => refresh(true)}>⟳</button>
      </div>
      <div className="fp-scroll">{renderTree("", 0)}</div>
    </>
  );
}

/**
 * The editor column beside the side bar: a tab per open file or diff over the
 * viewer. It slides open with the first tab and closed with the last; the
 * wrapper animates its width around a fixed-width editor, so the editor travels
 * instead of squashing. The handle on its right edge sizes it.
 */
export function EditorDock({
  editor,
  onActivate,
  onClose,
  onMode,
  onInsert,
}: {
  editor: EditorState;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onMode: (key: string, mode: "file" | "diff") => void;
  onInsert: (text: string) => void;
}) {
  const [width, setWidth] = useState<number>(() => loadLS("mb.files.viewerW", 560));
  useEffect(() => localStorage.setItem("mb.files.viewerW", JSON.stringify(width)), [width]);
  const [, setWindowW] = useState(window.innerWidth); // re-fit the editor when the window narrows
  useEffect(() => {
    const h = () => setWindowW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  const open = editor.tabs.find((t) => tabKey(t) === editor.active) ?? null;
  // the last tab shown stays rendered while the dock slides closed
  const [shown, setShown] = useState<OpenFile | null>(open);
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (open) {
      setShown(open);
      let r = requestAnimationFrame(() => (r = requestAnimationFrame(() => setEntered(true))));
      return () => cancelAnimationFrame(r);
    }
    setEntered(false);
    // a timer rather than transitionend — reduced-motion users get no transition event
    const t = setTimeout(() => setShown(null), SLIDE_MS);
    return () => clearTimeout(t);
  }, [open]);
  const tab = open ?? shown;
  if (!tab) return null;
  // the remembered width, but never so wide the terminals can't keep a usable column
  const w = Math.max(320, Math.min(width, window.innerWidth - 700));

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = w;
    const max = Math.max(320, window.innerWidth - 700);
    const move = (ev: PointerEvent) => setWidth(Math.min(max, Math.max(320, start + (ev.clientX - startX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("fp-resizing");
    };
    document.body.classList.add("fp-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="fp-slide" style={{ width: entered && open ? w + 1 : 0 }}>
      <div className="fp-editor" style={{ width: w }}>
        <div className="fp-tabbar" role="tablist">
          {(open ? editor.tabs : [tab]).map((t) => {
            const key = tabKey(t);
            return (
              <div
                key={key}
                role="tab"
                aria-selected={key === editor.active}
                className={`fp-tab ${key === editor.active ? "on" : ""} ${t.status ? `st-${t.status}` : ""}`}
                title={`${t.root.replace(/^\/Users\/[^/]+/, "~")}/${t.path}${t.source?.kind === "scm" ? (t.source.staged ? " (staged)" : " (working tree)") : ""}`}
                onClick={() => onActivate(key)}
                onAuxClick={(e) => e.button === 1 && onClose(key)}
              >
                <span className="fp-tab-name">
                  {baseName(t.path)}
                  {t.mode === "diff" && <span className="fp-tab-kind">{t.source?.kind === "scm" && t.source.staged ? " · staged" : " · diff"}</span>}
                </span>
                <button
                  className="fp-tab-x"
                  title="Close (middle-click works too)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(key);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <FileViewer
          key={tabKey(tab)}
          open={tab}
          onMode={(mode) => onMode(tabKey(tab), mode)}
          onClose={() => onClose(tabKey(tab))}
          onInsert={onInsert}
        />
      </div>
      <div className="fp-handle" onPointerDown={startResize} />
    </div>
  );
}

function FileViewer({
  open,
  onMode,
  onClose,
  onInsert,
}: {
  open: OpenFile;
  onMode: (m: "file" | "diff") => void;
  onClose: () => void;
  onInsert: (text: string) => void;
}) {
  const [file, setFile] = useState<Result<FileContent> | null>(null);
  const [diff, setDiff] = useState<Result<string> | null>(null);
  const [layout, setLayout] = useState<"inline" | "split">(() => loadLS("mb.files.diffLayout", "inline"));
  useEffect(() => localStorage.setItem("mb.files.diffLayout", JSON.stringify(layout)), [layout]);
  const deleted = open.status === "D";

  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    []
  );
  const load = async () => {
    if (open.mode === "diff") {
      const src = open.source;
      const r: Result<string> =
        src?.kind === "scm"
          ? await window.mb.scmDiff(open.sessionId, open.path, src.staged, src.untracked)
          : await window.mb.filesDiff(open.sessionId, open.path, src?.kind === "branch" ? "branch" : "working", open.status === "U");
      if (live.current) setDiff((d) => (JSON.stringify(d) === JSON.stringify(r) ? d : r));
    } else {
      const r: Result<FileContent> = await window.mb.filesRead(open.sessionId, open.path);
      if (live.current) setFile((f) => (JSON.stringify(f) === JSON.stringify(r) ? f : r));
    }
  };
  useEffect(() => {
    load();
  }, [open.sessionId, open.path, open.mode, open.status, open.source?.kind, open.source && "staged" in open.source ? open.source.staged : false]);
  // keep up with the session's edits; unchanged content keeps the same state
  // object, so a text selection survives the refresh
  useFolderRefresh(open.root, load);

  return (
    <div className="fp-viewer">
      <div className="fp-head">
        <span className="fp-title" title={`${open.root}/${open.path}`}>
          {baseName(open.path)}
          <span className="fp-dir">{dirName(open.path)}</span>
        </span>
        {open.mode === "diff" && (
          <span className="fp-seg" title="Show the diff in one column, or old and new side by side">
            <button className={layout === "inline" ? "on" : ""} onClick={() => setLayout("inline")}>Inline</button>
            <button className={layout === "split" ? "on" : ""} onClick={() => setLayout("split")}>Split</button>
          </span>
        )}
        {(open.source || open.status) && (
          <span className="fp-seg">
            <button className={open.mode === "diff" ? "on" : ""} onClick={() => onMode("diff")}>Diff</button>
            <button className={open.mode === "file" ? "on" : ""} disabled={deleted} onClick={() => onMode("file")}>File</button>
          </span>
        )}
        <button
          className="icon"
          title="Reference this file in the focused session (types @path into its prompt)"
          onClick={() => onInsert(`@${open.path} `)}
        >
          @
        </button>
        <button className="icon" title="Copy path" onClick={() => navigator.clipboard.writeText(open.path)}>⧉</button>
        <button className="icon" title="Close file" onClick={onClose}>✕</button>
      </div>
      <div className="fp-body">
        {open.mode === "diff" ? (
          diff === null ? <div className="fp-note">loading…</div>
          : isErr(diff) ? <div className="fp-note err">{diff.error}</div>
          : <DiffView text={diff} path={open.path} layout={layout} />
        ) : file === null ? <div className="fp-note">loading…</div>
          : isErr(file) ? <div className="fp-note err">{file.error}</div>
          : file.binary ? <div className="fp-note">Binary file · {file.size.toLocaleString()} bytes — not shown</div>
          : <CodeView file={file} path={open.path} reveal={open.reveal} />}
      </div>
    </div>
  );
}

function CodeView({ file, path, reveal }: { file: FileContent; path: string; reveal?: { line: number; at: number } }) {
  const text = file.content.endsWith("\n") ? file.content.slice(0, -1) : file.content;
  const gutter = useMemo(() => {
    const n = text.split("\n").length;
    let s = "";
    for (let i = 1; i <= n; i++) s += i + "\n";
    return s;
  }, [text]);
  const html = useMemo(() => highlightLines(text, languageFor(path)).join("\n"), [text, path]);
  const textRef = useRef<HTMLPreElement>(null);
  const [mark, setMark] = useState<{ top: number; height: number; at: number } | null>(null);

  // a search hit or ⌘P "file:line" scrolls its line a third of the way down and marks it
  useEffect(() => {
    const pre = textRef.current;
    if (!reveal || !pre) return;
    const cs = getComputedStyle(pre);
    const lh = parseFloat(cs.lineHeight);
    const top = parseFloat(cs.paddingTop) + (reveal.line - 1) * lh;
    const body = pre.closest(".fp-body");
    if (body) body.scrollTop = Math.max(0, top - body.clientHeight / 3);
    setMark({ top, height: lh, at: reveal.at });
  }, [reveal?.at]);

  return (
    <>
      {file.truncated && (
        <div className="fp-note">Large file — showing the first part of {file.size.toLocaleString()} bytes</div>
      )}
      <div className="fp-code">
        <pre className="fp-gutter">{gutter}</pre>
        {/* highlight.js escapes the file's text; the only markup is its own spans */}
        <pre ref={textRef} className="fp-text hl" dangerouslySetInnerHTML={{ __html: html }} />
        {mark && <div key={mark.at} className="fp-reveal" style={{ top: mark.top, height: mark.height }} />}
      </div>
    </>
  );
}

interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx" | "note";
  text: string;
  oldNo?: number;
  newNo?: number;
}

const MAX_DIFF_LINES = 20000;

export function parseDiff(text: string): { lines: DiffLine[]; binary: boolean; clipped: boolean } {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let binary = false;
  const raw = text.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  for (const l of raw) {
    if (lines.length >= MAX_DIFF_LINES) return { lines, binary, clipped: true };
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) {
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[2], 10);
      inHunk = true;
      lines.push({ kind: "hunk", text: l });
    } else if (!inHunk) {
      if (l.startsWith("Binary files")) binary = true;
    } else if (l.startsWith("+")) lines.push({ kind: "add", text: l.slice(1), newNo: newNo++ });
    else if (l.startsWith("-")) lines.push({ kind: "del", text: l.slice(1), oldNo: oldNo++ });
    else if (l.startsWith("\\")) lines.push({ kind: "note", text: l.slice(2) });
    else lines.push({ kind: "ctx", text: l.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return { lines, binary, clipped: false };
}

/**
 * Each side of a hunk highlighted as one text, so a comment or string spanning
 * lines keeps its color: the old side is context + removed lines, the new side
 * context + added lines, in order. Hunks are highlighted apart — the lines
 * between them aren't shown, so state must not carry across. Returns each diff
 * line's HTML.
 */
export function highlightDiff(lines: DiffLine[], path: string): string[] {
  const lang = languageFor(path);
  const out: string[] = new Array(lines.length);
  const escape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === "hunk" || lines[i].kind === "note") {
      out[i] = escape(lines[i].text);
      i++;
      continue;
    }
    const at: number[] = [];
    for (; i < lines.length && lines[i].kind !== "hunk"; i++) if (lines[i].kind !== "note") at.push(i);
    const oldHtml = highlightLines(at.filter((j) => lines[j].kind !== "add").map((j) => lines[j].text).join("\n"), lang);
    const newHtml = highlightLines(at.filter((j) => lines[j].kind !== "del").map((j) => lines[j].text).join("\n"), lang);
    let o = 0;
    let n = 0;
    for (const j of at) {
      const k = lines[j].kind;
      if (k === "del") out[j] = oldHtml[o++];
      else if (k === "add") out[j] = newHtml[n++];
      else (o++, (out[j] = newHtml[n++]));
    }
  }
  for (let j = 0; j < lines.length; j++) if (lines[j].kind === "note") out[j] = escape(lines[j].text);
  return out;
}

/** Diff lines as side-by-side rows: context on both sides, a run of removals paired with the additions after it. */
export function splitRows(lines: DiffLine[]): ({ hunk: number } | { left: number | null; right: number | null })[] {
  const rows: ({ hunk: number } | { left: number | null; right: number | null })[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === "hunk" || l.kind === "note") {
      rows.push({ hunk: i++ });
    } else if (l.kind === "ctx") {
      rows.push({ left: i, right: i });
      i++;
    } else {
      const dels: number[] = [];
      const adds: number[] = [];
      while (i < lines.length && lines[i].kind === "del") dels.push(i++);
      while (i < lines.length && lines[i].kind === "add") adds.push(i++);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

function DiffView({ text, path, layout }: { text: string; path: string; layout: "inline" | "split" }) {
  const { lines, binary, clipped } = useMemo(() => parseDiff(text), [text]);
  const html = useMemo(() => highlightDiff(lines, path), [lines, path]);
  if (binary) return <div className="fp-note">Binary file changed — no text diff</div>;
  if (lines.length === 0) return <div className="fp-note">No content differences</div>;
  const adds = lines.filter((l) => l.kind === "add").length;
  const dels = lines.filter((l) => l.kind === "del").length;
  const cell = (i: number | null, side: "old" | "new") =>
    i === null ? (
      <div className="dl empty">
        <span className="no" />
        <span className="tx" />
      </div>
    ) : (
      <div className={`dl ${lines[i].kind}`}>
        <span className="no">{side === "old" ? lines[i].oldNo ?? "" : lines[i].newNo ?? ""}</span>
        <span className="tx hl" dangerouslySetInnerHTML={{ __html: html[i] }} />
      </div>
    );
  return (
    <>
      <div className="fp-note">
        <span className="fp-plus">+{adds}</span> <span className="fp-minus">−{dels}</span>
        {clipped && ` · showing the first ${MAX_DIFF_LINES.toLocaleString()} lines`}
      </div>
      {layout === "split" ? (
        <div className="fp-diff split">
          {splitRows(lines).map((r, k) =>
            "hunk" in r ? (
              <div key={k} className={`dl ${lines[r.hunk].kind} full`}>
                <span className="tx">{lines[r.hunk].text}</span>
              </div>
            ) : (
              <div key={k} className="srow">
                {cell(r.left, "old")}
                {cell(r.right, "new")}
              </div>
            )
          )}
        </div>
      ) : (
        <div className="fp-diff">
          {lines.map((l, i) => (
            <div key={i} className={`dl ${l.kind}`}>
              <span className="no">{l.oldNo ?? ""}</span>
              <span className="no">{l.newNo ?? ""}</span>
              <span className="mk">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
              {l.kind === "hunk" || l.kind === "note" ? <span className="tx">{l.text}</span> : <span className="tx hl" dangerouslySetInnerHTML={{ __html: html[i] }} />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
