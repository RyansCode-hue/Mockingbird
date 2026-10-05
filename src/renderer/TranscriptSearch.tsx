import React, { useEffect, useRef, useState } from "react";
import { isErr, type TranscriptHit } from "../shared/types";
import { ago } from "./format";

type SearchStatus = { conversations: number; files: number; indexing: { done: number; total: number } | null; lastSync: number; problem: string | null };

const OPEN_LABEL: Record<TranscriptHit["open"]["how"], string> = {
  pane: "go to pane",
  previous: "restore session",
  room: "open room",
  resume: "open as session",
};

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
 * The hits to show after a re-run: the ones already shown when nothing about
 * them changed, so a list being re-read while the index syncs doesn't re-render
 * (or lose its place) every time.
 */
export function freshHits(shown: TranscriptHit[], fresh: TranscriptHit[]): TranscriptHit[] {
  return JSON.stringify(shown) === JSON.stringify(fresh) ? shown : fresh;
}

/**
 * Search every Claude and Codex conversation on this Mac — open, closed, or
 * never opened in Mockingbird. Debounced; a stale answer never replaces a newer
 * one; while the index builds or syncs, the search re-runs so results fill in.
 * Nothing runs while `enabled` is off.
 */
export function useTranscriptSearch(q: string, enabled = true) {
  const [hits, setHits] = useState<TranscriptHit[]>([]);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    if (!enabled) return;
    const t = setTimeout(async () => {
      const r = await window.mb.searchTranscripts(q).catch((err: unknown) => ({ error: `Search failed: ${err instanceof Error ? err.message : err}` }));
      if (n !== seq.current) return; // a newer query is on its way
      if (isErr(r)) {
        setError(r.error);
        setHits([]);
        return;
      }
      setError(r.problem ?? "");
      setStatus(r);
      setHits((h) => freshHits(h, r.hits));
    }, q ? 140 : 0);
    return () => clearTimeout(t);
  }, [q, tick, enabled]);

  useEffect(() => {
    if (!enabled || !status?.indexing) return;
    const t = setTimeout(() => setTick((n) => n + 1), 1500);
    return () => clearTimeout(t);
  }, [status, enabled]);

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
