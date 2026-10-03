import React, { useEffect, useRef, useState } from "react";
import type { TranscriptHit } from "../shared/types";

type Status = { conversations: number; files: number; indexing: { done: number; total: number } | null; lastSync: number; problem: string | null };

const OPEN_LABEL: Record<TranscriptHit["open"]["how"], string> = {
  pane: "go to pane",
  previous: "restore session",
  room: "open room",
  resume: "open as session",
};

/** "4m", "3h", "5d", or a date for anything older than a month. */
export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 60) return `${m}m ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)}h ago`;
  if (m < 30 * 24 * 60) return `${Math.round(m / (24 * 60))}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

/** The matched words of a snippet (between \u0001 and \u0002) as <mark>s. */
export function Snippet({ text }: { text: string }) {
  const parts = text.replace(/\s+/g, " ").split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("\u0001") ? <mark key={i}>{p.slice(1, -1)}</mark> : <React.Fragment key={i}>{p}</React.Fragment>))}
    </>
  );
}

/**
 * Search every Claude and Codex conversation on this Mac — open, closed, or
 * never opened in Mockingbird — and open the hit wherever it lives.
 */
export function TranscriptSearch({ onClose, onOpen }: { onClose: () => void; onOpen: (hit: TranscriptHit) => Promise<string | null> }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<TranscriptHit[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0); // re-runs the search while the first index builds
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const r = await window.mb.searchTranscripts(q);
      if (n !== seq.current) return; // a newer query is on its way
      if (r?.error) {
        setError(r.error);
        setHits([]);
        return;
      }
      setError(r.problem ?? "");
      setStatus(r);
      setHits(r.hits);
      setSel(0);
    }, q ? 140 : 0);
    return () => clearTimeout(t);
  }, [q, tick]);

  // while the first index builds, keep the count (and the results) fresh
  useEffect(() => {
    if (!status?.indexing) return;
    const t = setTimeout(() => setTick((n) => n + 1), 1500);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    listRef.current?.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const open = async (h: TranscriptHit | undefined) => {
    if (!h || busy) return;
    setBusy(true);
    setError("");
    const err = await onOpen(h);
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <>
      <div className="scrim" onMouseDown={onClose} />
      <div className="palette ts-search">
        <div className="inrow">
          <span className="prompt">⌕</span>
          <input
            autoFocus
            placeholder="Search every conversation — words, files, commands"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(hits.length - 1, s + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              }
              if (e.key === "Enter") open(hits[sel]);
            }}
          />
        </div>
        <div className="results" ref={listRef}>
          {error && <div className="err" style={{ margin: "6px 14px" }}>{error}</div>}
          {!q.trim() && !error && (
            <div className="ts-hint">
              Finds any Claude or Codex conversation on this Mac — open, closed, or never opened in Mockingbird — by what was said, the files it
              touched, or the commands it ran.
            </div>
          )}
          {q.trim() && !hits.length && !error && <div className="ts-hint">No conversation mentions that{status?.indexing ? " yet — still indexing" : ""}.</div>}
          {hits.map((h, i) => (
            <div key={h.id} className={`row ts-row ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => open(h)}>
              <div className="ts-top">
                <span className="lab">{h.open.how === "room" ? `${h.open.roomTitle}` : h.title}</span>
                <span className={`ts-agent ${h.agent}`}>{h.agent}</span>
                <span className="state">{h.cwd.replace(/^\/Users\/[^/]+/, "~")}</span>
                <span className="ts-when">{ago(h.updated)}</span>
                <span className={`ts-open ${h.open.how}`}>{OPEN_LABEL[h.open.how]}</span>
              </div>
              <div className={`ts-snip ${h.kind}`}>
                <Snippet text={h.snippet} />
              </div>
            </div>
          ))}
        </div>
        <div className="pfoot">
          <span>
            {status
              ? status.indexing
                ? `indexing ${status.indexing.done}/${status.indexing.total} transcripts…`
                : `${status.conversations} conversations indexed`
              : "opening the index…"}
          </span>
          <span className="right">↑↓ choose · ↵ open · esc close</span>
        </div>
      </div>
    </>
  );
}
