import React, { useEffect, useMemo, useRef, useState } from "react";
import { isErr, prAskedState, prNeedsYou, type SessionInfo } from "../shared/types";
import { carriesWork } from "../shared/wires";
import { Modal } from "./Modal";
import { EARLY_KEYS_HINT, useAimedKeys, useArrivalGuard } from "./answerGuard";
import { useWires } from "./WireLayer";
import { pipelinesNow, usePipelines } from "./TicketPipeline";
import { markMergedQuestion, prLabel, prMergeNote } from "./ticketPipelineModel";
import { gateContextOf, type WireRoom } from "./wiresModel";
import { notMine, type NeedsItem, type NeedsWires } from "./needsYouModel";
import type { ResolvedLayout } from "./landscapeModel";
import type { NeedsEnv } from "./workspaceActions";
import type { WireActs } from "./FinishStep";

/** How long an act waits for the landscape to come up (its popovers are drawn there) before it's given up, saying so. */
const LANDSCAPE_WAIT_MS = 5_000;

/**
 * Needs you's wires and pull requests (docs/landscape-wires.md, W5), for main.tsx's tray: the wire book's gates as the
 * landscape draws them (`wires`, for needsItems), each item's acts (`envOf`, for needsActions), what the landscape lends
 * them (`actsRef`: Show, Send, Finish step, which bring the landscape up when it isn't), and Mark merged…'s question
 * (`dialog`).
 *
 * Each act names exactly what its item was drawn about, and does nothing to anything else: a wire's Send sends the
 * pending the item named or nothing (the send popover then shows what's there now); Check now and Mark merged… act on
 * the pull request by its page, and Mark merged… asks first, naming it, and holds while what it asks changes.
 */
export function useWireNeeds(o: {
  sessions: readonly SessionInfo[];
  layout: ResolvedLayout | null;
  rooms: readonly WireRoom[] | undefined;
  areaOf: (s: SessionInfo) => string;
  say: (text: string) => void;
  /** The landscape brought up: an act on a wire's popover needs it. */
  toLandscape: () => void;
}): { wires: NeedsWires | null; envOf: (item: NeedsItem) => Pick<NeedsEnv, "wire" | "merge" | "finish">; actsRef: React.MutableRefObject<WireActs | null>; dialog: JSX.Element | null } {
  const state = useWires().state;
  const pipelines = usePipelines();
  const areaOf = useRef(o.areaOf);
  areaOf.current = o.areaOf;
  const wires = useMemo((): NeedsWires | null => {
    const l = o.layout;
    const ctx = l && state ? gateContextOf(l, state, o.rooms) : null;
    if (!l || !ctx) return null;
    const byId = new Map(o.sessions.map((s) => [s.id, s]));
    return {
      ctx,
      place: (id) => {
        if (!ctx.end(id)) return null;
        const s = byId.get(id);
        if (s && !notMine(s)) return { session: id, area: areaOf.current(s) };
        // a ghost, a stack's closed tab, or what isn't this install's: drawn, but not a workspace N or Go there takes you into
        const t = [...l.tiles, ...l.ghosts].find((x) => x.members.some((m) => m.id === id) || x.closed?.some((m) => m.id === id));
        return t ? { session: null, area: t.area } : null;
      },
    };
  }, [o.layout, state, o.rooms, o.sessions]);

  // ---- what the landscape lends: an act asked while it isn't up waits for it to come ----
  const actsRef = useRef<WireActs | null>(null);
  const waiting = useRef<{ run: (a: WireActs) => void; timer: ReturnType<typeof setTimeout> }[]>([]);
  const [, setAsked] = useState(0);
  const withActs = <T,>(what: string, fn: (a: WireActs) => T | Promise<T>): Promise<T> => {
    if (actsRef.current) return Promise.resolve(fn(actsRef.current));
    o.toLandscape();
    return new Promise<T>((resolve, reject) => {
      const entry = {
        run: (a: WireActs) => {
          clearTimeout(entry.timer);
          Promise.resolve()
            .then(() => fn(a))
            .then(resolve, reject);
        },
        timer: setTimeout(() => {
          waiting.current = waiting.current.filter((x) => x !== entry);
          reject(new Error(`the landscape didn't come up to ${what}`));
        }, LANDSCAPE_WAIT_MS),
      };
      waiting.current.push(entry);
      setAsked((n) => n + 1);
    });
  };
  useEffect(() => {
    const a = actsRef.current;
    if (!a || !waiting.current.length) return;
    for (const w of waiting.current.splice(0)) w.run(a);
  });
  useEffect(() => () => waiting.current.forEach((w) => clearTimeout(w.timer)), []);
  /** An act, whose refusal (why nothing was done) is said and logged, as its failure is; settles with either, or null. */
  const run = (what: string, fn: (a: WireActs) => string | null | void | Promise<string | null>): Promise<string | null> =>
    withActs(what, fn).then(
      (why) => {
        if (why) {
          console.warn(`[mockingbird] Needs you didn't ${what}: ${why}`);
          o.say(why);
        }
        return why || null;
      },
      (err: unknown) => {
        console.error(`[mockingbird] Needs you couldn't ${what}:`, err);
        const why = `Couldn't ${what}: ${err instanceof Error ? err.message : String(err)}`;
        o.say(why);
        return why;
      }
    );

  // ---- a pull request's acts ----
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const [marking, setMarking] = useState<{ ticket: string; url: string } | null>(null);
  const check = async (ticket: string, url: string) => {
    const pr = pipelines[ticket]?.prs.find((x) => x.url === url);
    if (!pr) return o.say(`That pull request isn't on #${ticket} any more: nothing was checked`);
    setChecking((c) => new Set(c).add(url));
    try {
      const r = await window.mb.pipelinePrCheck(ticket, url);
      if (isErr(r)) {
        console.warn(`[mockingbird] Check now on ${url} (#${ticket}): ${r.error}`);
        return o.say(`Couldn't check ${prLabel(pr)}: ${r.error}`);
      }
      const now = r.prs.find((x) => x.url === url);
      o.say(`${prLabel(pr)}: ${now ? (prMergeNote(now)?.text ?? "open, and read") : "no longer on the ticket"}`);
    } catch (err) {
      console.error(`[mockingbird] Check now on ${url} (#${ticket}):`, err);
      o.say(`Couldn't check ${prLabel(pr)}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setChecking((c) => new Set([...c].filter((x) => x !== url)));
    }
  };

  /**
   * Session `id` went idle with its step unfinished, a handoff or feedback wire out: its Finished item offers Finish
   * step…. A summary since its last prompt (its agent's finish_step, or a person's Finish step) finished it already.
   */
  const unfinished = (id: string) => {
    if (!Object.values(state?.book?.links ?? {}).some((w) => w.from === id && carriesWork(w.type))) return false;
    const note = state?.book && Object.hasOwn(state.book.notes, id) ? state.book.notes[id] : null;
    const promptAt = o.sessions.find((s) => s.id === id)?.promptAt ?? null;
    return !(note?.summary && promptAt !== null && note.summary.at >= promptAt);
  };
  const envOf = (item: NeedsItem): Pick<NeedsEnv, "wire" | "merge" | "finish"> => {
    if (item.wire) {
      const { id, pending, face } = item.wire;
      return {
        wire: {
          send: face === "ready" ? () => run("send it", (a) => a.send(id, pending)) : null,
          show: () => void run("show that wire", (a) => a.show(id)),
        },
      };
    }
    if (item.merge) {
      const { ticket, url } = item.merge;
      // while it's read, what it is may change: Mark merged… waits for the answer
      const busy = checking.has(url) ? { no: "Checking it now: Mark merged… once that's answered" } : null;
      return { merge: { check: busy ?? (() => void check(ticket, url)), mark: busy ?? (() => setMarking({ ticket, url })) } };
    }
    if (item.kind === "finished" && item.session && unfinished(item.session)) {
      const id = item.session;
      return { finish: () => void run("finish its step", (a) => a.finish(id)) };
    }
    return {};
  };

  const dialog = marking ? <MarkMergedDialog key={marking.url} ticket={marking.ticket} url={marking.url} onDone={o.say} onClose={() => setMarking(null)} /> : null;
  return { wires, envOf, actsRef, dialog };
}

/**
 * Mark merged… from Needs you: the pull request named, by its page, and asked about first (markMergedQuestion, as its row
 * in the pipeline panel and the send popover ask). It marks that one only while it still needs you: merged or replaced
 * since, there's nothing to mark, and it says so. A read changing what it asks (closed rather than unreadable) shows the
 * new question and holds its button again; one landing as the click does, before it's drawn, marks nothing and says so
 * (the click is checked against the store's pipelines, not the render's).
 *
 * Its buttons take only a click aimed at them (useArrivalGuard: none as it opens, or as its question changes, nor a
 * double click's second), and no key from a burst begun before it opened or held (useAimedKeys).
 */
function MarkMergedDialog({ ticket, url, onDone, onClose }: { ticket: string; url: string; onDone: (line: string) => void; onClose: () => void }) {
  const p = usePipelines()[ticket];
  const pr = p?.prs.find((x) => x.url === url);
  const open = !!p && !!pr && prNeedsYou(p, pr);
  const question = pr && open ? markMergedQuestion(pr) : null;
  const guard = useArrivalGuard(question);
  const { onKeyDown, keyAimed, stale } = useAimedKeys();
  const [doing, setDoing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label = pr ? prLabel(pr) : "That pull request";
  const mark = guard((e: React.MouseEvent<HTMLButtonElement>) => {
    if (!keyAimed(e) || doing || !pr || !question) return;
    // the store's pipelines, not this render's: a re-read that has come but not been drawn is what's there now
    const live = pipelinesNow()[ticket];
    const now = live?.prs.find((x) => x.url === url);
    if (!live || !now || !prNeedsYou(live, now) || markMergedQuestion(now) !== question) {
      console.warn(`[mockingbird] Mark merged on ${url} (#${ticket}) marked nothing: it changed as it was clicked`);
      return setErr("It changed as you clicked: nothing was marked. Read what it says now.");
    }
    setDoing(true);
    setErr(null);
    // what it asked about goes with it: main marks only while the PR is still that, after any check queued ahead
    window.mb.pipelinePrMarkMerged(ticket, url, prAskedState(pr) ?? "").then(
      (r) => {
        setDoing(false);
        if (isErr(r)) {
          console.warn(`[mockingbird] Mark merged on ${url} (#${ticket}): ${r.error}`);
          return setErr(`Couldn't mark it merged: ${r.error}`);
        }
        onDone(`Marked ${label} merged: #${ticket} and its wires go on as for a merge, their gates asking first.`);
        onClose();
      },
      (x: unknown) => {
        setDoing(false);
        console.error(`[mockingbird] Mark merged on ${url} (#${ticket}):`, x);
        setErr(`Couldn't mark it merged: ${x instanceof Error ? x.message : String(x)}`);
      }
    );
  });
  return (
    <Modal className="modal pl-modal mm-dlg" onClose={onClose} onKeyDown={onKeyDown}>
      <h3>
        #{ticket}: {label}
      </h3>
      {question ? (
        <div className="sub-h mm-q">{question}</div>
      ) : (
        <div className="fp-note">{pr?.mergedAt ? `${label} has merged since: there's nothing to mark.` : !pr ? "It isn't on the ticket any more: there's nothing to mark." : `${label} doesn't need you any more: Mockingbird can follow it again.`}</div>
      )}
      {stale && <div className="sub-h cost-hint">{EARLY_KEYS_HINT}</div>}
      {err && (
        <div className="fp-note err" role="alert">
          {err}
        </div>
      )}
      <div className="row">
        <button className="outline" onClick={guard(onClose)}>
          {question ? "Cancel" : "Close"}
        </button>
        {question && (
          <button className="primary" data-act="mark" disabled={doing} onClick={mark}>
            {doing ? "Marking…" : "Mark merged"}
          </button>
        )}
      </div>
    </Modal>
  );
}
