/**
 * The landscape store as Mockingbird 1.8.3 had it (src/main/landscape.ts at d6271f0), for the compatibility tests
 * (landscapeCompat.test.ts): how 1.8.3 opens, changes and saves a landscape.json a later build wrote. Only its imports
 * are changed: its landscape module is 1.8.3's (./landscape), and the wire book's reading and writing
 * (shared/wires.ts), writeFileAtomic and isMissing are today's, unchanged since d6271f0. Never edited to match today's
 * store: differing from it is what it's here for.
 */
import * as fs from "fs";
import {
  LANDSCAPE_VERSION,
  LandscapeShapeError,
  applyPatch,
  emptyLandscape,
  parseLandscape,
  parsePatch,
  renameAreaPatch,
  reopenPatch,
  sameLandscape,
  versionOf,
  type Landscape,
  type LandscapeChange,
  type LandscapeProblem,
  type LandscapeState,
} from "./landscape";
import type { SessionInfo } from "../../../src/shared/types";
import { freshWireRead, parseWireBook, storedWireBook, type DroppedWire, type KeptEntries, type WireBook, type WireBookRead, type WireChange, type WireProblem, type WireReply, type WireState } from "../../../src/shared/wires";
import { isMissing, writeFileAtomic } from "../../../src/main/fileOps";

/**
 * What a wire edit answers: the book it leaves (the same one for no change), the wires that went with a forgotten
 * session, and kept entries it drops (keys of `kept.links` and `kept.notes`), with why for the log.
 */
export interface WireEdit {
  book: WireBook;
  dropped?: DroppedWire[];
  dropKept?: { links: string[]; notes: string[]; why: string };
}

type OkRead = Extract<WireBookRead, { status: "ok" }>;

/** How long changes gather before they're written: a drag's patches land in one write. */
export const LANDSCAPE_SAVE_MS = 300;

export interface LandscapeStoreOptions {
  /** ~/.mockingbird/landscape.json */
  file: string;
  /** Sends `landscape:changed` to every window. */
  emit: (change: LandscapeChange) => void;
  /** Sends `wires:changed` to every window. */
  emitWires?: (change: WireChange) => void;
  log: (context: string, err: unknown) => void;
  saveMs?: number;
}

interface Loaded {
  landscape: Landscape;
  /** The wire book beside it: same file, but not the layout. */
  wires: WireBookRead;
  /** What reading the file found wrong. */
  problem: LandscapeProblem | null;
  /** The file is left as it is: changes stay in memory. */
  readOnly: boolean;
  /** Reading the file failed: `landscape` only stands in for it until it's read again, with the next get or update. */
  standIn: boolean;
  /** Changes made to the stand-in. */
  standInChanges: number;
}

/**
 * Where workspaces and areas sit, owned by the main process
 * (docs/landscape-phase1.md). Windows send patches; each is merged in arrival
 * order, sent on to every window, and written soon after: changes made within
 * `saveMs` of the first unsaved one share one atomic write (temp file, then
 * rename), so a long drag is still saved every `saveMs`. A patch that changes
 * nothing is neither counted, sent nor written. Quitting flushes.
 *
 * The file is never quietly replaced by an empty layout:
 * - one that isn't a landscape (not JSON, or the wrong shape) is moved to
 *   `<file>.bad-<time>` first, and the window is told (`problems`, shown as a
 *   banner); when it can't be moved it's left as it is, and changes this run
 *   are kept in memory and never written;
 * - one a newer Mockingbird wrote is left as it is, the same way;
 * - one that can't be read (the disk, too many open files) isn't touched: an
 *   empty stand-in is shown and never saved, and the file is read again with
 *   the next get or update. Once it reads, its layout replaces the stand-in,
 *   and changes made to the stand-in are dropped, with a problem saying so:
 *   they were made against an empty layout, not the file's, so merging them
 *   could put defaults over real placements (a migration run against the
 *   stand-in, say) with nothing to tell which is right.
 *
 * The file is read on first use, not at startup, so a second copy of the app
 * that only hands over to the first never moves it.
 *
 * The wire book (shared/wires.ts) lives in the same file and goes out in the same atomic write, but it isn't the layout:
 * its changes have their own count and channel and leave `rev` alone, since a layout Undo ends when `rev` moves. A wire
 * change is written at once and only then takes effect: nothing about a wire is held back in memory. While a stand-in
 * or a read-only file holds the place of the layout, the book can't be read or changed, and says so, so "can't tell"
 * is never answered as "no wires". What's wrong inside the book is the book's: it never gets the layout moved aside,
 * and a save of the layout writes it back as it was read.
 */
export class LandscapeStore {
  private loaded: Loaded | null = null;
  private droppedProblem: LandscapeProblem | null = null;
  private saveProblem: LandscapeProblem | null = null;
  private rev = 0;
  private wiresRev = 0;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly saveMs: number;

  constructor(private readonly o: LandscapeStoreOptions) {
    this.saveMs = o.saveMs ?? LANDSCAPE_SAVE_MS;
  }

  get(): LandscapeState {
    return this.state(this.load());
  }

  /**
   * Merge a window's patch. Throws LandscapeShapeError, changing nothing,
   * when the patch isn't one or would leave an entry incomplete. A window
   * that can't be told of the change (a failed send is logged) sees the gap in
   * `rev` with the next one.
   */
  update(raw: unknown): LandscapeState {
    const patch = parsePatch(raw);
    // a patch made against the stand-in, arriving as the file can be read again, goes with the stand-in's other changes
    const held = this.loaded?.standIn ? this.loaded : null;
    const againstStandIn = !!held && !sameLandscape(applyPatch(held.landscape, patch), held.landscape);
    const l = this.load(againstStandIn ? 1 : 0);
    if (held && !l.standIn) return this.state(l);
    const next = applyPatch(l.landscape, patch);
    if (sameLandscape(next, l.landscape)) return this.state(l);
    l.landscape = next;
    this.rev++;
    if (l.standIn) l.standInChanges++;
    if (!l.readOnly) {
      this.dirty = true;
      this.timer ??= setTimeout(() => {
        this.timer = null;
        this.saveNow();
      }, this.saveMs);
    }
    this.tell({ rev: this.rev, patch, problems: this.problems() });
    return this.state(l);
  }

  /** The wire book as it stands, read from the file first if need be; `book` is null, and `refused` says why, when it can't be used. */
  wires(): WireState {
    return this.wireState(this.load());
  }

  /**
   * Why the book can't be saved now, or null. The file having been made read-only counts, though a rename would go
   * through: a rename doesn't ask the file. Whoever's about to act on a wire asks first, so nothing is sent on a change
   * that won't be written.
   */
  wiresWriteRefusal(): string | null {
    const l = this.load();
    const refused = this.wiresRefusal(l);
    if (refused) return refused;
    try {
      fs.accessSync(this.o.file, fs.constants.W_OK);
    } catch (err) {
      if (!isMissing(err)) return `Wires can't be changed: ${this.o.file} is read-only (${(err as Error).message}).`;
    }
    return null;
  }

  /**
   * Change the wire book. `edit` answers the new book (the same one for no change) or a refusal. A change is written
   * before it takes effect: when it can't be, the book stays as it was and the answer says so. Every window hears of
   * one that's made, with `dropped` naming the wires that went with a forgotten session.
   */
  editWires(edit: (book: WireBook, kept: Readonly<KeptEntries>) => WireEdit | { refused: string }): WireReply {
    const refused = this.wiresWriteRefusal();
    if (refused) return { refused };
    const l = this.loaded!;
    const read = l.wires as OkRead;
    const r = edit(read.book, read.kept);
    if ("refused" in r) return r;
    const { droppedKept, ...next } = withKeptDropped({ ...read, book: r.book }, r.dropKept);
    if (r.book === read.book && next.kept === read.kept) return { state: this.wireState(l) };
    l.wires = next;
    try {
      this.write(l);
    } catch (err) {
      l.wires = read;
      this.o.log(`landscape: couldn't save ${this.o.file}`, err);
      return { refused: `The wire couldn't be saved to ${this.o.file} (${(err as Error).message}), so nothing changed.` };
    }
    for (const line of droppedKept) this.o.log("landscape", line);
    this.saved(l);
    this.wiresRev++;
    const state = this.wireState(l);
    this.tellWires({ ...state, ...(r.dropped?.length ? { dropped: r.dropped } : {}) });
    return { state };
  }

  /**
   * Group `from` was renamed to `to` (renameGroup): its area, stacks and ghosts follow it (renameAreaPatch), and
   * `members`, the sessions that were in it, are placed again when it merges into an area that's there already; the
   * places of `closed`, its closed sessions, move into that area. The
   * file is read for this if no window has asked for it yet (the landscape is off this run), so a later run doesn't
   * find the group without its area; with no file there's nothing to change and nothing is written. A file that
   * can't be read is left as it is and said: the rename can't follow it. Throws LandscapeShapeError, as update does,
   * if the patch can't be made.
   */
  groupRenamed(from: string, to: string, members: readonly string[], closed: readonly Pick<SessionInfo, "id" | "taskGroup">[] = []): void {
    const l = this.load();
    if (l.standIn) {
      this.o.log(`landscape: ${from}'s area couldn't follow its rename to ${to}`, new Error("landscape.json couldn't be read"));
      return;
    }
    const patch = renameAreaPatch(l.landscape, from, to, members, closed);
    if (patch) this.update(patch);
  }

  /** Closed session `s` is running again: a place it kept outside its own area goes, so it's placed anew there (reopenPatch). */
  sessionReopened(s: Pick<SessionInfo, "id" | "taskGroup">): void {
    const l = this.load();
    if (l.standIn) {
      this.o.log(`landscape: ${s.id} reopened, and its place couldn't be checked`, new Error("landscape.json couldn't be read"));
      return;
    }
    const patch = reopenPatch(l.landscape, s);
    if (patch) this.update(patch);
  }

  /** Write what hasn't been yet, now (quitting). Throws when it can't be written; the changes stay unsaved and reported. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || !this.loaded || this.loaded.readOnly) return;
    const err = this.save(this.loaded);
    if (err) throw err;
  }

  private state(l: Loaded): LandscapeState {
    return { landscape: l.landscape, rev: this.rev, problems: this.problems() };
  }

  private problems(): LandscapeProblem[] {
    return [this.loaded?.problem, this.droppedProblem, this.saveProblem].filter((p): p is LandscapeProblem => !!p);
  }

  private wireState(l: Loaded): WireState {
    const refused = this.wiresRefusal(l);
    const aside: WireProblem[] = l.problem?.movedTo ? [{ kind: "aside", message: l.problem.message }] : [];
    return { book: refused || l.wires.status !== "ok" ? null : l.wires.book, refused, wiresRev: this.wiresRev, problems: [...aside, ...l.wires.problems] };
  }

  /** Why the book can't be used at all: the file isn't there to read, or nothing may be written to it, or the book in it can't be read here. */
  private wiresRefusal(l: Loaded): string | null {
    if (l.standIn) return `Wires can't be read or changed right now. ${l.problem!.message}`;
    if (l.readOnly) return `Wires can't be read or changed. ${l.problem!.message}`;
    return l.wires.status === "ok" ? null : l.wires.problems[0].message;
  }

  private tellWires(change: WireChange): void {
    try {
      this.o.emitWires?.(change);
    } catch (err) {
      this.o.log(`landscape: couldn't send wire revision ${change.wiresRev} to the windows`, err);
    }
  }

  /** Send a change to the windows. Failing to is logged, not thrown: the change is made and its save due either way. */
  private tell(change: LandscapeChange): void {
    try {
      this.o.emit(change);
    } catch (err) {
      this.o.log(`landscape: couldn't send revision ${change.rev} to the windows`, err);
    }
  }

  /** The timer's save. A failure is in `problems` (save() logged it), and the changes stay dirty for the next change or the quit. */
  private saveNow(): void {
    const l = this.loaded;
    if (this.dirty && l && !l.readOnly) this.save(l);
  }

  /** Write the landscape. A failure is logged, reported to the windows as a `save` problem until a save works, and returned. */
  private save(l: Loaded): Error | null {
    try {
      this.write(l);
    } catch (err) {
      this.o.log(`landscape: couldn't save ${this.o.file}`, err);
      const message = `The layout couldn't be saved to ${this.o.file} (${(err as Error).message}). Changes are kept, and saved again with the next one and on quit.`;
      const changed = this.saveProblem?.message !== message;
      this.saveProblem = { kind: "save", message, file: this.o.file };
      if (changed) this.tell({ rev: this.rev, patch: null, problems: this.problems() });
      return err as Error;
    }
    if (this.saved(l)) {
      this.wiresRev++;
      this.tellWires(this.wireState(l));
    }
    return null;
  }

  /** The layout and the wire book, in one atomic write. Throws when it can't be written. */
  private write(l: Loaded): void {
    writeFileAtomic(this.o.file, JSON.stringify({ ...l.landscape, wires: storedWireBook(l.wires) }, null, 2));
  }

  /**
   * The file holds everything now: nothing is unsaved, a problem saving is over, and it has a wire book, so a "missing"
   * one is over too. Answers whether that changed what the wires report.
   */
  private saved(l: Loaded): boolean {
    let missingOver = false;
    if (l.wires.problems.some((p) => p.kind === "missing")) {
      l.wires = { ...l.wires, problems: l.wires.problems.filter((p) => p.kind !== "missing") };
      missingOver = true;
    }
    this.dirty = false;
    if (this.saveProblem) {
      this.saveProblem = null;
      this.tell({ rev: this.rev, patch: null, problems: this.problems() });
    }
    return missingOver;
  }

  /**
   * The landscape, read from the file the first time; while only a stand-in
   * is held, the file is read again. `pending` counts changes in hand that
   * were made against the stand-in, dropped with it if the file reads now.
   */
  private load(pending = 0): Loaded {
    const held = this.loaded;
    if (held && !held.standIn) return held;
    const next = this.read();
    if (next.standIn) {
      // logged once per reason, not on every retry
      if (held?.problem?.message !== next.problem?.message) this.o.log("landscape", new Error(next.problem!.message));
      if (!held) return (this.loaded = next);
      held.problem = next.problem;
      return held;
    }
    this.loaded = next;
    if (held) {
      const dropped = held.standInChanges + pending;
      const what = `${dropped} layout change${dropped === 1 ? "" : "s"} made to the empty stand-in while it couldn't be read`;
      this.o.log("landscape", new Error(`${this.o.file} could be read again${dropped ? `; dropped ${what}` : ""}`));
      if (dropped) this.droppedProblem = { kind: "dropped", message: `${this.o.file} could be read again, and its layout is back. Dropped: ${what}.`, file: this.o.file };
      this.rev++;
      this.tell({ rev: this.rev, patch: null, landscape: next.landscape, problems: this.problems() });
      this.wiresRev++;
      this.tellWires(this.wireState(next));
    }
    return next;
  }

  /** The file as it is now: a landscape, a fresh one when there's no file, or a stand-in when reading it failed. */
  private read(): Loaded {
    const file = this.o.file;
    const fresh = (problem: LandscapeProblem | null, readOnly = false): Loaded => ({ landscape: emptyLandscape(), wires: freshWireRead(), problem, readOnly, standIn: false, standInChanges: 0 });
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (isMissing(err)) return fresh(null);
      // an I/O failure says nothing about what the file holds: it's left alone, and nothing is saved over it
      const message = `${file} couldn't be read (${(err as Error).message}). It's left as it is and read again with the next change; until then the layout is an empty stand-in, and changes to it aren't saved.`;
      return { landscape: emptyLandscape(), wires: freshWireRead(), problem: { kind: "unreadable", message, file, readOnly: true }, readOnly: true, standIn: true, standInChanges: 0 };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return this.setAside(`isn't valid JSON (${(err as Error).message})`, err, fresh);
    }
    const v = versionOf(parsed);
    if (v !== null && v > LANDSCAPE_VERSION) {
      const message = `${file} was written by a newer Mockingbird (landscape version ${v}). It's left as it is, and changes to the layout and wires aren't saved until this Mockingbird is updated.`;
      this.o.log("landscape", new Error(message));
      return fresh({ kind: "newer", message, file, readOnly: true }, true);
    }
    try {
      return { landscape: parseLandscape(parsed), wires: this.readWires(parsed, v), problem: null, readOnly: false, standIn: false, standInChanges: 0 };
    } catch (err) {
      if (!(err instanceof LandscapeShapeError)) throw err;
      return this.setAside(`isn't a landscape (${err.message})`, err, fresh);
    }
  }

  /** The book in a file that reads as a landscape: what's wrong with it is logged here, and kept for the banner. */
  private readWires(parsed: unknown, v: number | null): WireBookRead {
    const raw = (parsed as { wires?: unknown }).wires;
    const read = parseWireBook(raw);
    // this version always writes one, so a file of this version without one was edited: read as none, said once
    if (raw === undefined && v === LANDSCAPE_VERSION) read.problems.push({ kind: "missing", message: `${this.o.file} has no wires in it, though this version always saves them. It's read as having none.` });
    for (const p of read.problems) this.o.log("landscape", new Error(p.message));
    return read;
  }

  /** Move a file that isn't a landscape out of the way, so the next save can't overwrite it; when it won't move, nothing is written this run. */
  private setAside(why: string, err: unknown, fresh: (p: LandscapeProblem, readOnly?: boolean) => Loaded): Loaded {
    const file = this.o.file;
    const movedTo = `${file}.bad-${Date.now()}`;
    try {
      fs.renameSync(file, movedTo);
    } catch (moveErr) {
      const message = `${file} ${why} and couldn't be moved aside (${(moveErr as Error).message}). It's left as it is, and changes to the layout and wires aren't saved until it's fixed or removed.`;
      this.o.log("landscape", new Error(message, { cause: err }));
      return fresh({ kind: "corrupt", message, file, readOnly: true }, true);
    }
    const message = `${file} ${why}. It was moved to ${movedTo}, and the layout and its wires start over.`;
    this.o.log("landscape", new Error(message, { cause: err }));
    return fresh({ kind: "corrupt", message, file, movedTo });
  }
}

/**
 * `read` with kept entries gone: those `drop` names, and any whose key the book now holds as a live entry. A kept copy
 * under a live key would otherwise be what's written, and the live one lost with the next start. Each one dropped is
 * named in `droppedKept`, for the log, and its problem goes with it.
 */
function withKeptDropped(read: OkRead, drop: WireEdit["dropKept"]): OkRead & { droppedKept: string[] } {
  const lines: string[] = [];
  const gone = { links: new Set<string>(), notes: new Set<string>() };
  for (const part of ["links", "notes"] as const) {
    const what = part === "links" ? "A wire" : "A wire note";
    for (const k of drop?.[part] ?? []) {
      if (!Object.hasOwn(read.kept[part], k) || gone[part].has(k)) continue;
      gone[part].add(k);
      lines.push(`${what} in landscape.json that couldn't be read (${JSON.stringify(k)}) ${drop!.why}.`);
    }
    for (const k of Object.keys(read.book[part])) {
      if (!Object.hasOwn(read.kept[part], k) || gone[part].has(k)) continue;
      gone[part].add(k);
      lines.push(`${what} in landscape.json that couldn't be read (${JSON.stringify(k)}) was replaced by a new one under the same key, which is what's saved now.`);
    }
  }
  if (!gone.links.size && !gone.notes.size) return { ...read, droppedKept: [] };
  const without = (r: Record<string, unknown>, keys: Set<string>) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.has(k)));
  return {
    ...read,
    kept: { ...read.kept, links: without(read.kept.links, gone.links), notes: without(read.kept.notes, gone.notes) },
    problems: read.problems.filter((p) => !(p.id !== undefined && ((p.kind === "entry" && gone.links.has(p.id)) || (p.kind === "note" && gone.notes.has(p.id))))),
    droppedKept: lines,
  };
}
