import React, { useEffect, useRef, useState } from "react";
import type { TranscriptHit } from "../shared/types";

export type SearchStatus = { conversations: number; files: number; indexing: { done: number; total: number } | null; lastSync: number; problem: string | null };

export const OPEN_LABEL: Record<TranscriptHit["open"]["how"], string> = {
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
 * never opened in Mockingbird. Debounced; a stale answer never replaces a newer
 * one; while the first index builds, the search re-runs so results fill in.
 */
export function useTranscriptSearch(q: string) {
  const [hits, setHits] = useState<TranscriptHit[]>([]);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
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
    }, q ? 140 : 0);
    return () => clearTimeout(t);
  }, [q, tick]);

  useEffect(() => {
    if (!status?.indexing) return;
    const t = setTimeout(() => setTick((n) => n + 1), 1500);
    return () => clearTimeout(t);
  }, [status]);

  return { hits, status, error, setError };
}

/** One conversation hit: where it ran, when, how it opens, and the matched words in context. */
export function ConversationRow({ hit: h, selected, onOpen, onHover }: { hit: TranscriptHit; selected: boolean; onOpen: () => void; onHover: () => void }) {
  return (
    <div className={`sv-hit sv-conv ${selected ? "sel" : ""}`} onMouseEnter={onHover} onClick={onOpen}>
      <div className="sv-conv-top">
        <span className="sv-conv-title">{h.open.how === "room" ? h.open.roomTitle : h.title}</span>
        <span className={`ts-agent ${h.agent}`}>{h.agent}</span>
      </div>
      <div className="sv-conv-meta">
        <span className="sv-conv-cwd">{h.cwd.replace(/^\/Users\/[^/]+/, "~")}</span>
        <span>{ago(h.updated)}</span>
        <span className={`ts-open ${h.open.how}`}>{OPEN_LABEL[h.open.how]}</span>
      </div>
      <div className={`sv-snip ts-snip ${h.kind}`}>
        <Snippet text={h.snippet} />
      </div>
    </div>
  );
}
