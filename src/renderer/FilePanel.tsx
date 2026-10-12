import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isErr, type SessionInfo, type FileEntry, type FileContent, type GitChange, type GitChanges, type LspLocation, type WorktreeStateInfo, type IpcResult } from "../shared/types";
import { escapeHtml, highlightLines, languageFor } from "./highlight";
import { fileKey, filesClosing, tabKey, type EditorState, type OpenFile } from "./editorTabs";
import { useFolderRefresh } from "./folderWatch";
import { fileBadge } from "./fileIcons";
import { useBreakpoints, useDebug } from "./debugStore";
import { CodeEditor, confirmClose, releaseBuffers, useDirtyKeys } from "./CodeEditor";
import { ChevronIcon, FileIcon, FolderIcon, SearchIcon } from "./Icons";
import { CopyToast, useCopyNote } from "./copyNote";
import { ChangeCount } from "./changeCount";
import { settled } from "./settled";
import { plural } from "../shared/format";
import { baseName, dirName, tildePath } from "../shared/paths";
import { usePersisted } from "./prefs";

const STATUS_TITLE: Record<GitChange["status"], string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  U: "Untracked",
};

/** A path with the home folder shown as ~. */

const SLIDE_MS = 200;

/** A file's type badge, or a plain file icon for types without one. */
export function FileGlyph({ path }: { path: string }) {
  const b = fileBadge(path);
  if (!b) return <span className="fp-glyph plain"><FileIcon /></span>;
  return (
    <span className="fp-glyph" style={{ "--c": b.color } as React.CSSProperties}>
      {b.label}
    </span>
  );
}

/**
 * The Explorer view for the focused session's folder: a summary of what changed
 * since the last commit, the open editors, and the file tree — type badges,
 * indent guides, changed files and the folders holding them marked. A click
 * opens a file in its own tab. Only mounted while the view shows, so a hidden
 * explorer reads nothing.
 */
export function ExplorerTree(props: ExplorerProps) {
  // a different folder is a different tree: nothing the last one asked for may land in it
  return <FolderTree key={props.session?.cwd ?? ""} {...props} />;
}

interface ExplorerProps {
  session: SessionInfo | null;
  /** The active editor tab's file, if it's in this folder: highlighted in the tree. */
  activePath: string | null;
  editor: EditorState;
  onOpen: (path: string, status: GitChange["status"] | undefined) => void;
  onActivate: (key: string) => void;
  onCloseTab: (key: string) => void;
  onCloseAll: () => void;
  onQuickOpen: () => void;
}

function FolderTree({ session, activePath, editor, onOpen, onActivate, onCloseTab, onCloseAll, onQuickOpen }: ExplorerProps) {
  // expanded folders are remembered per folder-on-disk, so flipping between
  // sessions restores each tree the way it was left
  const [expandedByRoot, setExpandedByRoot] = usePersisted<Record<string, string[]>>("mb.files.expanded", {});
  const [shut, setShut] = usePersisted<string[]>("mb.files.shutSections", []);
  const toggleSection = (k: string) => setShut((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const [dirs, setDirs] = useState<Record<string, IpcResult<FileEntry[]>>>({});
  const [changes, setChanges] = useState<IpcResult<GitChanges> | null>(null);
  const [gitState, setGit] = useState<IpcResult<WorktreeStateInfo> | null>(null);

  const sid = session?.id ?? null;
  const root = session?.cwd ?? null;
  const expanded = useMemo(() => new Set(root ? expandedByRoot[root] ?? [] : []), [expandedByRoot, root]);

  const loadDir = useCallback(async (id: string, rel: string) => {
    const r = await settled<IpcResult<FileEntry[]>>(window.mb.filesList(id, rel), "Couldn't read it");
    setDirs((d) => (JSON.stringify(d[rel]) === JSON.stringify(r) ? d : { ...d, [rel]: r }));
  }, []);

  // the tree marks what changed since the last commit
  const loadChanges = useCallback(async (id: string) => {
    const r = await settled<IpcResult<GitChanges>>(window.mb.filesChanges(id, "working"), "Couldn't read it");
    setChanges((c) => (JSON.stringify(c) === JSON.stringify(r) ? c : r));
    return r;
  }, []);

  // A failing change list (not a git repo) isn't asked again on every change —
  // the tree still refreshes; the refresh button retries the change list.
  const gitBroken = useRef(false);
  const refresh = useCallback(
    (retryGit = false) => {
      if (!sid || !root) return;
      loadDir(sid, "");
      for (const rel of expanded) loadDir(sid, rel);
      if (gitBroken.current && !retryGit) return;
      loadChanges(sid).then((r) => (gitBroken.current = isErr(r)));
      settled<IpcResult<WorktreeStateInfo>>(window.mb.worktreeState(root), "Couldn't read git").then((r) => setGit(r ?? { error: "no answer" }));
    },
    [sid, root, expanded, loadDir, loadChanges]
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

  const guides = (depth: number) => Array.from({ length: depth }, (_, i) => <span key={i} className="fp-guide" />);

  const renderTree = (rel: string, depth: number): React.ReactNode => {
    const list = dirs[rel];
    if (!list) return <div className="fp-note" style={{ paddingLeft: 12 + depth * 12 }}>loading…</div>;
    if (isErr(list)) return <div className="fp-note err" style={{ paddingLeft: 12 + depth * 12 }}>{list.error}</div>;
    if (list.length === 0 && depth === 0) return <div className="fp-note">empty folder</div>;
    return list.map((e) => {
      const ch = changeByPath.get(e.path);
      const cls = ch ? `st-${ch.status}` : e.dir && dirtyDirs.has(e.path) ? "st-dir" : "";
      const open = e.dir && expanded.has(e.path);
      return (
        <React.Fragment key={e.path}>
          <div
            className={`fp-row ${cls} ${activePath === e.path ? "active" : ""}`}
            title={e.path}
            onClick={() => (e.dir ? toggleDir(e.path) : onOpen(e.path, ch?.status))}
          >
            {guides(depth)}
            {e.dir ? (
              <span className={`fp-folder ${open ? "open" : ""}`}>
                <FolderIcon open={open} />
              </span>
            ) : (
              <FileGlyph path={e.path} />
            )}
            <span className="fp-name">{e.name}</span>
            {ch && <span className="fp-badge" title={STATUS_TITLE[ch.status]}>{ch.status}</span>}
            {!ch && cls === "st-dir" && <span className="fp-badge" title="Has changed files">●</span>}
          </div>
          {open && renderTree(e.path, depth + 1)}
        </React.Fragment>
      );
    });
  };

  if (!session) return <div className="fp-note">Click into a session to browse its folder.</div>;
  // outside a repository both git reads fail, and there's nothing to say about git
  const inRepo = !!session.repoPath || (!!changes && !isErr(changes));
  const changesErr = inRepo && isErr(changes) ? changes.error : null;
  const gitErr = inRepo && isErr(gitState) ? gitState.error : null;
  const git = gitState && !isErr(gitState) ? gitState : null;
  const total = git ? git.insertions + git.deletions : 0;
  return (
    <>
      <div className="ex-head">
        <div className="ex-title">
          <span className="ex-name" title={root!}>{baseName(root!)}</span>
          <span className="ex-acts">
            <button className="icon" title="Go to file (⌘P)" onClick={onQuickOpen}>
              <SearchIcon />
            </button>
            <button className="icon" title="Collapse all folders" onClick={() => root && setExpandedByRoot((m) => ({ ...m, [root]: [] }))}>
              ⊟
            </button>
            <button className="icon" title="Refresh" onClick={() => refresh(true)}>⟳</button>
          </span>
        </div>
        {gitErr && (
          <div className="ex-branch err" title={gitErr}>
            git: couldn't read ({gitErr})
          </div>
        )}
        {changesErr && (
          <div className="ex-branch err" title={`${changesErr}\nRefresh (⟳) asks again.`}>
            changed files: couldn't list ({changesErr})
          </div>
        )}
        {git && (
          <div className="ex-branch" title={`${plural(git.ahead, "commit")} to push, ${git.behind} to pull`}>
            {git.branch} · ↑{git.ahead} ↓{git.behind}
          </div>
        )}
        {git &&
          (git.dirty ? (
            <>
              {total > 0 && (
                <div className="ex-bar" title={`+${git.insertions} −${git.deletions} lines in tracked files`}>
                  <span className="add" style={{ width: `${(git.insertions / total) * 100}%` }} />
                  <span className="del" style={{ width: `${(git.deletions / total) * 100}%` }} />
                </div>
              )}
              <div className="ex-sum">
                <ChangeCount files={git.dirtyFiles} insertions={git.insertions} deletions={git.deletions} /> since the last commit
              </div>
            </>
          ) : (
            <div className="ex-sum">No changes since the last commit</div>
          ))}
      </div>
      <div className="fp-scroll">
        {editor.tabs.length > 0 && (
          <>
            <div className="ex-sec" onClick={() => toggleSection("open")}>
              <ChevronIcon open={!shut.includes("open")} />
              Open editors <span className="fp-count">{editor.tabs.length}</span>
              <button
                className="icon ex-closeall"
                data-tip="Close all files (asks about unsaved ones)"
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (askToClose(editor.tabs, editor.tabs.map(tabKey))) onCloseAll();
                }}
              >
                ✕ All
              </button>
            </div>
            {!shut.includes("open") &&
              editor.tabs.map((t) => {
                const key = tabKey(t);
                const elsewhere = t.root !== root;
                return (
                  <div
                    key={key}
                    className={`fp-row ex-open ${t.status ? `st-${t.status}` : ""} ${key === editor.active ? "active" : ""}`}
                    title={`${tildePath(t.root)}/${t.path}`}
                    onClick={() => onActivate(key)}
                  >
                    <FileGlyph path={t.path} />
                    <span className="fp-name">
                      {baseName(t.path)}
                      {t.mode === "diff" && <span className="fp-dir">{t.source?.kind === "scm" && t.source.staged ? "staged" : "diff"}</span>}
                      <span className="fp-dir">{elsewhere ? baseName(t.root) : dirName(t.path)}</span>
                    </span>
                    <button
                      className="icon ex-x"
                      data-tip="Close"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (askToClose(editor.tabs, [key])) onCloseTab(key);
                      }}
                    >
                      ×
                    </button>
                    {t.status && <span className="fp-badge">{t.status}</span>}
                  </div>
                );
              })}
          </>
        )}
        <div className="ex-sec" onClick={() => toggleSection("files")}>
          <ChevronIcon open={!shut.includes("files")} />
          Files
        </div>
        {!shut.includes("files") && renderTree("", 0)}
      </div>
    </>
  );
}

/**
 * Before closing tabs (keys of `tabs`), ask about unsaved edits in the files
 * they're the last tabs of, then let go of those files' buffers. True when the
 * tabs may close.
 */
export function askToClose(tabs: OpenFile[], closing: readonly string[]): boolean {
  return confirmClose(filesClosing(tabs, closing).map((f) => ({ key: fileKey(f), name: baseName(f.path) })));
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
  onClose: closeTab,
  onCloseAll,
  onMode,
  onInsert,
  onOpenLocation,
}: {
  editor: EditorState;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onCloseAll: () => void;
  onMode: (key: string, mode: "file" | "diff") => void;
  onInsert: (text: string) => void;
  /** Open a definition (an absolute path) in the editor; returns why it couldn't. */
  onOpenLocation: (loc: LspLocation, fromSession: string) => string | null;
}) {
  const dirty = useDirtyKeys();
  const onClose = (key: string) => {
    if (askToClose(editor.tabs, [key])) closeTab(key);
  };
  const closeAll = () => {
    if (askToClose(editor.tabs, editor.tabs.map(tabKey))) onCloseAll();
  };
  // a file no tab shows any more (its tab closed to make room for a new one) lets go of its buffer
  useEffect(() => releaseBuffers(new Set(editor.tabs.map(fileKey))), [editor.tabs]);
  const [width, setWidth] = usePersisted<number>("mb.files.viewerW", 560);
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
                className={`fp-tab ${key === editor.active ? "on" : ""} ${t.status ? `st-${t.status}` : ""} ${dirty.has(fileKey(t)) ? "dirty" : ""}`}
                title={`${tildePath(t.root)}/${t.path}${t.source?.kind === "scm" ? (t.source.staged ? " (staged)" : " (working tree)") : t.source?.kind === "commit" ? ` (commit ${t.source.sha.slice(0, 8)})` : ""}`}
                onClick={() => onActivate(key)}
                onAuxClick={(e) => e.button === 1 && onClose(key)}
              >
                <span className="fp-tab-name">
                  {baseName(t.path)}
                  {t.mode === "diff" && (
                    <span className="fp-tab-kind">
                      {t.source?.kind === "scm" && t.source.staged ? " · staged" : t.source?.kind === "commit" ? ` · ${t.source.sha.slice(0, 7)}` : " · diff"}
                    </span>
                  )}
                </span>
                <button
                  className="fp-tab-x"
                  data-tip={dirty.has(fileKey(t)) ? "Unsaved changes — close (asks first)" : "Close (middle-click works too)"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(key);
                  }}
                >
                  <span className="fp-tab-dot">●</span>
                  <span className="fp-tab-cross">×</span>
                </button>
              </div>
            );
          })}
          <span className="fp-tabbar-fill" />
          {editor.tabs.length > 1 && (
            <button className="icon fp-closeall" data-tip="Close all files (asks about unsaved ones)" onClick={closeAll}>
              ✕ All
            </button>
          )}
        </div>
        <FileViewer
          key={tabKey(tab)}
          open={tab}
          onMode={(mode) => onMode(tabKey(tab), mode)}
          onClose={() => onClose(tabKey(tab))}
          onInsert={onInsert}
          onOpenLocation={onOpenLocation}
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
  onOpenLocation,
}: {
  open: OpenFile;
  onMode: (m: "file" | "diff") => void;
  onClose: () => void;
  onInsert: (text: string) => void;
  onOpenLocation: (loc: LspLocation, fromSession: string) => string | null;
}) {
  const [file, setFile] = useState<IpcResult<FileContent> | null>(null);
  const [diff, setDiff] = useState<IpcResult<string> | null>(null);
  const bp = useBreakpoints(open.sessionId);
  const debug = useDebug();
  const dirty = useDirtyKeys().has(fileKey(open));
  const abs = `${open.root}/${open.path}`;
  const pausedLines = Object.entries(debug.selected)
    .map(([sid, f]) => (f && f.path === abs && debug.sessions.find((x) => x.id === sid)?.state === "stopped" ? f.line : null))
    .filter((l): l is number => l !== null);
  const saveRef = useRef<(() => void) | null>(null);
  const [copyNote, copy] = useCopyNote();
  const [layout, setLayout] = usePersisted<"inline" | "split">("mb.files.diffLayout", "inline");
  const deleted = open.status === "D";

  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    []
  );
  // folder changes can start reads faster than they finish: only the latest one's answer is shown
  const loads = useRef(0);
  const load = async () => {
    const n = ++loads.current;
    const latest = () => live.current && n === loads.current;
    if (open.mode === "diff") {
      const src = open.source;
      const r = await settled<IpcResult<string>>(
        src?.kind === "scm"
          ? window.mb.scmDiff(open.sessionId, open.path, src.staged, src.untracked)
          : src?.kind === "commit"
            ? window.mb.scmCommitDiff(open.sessionId, src.sha, open.path)
            : window.mb.filesDiff(open.sessionId, open.path, src?.kind === "branch" ? "branch" : "working", open.status === "U"),
        "Couldn't read it"
      );
      if (latest()) setDiff((d) => (JSON.stringify(d) === JSON.stringify(r) ? d : r));
    } else {
      const r = await settled<IpcResult<FileContent>>(window.mb.filesRead(open.sessionId, open.path), "Couldn't read it");
      if (latest()) setFile((f) => (JSON.stringify(f) === JSON.stringify(r) ? f : r));
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
          <span className="fp-seg" data-tip="Show the diff in one column, or old and new side by side">
            <button className={layout === "inline" ? "on" : ""} onClick={() => setLayout("inline")}>Inline</button>
            <button className={layout === "split" ? "on" : ""} onClick={() => setLayout("split")}>Split</button>
          </span>
        )}
        {(open.source || open.status) && (
          <span className="fp-seg" data-tip="What changed, or the whole file (editable)">
            <button className={open.mode === "diff" ? "on" : ""} onClick={() => onMode("diff")}>Diff</button>
            <button className={open.mode === "file" ? "on" : ""} disabled={deleted} onClick={() => onMode("file")}>File</button>
          </span>
        )}
        {dirty && open.mode === "file" && (
          <button className="outline fp-save" data-tip="Save (⌘S)" onClick={() => saveRef.current?.()}>
            Save
          </button>
        )}
        <button className="icon" data-tip={`Mention in chat — types @${open.path} into the focused session's prompt, so the agent reads this file`} onClick={() => onInsert(`@${open.path} `)}>
          @
        </button>
        <button className="icon" data-tip={`Copy this file's path (${open.path})`} onClick={() => copy(open.path, "a file path")}>
          ⧉
        </button>
        <button className="icon" data-tip="Close this file" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="fp-body">
        {open.mode === "diff" ? (
          diff === null ? <div className="fp-note">loading…</div>
          : isErr(diff) ? <div className="fp-note err">{diff.error}</div>
          : <DiffView text={diff} path={open.path} layout={layout} />
        ) : file === null ? <div className="fp-note">loading…</div>
          : isErr(file) ? <div className="fp-note err">{file.error}</div>
          : file.binary ? <div className="fp-note">Binary file · {file.size.toLocaleString()} bytes — not shown</div>
          : (
            <CodeEditor
              bufferKey={fileKey(open)}
              file={file}
              path={open.path}
              onSave={(text, expected) => window.mb.filesWrite(open.sessionId, open.path, text, expected)}
              onRefresh={load}
              saveRef={saveRef}
              breakpoints={bp.map[open.path] ?? []}
              onToggleBreakpoint={(line) => bp.toggle(open.path, line)}
              pausedLines={pausedLines}
              reveal={open.reveal}
              lsp={{ sessionId: open.sessionId, root: open.root }}
              onOpenLocation={(loc) => onOpenLocation(loc, open.sessionId)}
            />
          )}
      </div>
      <CopyToast note={copyNote} failed="Couldn't copy the path" />
    </div>
  );
}

interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx" | "note";
  text: string;
  oldNo?: number;
  newNo?: number;
}

const MAX_DIFF_LINES = 20000;

/**
 * A unified diff as lines. A merge conflict's working-tree diff is a combined
 * one (`@@@ -a -b +c @@@`, a prefix column per parent); it's shown against the
 * first parent — the branch being merged into — like `git diff HEAD`, so lines
 * only the other side had are left out. `unmerged`: a staged diff of a file
 * with conflicts, which git doesn't produce.
 */
export function parseDiff(text: string): { lines: DiffLine[]; binary: boolean; clipped: boolean; unmerged: boolean } {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let parents = 0; // prefix columns; 0 outside a hunk
  let binary = false;
  let unmerged = false;
  const raw = text.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  for (const l of raw) {
    if (lines.length >= MAX_DIFF_LINES) return { lines, binary, clipped: true, unmerged };
    const m = /^(@@+) -(\d+)(?:,\d+)? (?:-\d+(?:,\d+)? )*\+(\d+)(?:,\d+)? \1/.exec(l);
    if (m) {
      parents = m[1].length - 1;
      oldNo = parseInt(m[2], 10);
      newNo = parseInt(m[3], 10);
      lines.push({ kind: "hunk", text: l });
      continue;
    }
    if (!parents) {
      if (l.startsWith("Binary files")) binary = true;
      if (l.startsWith("* Unmerged path")) unmerged = true;
      continue;
    }
    if (l.startsWith("\\")) {
      lines.push({ kind: "note", text: l.slice(2) });
      continue;
    }
    const mark = l.slice(0, parents);
    const body = l.slice(parents);
    if (mark[0] === "+") lines.push({ kind: "add", text: body, newNo: newNo++ });
    else if (mark[0] === "-") lines.push({ kind: "del", text: body, oldNo: oldNo++ });
    else if (!mark.includes("-")) lines.push({ kind: "ctx", text: body, oldNo: oldNo++, newNo: newNo++ });
  }
  return { lines, binary, clipped: false, unmerged };
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
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === "hunk" || lines[i].kind === "note") {
      out[i] = escapeHtml(lines[i].text);
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
  for (let j = 0; j < lines.length; j++) if (lines[j].kind === "note") out[j] = escapeHtml(lines[j].text);
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
  const { lines, binary, clipped, unmerged } = useMemo(() => parseDiff(text), [text]);
  const html = useMemo(() => highlightDiff(lines, path), [lines, path]);
  if (binary) return <div className="fp-note">Binary file changed — no text diff</div>;
  if (unmerged && lines.length === 0) return <div className="fp-note warn">This file has merge conflicts, so nothing of it is staged yet — open its working-tree changes or the file to resolve them</div>;
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
