import React, { useEffect, useMemo, useRef, useState } from "react";
import type { FileHit, FileSearch, FileSearchOptions, SessionInfo, TranscriptHit } from "../shared/types";
import { ConversationRow, useTranscriptSearch } from "./TranscriptSearch";

export interface SearchState extends FileSearchOptions {
  scope: "conversations" | "files";
  q: string;
}

type Result<T> = T | { error: string };
const isErr = (r: unknown): r is { error: string } => !!r && typeof r === "object" && "error" in (r as object);
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** Where the query matches in a line, as [start, end) ranges — what the result list marks. */
export function matchRanges(text: string, q: string, opts: FileSearchOptions): [number, number][] {
  if (!q) return [];
  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(q, opts.matchCase ? "g" : "gi");
    } catch {
      return []; // git's regex dialect differs from JavaScript's; the line shows unmarked
    }
    const out: [number, number][] = [];
    for (let m = re.exec(text); m && out.length < 50; m = re.exec(text)) {
      if (m[0] === "") {
        re.lastIndex++;
        continue;
      }
      out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }
  const hay = opts.matchCase ? text : text.toLowerCase();
  const needle = opts.matchCase ? q : q.toLowerCase();
  const out: [number, number][] = [];
  for (let i = hay.indexOf(needle); i >= 0 && out.length < 50; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
  return out;
}

/** A result line cut so its first match shows in a narrow side bar: at most `lead` characters before it. */
export function aroundMatch(text: string, ranges: [number, number][], lead = 18): { text: string; ranges: [number, number][] } {
  const first = ranges[0]?.[0] ?? 0;
  if (first <= lead + 4) return { text, ranges };
  const cut = first - lead;
  return { text: "…" + text.slice(cut), ranges: ranges.map(([a, b]) => [a - cut + 1, b - cut + 1]) };
}

function Marked({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * The Search view (⌘⇧F), VS Code-style, over two scopes: every Claude and Codex
 * conversation on this Mac, or the text of every file in the focused session's
 * folder. ↑↓ choose a result, ↵ opens it.
 */
export function SearchView({
  session,
  state,
  onState,
  focusKey,
  onOpenConversation,
  onOpenFile,
}: {
  session: SessionInfo | null;
  state: SearchState;
  onState: (s: SearchState) => void;
  /** Changes each time ⌘⇧F is pressed, to focus and select the query. */
  focusKey: number;
  onOpenConversation: (hit: TranscriptHit) => Promise<string | null>;
  onOpenFile: (path: string, line: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const set = (patch: Partial<SearchState>) => onState({ ...state, ...patch });
  const files = state.scope === "files";

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusKey]);

  // conversations: the transcript index (it searches nothing while the scope is files)
  const conv = useTranscriptSearch(files ? "" : state.q);

  // files: the focused session's folder
  const [fileRes, setFileRes] = useState<Result<FileSearch> | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const sid = session?.id ?? null;
  useEffect(() => {
    const n = ++seq.current;
    if (!files || !sid || !state.q) {
      setFileRes(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      const r: Result<FileSearch> = await window.mb.filesSearch(sid, state.q, { regex: state.regex, matchCase: state.matchCase });
      if (n !== seq.current) return;
      setFileRes(r);
      setSearching(false);
      setCollapsed(new Set());
    }, 250);
    return () => clearTimeout(t);
  }, [files, sid, state.q, state.regex, state.matchCase]);

  const fileHits = fileRes && !isErr(fileRes) ? fileRes.hits : [];
  const groups = useMemo(() => {
    const m = new Map<string, FileHit[]>();
    for (const h of fileHits) (m.get(h.path) ?? m.set(h.path, []).get(h.path)!).push(h);
    return [...m.entries()];
  }, [fileHits]);
  // the rows ↑↓ walk: conversation hits, or the file lines that are showing
  const flat: (TranscriptHit | FileHit)[] = files ? groups.flatMap(([p, hs]) => (collapsed.has(p) ? [] : hs)) : conv.hits;
  const indexOf = useMemo(() => new Map(flat.map((h, i) => [h, i])), [flat]);

  useEffect(() => setSel(0), [state.q, state.scope, fileRes, conv.hits]);
  useEffect(() => {
    listRef.current?.querySelector(".sv-hit.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const openConv = async (h: TranscriptHit) => {
    if (busy) return;
    setBusy(true);
    conv.setError("");
    const err = await onOpenConversation(h);
    setBusy(false);
    if (err) conv.setError(err);
  };
  const openAt = (i: number) => {
    const h = flat[i];
    if (!h) return;
    if ("line" in h) onOpenFile(h.path, h.line);
    else openConv(h);
  };

  return (
    <div className="sv">
      <div className="sv-scope" role="tablist">
        <button role="tab" aria-selected={!files} className={!files ? "on" : ""} onClick={() => set({ scope: "conversations" })}>
          Conversations
        </button>
        <button role="tab" aria-selected={files} className={files ? "on" : ""} onClick={() => set({ scope: "files" })}>
          Files
        </button>
      </div>
      <div className="sv-input">
        <input
          ref={inputRef}
          placeholder={files ? `Search ${session ? baseName(session.cwd) : "files"}` : "Search every conversation"}
          value={state.q}
          onChange={(e) => set({ q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(flat.length - 1, s + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            }
            if (e.key === "Enter") openAt(sel);
            if (e.key === "Escape" && state.q) set({ q: "" });
          }}
        />
        {files && (
          <>
            <button className={`sv-opt ${state.matchCase ? "on" : ""}`} title="Match case" aria-pressed={state.matchCase} onClick={() => set({ matchCase: !state.matchCase })}>
              Aa
            </button>
            <button className={`sv-opt ${state.regex ? "on" : ""}`} title="Regular expression" aria-pressed={state.regex} onClick={() => set({ regex: !state.regex })}>
              .*
            </button>
          </>
        )}
      </div>

      <div className="sv-results" ref={listRef}>
        {files ? (
          !session ? (
            <div className="fp-note">Click into a session to search its folder.</div>
          ) : !state.q ? (
            <div className="sv-hint">Searches the text of every file in {baseName(session.cwd)} — in a repository, what git tracks plus new files it doesn't ignore.</div>
          ) : isErr(fileRes) ? (
            <div className="fp-note err">{fileRes.error}</div>
          ) : !fileRes ? (
            <div className="fp-note">searching…</div>
          ) : (
            <>
              <div className="sv-summary">
                {fileRes.hits.length === 0
                  ? "No results"
                  : `${fileRes.hits.length.toLocaleString()} result${fileRes.hits.length === 1 ? "" : "s"} in ${fileRes.files} file${fileRes.files === 1 ? "" : "s"}`}
                {searching && " · searching…"}
              </div>
              {fileRes.stopped && (
                <div className="fp-note warn">
                  {fileRes.stopped === "limit" ? "Stopped at 2,000 matches — narrow the search to see the rest." : "Stopped after 20 seconds — narrow the search to see the rest."}
                </div>
              )}
              {fileRes.warning && <div className="fp-note warn">{fileRes.warning}</div>}
              {groups.map(([p, hs]) => (
                <React.Fragment key={p}>
                  <div
                    className="sv-file"
                    title={p}
                    onClick={() =>
                      setCollapsed((c) => {
                        const n = new Set(c);
                        n.has(p) ? n.delete(p) : n.add(p);
                        return n;
                      })
                    }
                  >
                    <span className="sc-chev">{collapsed.has(p) ? "▸" : "▾"}</span>
                    <span className="fp-name">
                      {baseName(p)}
                      <span className="fp-dir">{dirName(p)}</span>
                    </span>
                    <span className="fp-count">{hs.length}</span>
                  </div>
                  {!collapsed.has(p) &&
                    hs.map((h) => {
                      const i = indexOf.get(h) ?? -1;
                      return (
                        <div
                          key={`${p}:${h.line}`}
                          className={`sv-hit sv-line ${i === sel ? "sel" : ""}`}
                          title={`${p}:${h.line}`}
                          onMouseEnter={() => setSel(i)}
                          onClick={() => onOpenFile(h.path, h.line)}
                        >
                          <span className="sv-ln">{h.line}</span>
                          <span className="sv-tx">
                            <Marked {...aroundMatch(h.text.trim(), matchRanges(h.text.trim(), state.q, state))} />
                          </span>
                        </div>
                      );
                    })}
                </React.Fragment>
              ))}
            </>
          )
        ) : (
          <>
            {conv.error && <div className="fp-note err">{conv.error}</div>}
            {!state.q.trim() && !conv.error && (
              <div className="sv-hint">
                Finds any Claude or Codex conversation on this Mac — open, closed, or never opened in Mockingbird — by what was said, the files it touched, or
                the commands it ran.
              </div>
            )}
            {state.q.trim() && !conv.hits.length && !conv.error && (
              <div className="sv-hint">No conversation mentions that{conv.status?.indexing ? " yet — still indexing" : ""}.</div>
            )}
            {conv.hits.map((h, i) => (
              <ConversationRow key={h.id} hit={h} selected={i === sel} onHover={() => setSel(i)} onOpen={() => openConv(h)} />
            ))}
          </>
        )}
      </div>
      {!files && (
        <div className="sv-foot">
          {conv.status
            ? conv.status.indexing
              ? `indexing ${conv.status.indexing.done}/${conv.status.indexing.total} transcripts…`
              : `${conv.status.conversations.toLocaleString()} conversations indexed`
            : "opening the index…"}
        </div>
      )}
    </div>
  );
}
