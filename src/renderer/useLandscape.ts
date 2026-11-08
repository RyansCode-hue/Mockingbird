import { useCallback, useEffect, useRef, useState } from "react";
import { isErr, type SessionInfo } from "../shared/types";
import type { LandscapeChange, LandscapePatch, LandscapeState } from "../shared/landscape";
import { LEGACY_PREF_KEYS, migrateLayout, type LegacyPrefs } from "../shared/landscapeMigrate";
import { afterChange, migrationPatch, migrationStep, newer, type ListsLoaded, type MigrationStep } from "./landscapeModel";
import { readPref } from "./prefs";
import { settled } from "./settled";
import { isRemotePaneId } from "../shared/team/livePanes";

export interface LandscapeStore {
  /** The landscape as the main process has it; null until it's been read. */
  state: LandscapeState | null;
  /** Why it couldn't be read, or the last change couldn't be made. */
  error: string | null;
  /** Send a change; why it was refused or never answered (also said in `error`), or null once it's made. */
  update: (patch: LandscapePatch, what: string) => Promise<string | null>;
  reload: () => void;
  /**
   * The revision of the newest landscape this window has, as of now (ahead of `state` until it renders): a change's
   * Undo goes by it, offered only while nothing else has changed the landscape since that change was saved.
   */
  revNow: () => number | null;
}

/** How often a layout file that couldn't be read is read again; the UI preview shortens it. */
const REREAD_MS = 20_000;
const rereadMs = () => (globalThis as { __mbLandscapeRereadMs?: number }).__mbLandscapeRereadMs ?? REREAD_MS;

/**
 * This window's copy of the landscape (~/.mockingbird/landscape.json, owned
 * by the main process), kept in step with every window's changes. Read only
 * while `on`: with the Labs flag off the file is never touched.
 */
export function useLandscape(on: boolean): LandscapeStore {
  const [state, setState] = useState<LandscapeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cur = useRef<LandscapeState | null>(null);
  const take = (next: LandscapeState) => {
    cur.current = newer(cur.current, next);
    setState(cur.current);
  };
  const reload = useCallback(() => {
    void settled(window.mb.landscapeGet(), "Couldn't read the landscape").then((r) => {
      if (isErr(r)) {
        console.error("[mockingbird] couldn't read the landscape:", r.error);
        return setError(`Couldn't read the layout: ${r.error}`);
      }
      setError(null);
      take(r);
    });
  }, []);
  useEffect(() => {
    if (!on) return;
    const off = window.mb.onLandscapeChanged((change: LandscapeChange) => {
      // before the first read lands there's nothing to apply it to: that read has it
      if (!cur.current) return;
      const next = afterChange(cur.current, change);
      if (next) {
        cur.current = next;
        setState(next);
      } else reload();
    });
    reload();
    return off;
  }, [on]);
  // main reads the file again with each get while it holds only a stand-in: ask now and then, so the file's layout
  // comes back once it can be read without waiting for a change
  const unreadable = !!state?.problems.some((p) => p.kind === "unreadable");
  useEffect(() => {
    if (!on || !unreadable) return;
    const t = setInterval(reload, rereadMs());
    return () => clearInterval(t);
  }, [on, unreadable]);
  const update = useCallback(async (patch: LandscapePatch, what: string): Promise<string | null> => {
    const r = await settled(window.mb.landscapeUpdate(patch));
    if (isErr(r)) {
      console.error(`[mockingbird] the landscape refused ${what}:`, r.error, patch);
      setError(`Couldn't save ${what}: ${r.error}`);
      return r.error;
    }
    setError(null);
    take(r);
    return null;
  }, []);
  const revNow = useCallback(() => cur.current?.rev ?? null, []);
  return { state, error, update, reload, revNow };
}

/** The grid's layout prefs as the grid left them in localStorage, each parsed; the keys stay as they are. */
export function readLegacyPrefs(): LegacyPrefs {
  const out: LegacyPrefs = {};
  for (const [field, key] of Object.entries(LEGACY_PREF_KEYS) as [keyof LegacyPrefs, string][]) out[field] = readPref<unknown>(key, undefined);
  return out;
}

export interface Migrating {
  step: MigrationStep;
  /** Why the last attempt failed; it's tried again with retry(). */
  failed: string | null;
  retry: () => void;
  /**
   * Why teammates' sessions couldn't be read, while reading in waits for them:
   * retryRemote() asks again, and withoutRemote() reads in without them. Their
   * workspaces are then placed where there's room as they come, like any new one.
   */
  remoteFailed: string | null;
  retryRemote: () => void;
  withoutRemote: () => void;
}

/**
 * Read the grid's layout into the landscape the first time it's shown
 * (migrationStep says when), once per window: a failure is said and tried
 * again only on retry(), and migratedAt stays unset so the next launch tries
 * too. Prefs it couldn't read and ids that name no session are logged.
 */
export function useLandscapeMigration(o: {
  /** The Labs flag: nothing is read in while it's off. */
  on: boolean;
  store: LandscapeStore;
  lists: ListsLoaded;
  /** This Mac's live sessions, the previous run's resumable ones, and teammates' room sessions. */
  live: SessionInfo[];
  resumable: SessionInfo[];
  remote: SessionInfo[];
  /** Why teammates' sessions couldn't be read, and asking again. */
  remoteError: string | null;
  retryRemote: () => void;
}): Migrating {
  const [skipRemote, setSkipRemote] = useState(false);
  const lists = skipRemote ? { ...o.lists, remote: true } : o.lists;
  const step: MigrationStep = o.on ? migrationStep(o.store.state, lists) : { kind: "wait", why: "the landscape is off" };
  const remoteFailed = step.kind === "wait" && !lists.remote && o.remoteError ? o.remoteError : null;
  const [failed, setFailed] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const started = useRef(-1);
  useEffect(() => {
    if (step.kind !== "run" || started.current === tries) return;
    started.current = tries;
    let patch: LandscapePatch;
    try {
      const m = migrateLayout(readLegacyPrefs(), [...o.live, ...o.resumable, ...o.remote], { closed: new Set(o.resumable.map((s) => s.id)) });
      if (m.ignored.length) console.warn("[mockingbird] reading the grid's layout into the landscape, left out prefs not in the grid's shape:", m.ignored);
      // read in without teammates' sessions, theirs name no session yet without being stale
      const later = skipRemote && !o.lists.remote ? m.stale.filter(isRemotePaneId) : [];
      const stale = m.stale.filter((id) => !later.includes(id));
      if (later.length) console.info("[mockingbird] reading the grid's layout into the landscape without teammates' sessions, which are placed as they come:", later);
      if (stale.length) console.info("[mockingbird] reading the grid's layout into the landscape, dropped ids that name no session now:", stale);
      patch = migrationPatch(m.landscape);
    } catch (err) {
      console.error("[mockingbird] couldn't read the grid's layout into the landscape:", err);
      setFailed(err instanceof Error ? err.message : String(err));
      return;
    }
    void o.store.update(patch, "the grid's layout, read in").then((error) => setFailed(error && `It couldn't be saved: ${error}`));
  }, [step.kind, tries]);
  const retry = useCallback(() => {
    setFailed(null);
    setTries((n) => n + 1);
  }, []);
  const withoutRemote = useCallback(() => setSkipRemote(true), []);
  return { step, failed, retry, remoteFailed, retryRemote: o.retryRemote, withoutRemote };
}
