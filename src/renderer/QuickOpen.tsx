import React, { useEffect, useMemo, useRef, useState } from "react";
import { isErr, type FileList, type SessionInfo, type IpcResult } from "../shared/types";
import { fuzzyFilter } from "./fuzzy";
import { useListNav } from "./listNav";
import { plural } from "../shared/format";
import { baseName } from "../shared/paths";


/** "src/app.ts:42" → the path and the line; a bare path has no line. */
export function parseGoTo(q: string): { query: string; line: number | null } {
  const m = /^(.*?):(\d+)$/.exec(q.trim());
  return m ? { query: m[1], line: parseInt(m[2], 10) } : { query: q.trim(), line: null };
}

function Highlighted({ text, positions, offset }: { text: string; positions: number[]; offset: number }) {
  const set = new Set(positions.map((p) => p - offset));
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : <React.Fragment key={i}>{ch}</React.Fragment>))}
    </>
  );
}

/**
 * ⌘P: open any file in the focused session's folder by typing part of its
 * name — letters in order, as VS Code matches them. "name:42" opens at line 42.
 */
export function QuickOpen({
  session,
  onClose,
  onOpen,
}: {
  session: SessionInfo | null;
  onClose: () => void;
  onOpen: (path: string, line: number | null) => void;
}) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<IpcResult<FileList> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session) return;
    let live = true;
    window.mb.filesAll(session.id).then(
      (r: IpcResult<FileList>) => live && setList(r),
      (err: unknown) => live && setList({ error: `Couldn't list the files: ${err instanceof Error ? err.message : err}` })
    );
    return () => {
      live = false;
    };
  }, [session?.id]);

  const { query, line } = parseGoTo(q);
  const matches = useMemo(() => (list && !isErr(list) ? fuzzyFilter(query, list.files) : []), [list, query]);
  const { sel, setSel, onArrow } = useListNav(matches.length, [query]);
  useEffect(() => {
    listRef.current?.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const open = (i: number) => {
    const m = matches[i];
    if (!m) return;
    onOpen(m.path, line);
    onClose();
  };

  return (
    <>
      <div className="scrim" onMouseDown={onClose} />
      <div className="palette qo">
        <div className="inrow">
          <span className="prompt">⌘P</span>
          <input
            autoFocus
            placeholder={session ? `Go to a file in ${baseName(session.cwd)} — name:line jumps to a line` : "Focus a session first"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (onArrow(e)) return;
              if (e.key === "Enter") open(sel);
            }}
          />
        </div>
        <div className="results" ref={listRef}>
          {!session ? (
            <div className="ts-hint">Click into a session — ⌘P opens files from its folder.</div>
          ) : list === null ? (
            <div className="ts-hint">listing files…</div>
          ) : isErr(list) ? (
            <div className="err" style={{ margin: "6px 14px" }}>{list.error}</div>
          ) : matches.length === 0 ? (
            <div className="ts-hint">{query ? "No file matches that." : "This folder has no files."}</div>
          ) : (
            matches.map((m, i) => {
              const cut = m.path.lastIndexOf("/") + 1;
              return (
                <div key={m.path} className={`row ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
                  <span className="lab">
                    <Highlighted text={m.path.slice(cut)} positions={m.positions} offset={cut} />
                  </span>
                  <span className="state">
                    <Highlighted text={m.path.slice(0, Math.max(0, cut - 1))} positions={m.positions} offset={0} />
                  </span>
                </div>
              );
            })
          )}
        </div>
        <div className="pfoot">
          <span>
            {list && !isErr(list)
              ? `${list.files.length.toLocaleString()} files${list.truncated ? " (first 50,000)" : ""}${list.unreadable ? ` · ${plural(list.unreadable, "folder")} unreadable` : ""}`
              : ""}
          </span>
          <span className="right">↑↓ choose · ↵ open · esc close</span>
        </div>
      </div>
    </>
  );
}
