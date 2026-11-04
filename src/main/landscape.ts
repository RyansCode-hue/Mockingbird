import * as fs from "fs";
import {
  LANDSCAPE_VERSION,
  LandscapeShapeError,
  applyPatch,
  emptyLandscape,
  parseLandscape,
  parsePatch,
  renameAreaPatch,
  sameLandscape,
  versionOf,
  type Landscape,
  type LandscapeChange,
  type LandscapeProblem,
  type LandscapeState,
} from "../shared/landscape";
import { isMissing, writeFileAtomic } from "./fileOps";

/** How long changes gather before they're written: a drag's patches land in one write. */
export const LANDSCAPE_SAVE_MS = 300;

export interface LandscapeStoreOptions {
  /** ~/.mockingbird/landscape.json */
  file: string;
  /** Sends `landscape:changed` to every window. */
  emit: (change: LandscapeChange) => void;
  log: (context: string, err: unknown) => void;
  saveMs?: number;
}

interface Loaded {
  landscape: Landscape;
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
 */
export class LandscapeStore {
  private loaded: Loaded | null = null;
  private droppedProblem: LandscapeProblem | null = null;
  private saveProblem: LandscapeProblem | null = null;
  private rev = 0;
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

  /**
   * Group `from` was renamed to `to` (renameGroup): its area, stacks and ghosts follow it (renameAreaPatch), and
   * `members`, the sessions that were in it, are placed again when it merges into an area that's there already. The
   * file is read for this if no window has asked for it yet (the landscape is off this run), so a later run doesn't
   * find the group without its area; with no file there's nothing to change and nothing is written. A file that
   * can't be read is left as it is and said: the rename can't follow it. Throws LandscapeShapeError, as update does,
   * if the patch can't be made.
   */
  groupRenamed(from: string, to: string, members: readonly string[]): void {
    const l = this.load();
    if (l.standIn) {
      this.o.log(`landscape: ${from}'s area couldn't follow its rename to ${to}`, new Error("landscape.json couldn't be read"));
      return;
    }
    const patch = renameAreaPatch(l.landscape, from, to, members);
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
      writeFileAtomic(this.o.file, JSON.stringify(l.landscape, null, 2));
    } catch (err) {
      this.o.log(`landscape: couldn't save ${this.o.file}`, err);
      const message = `The layout couldn't be saved to ${this.o.file} (${(err as Error).message}). Changes are kept, and saved again with the next one and on quit.`;
      const changed = this.saveProblem?.message !== message;
      this.saveProblem = { kind: "save", message, file: this.o.file };
      if (changed) this.tell({ rev: this.rev, patch: null, problems: this.problems() });
      return err as Error;
    }
    this.dirty = false;
    if (this.saveProblem) {
      this.saveProblem = null;
      this.tell({ rev: this.rev, patch: null, problems: this.problems() });
    }
    return null;
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
    }
    return next;
  }

  /** The file as it is now: a landscape, a fresh one when there's no file, or a stand-in when reading it failed. */
  private read(): Loaded {
    const file = this.o.file;
    const fresh = (problem: LandscapeProblem | null, readOnly = false): Loaded => ({ landscape: emptyLandscape(), problem, readOnly, standIn: false, standInChanges: 0 });
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (isMissing(err)) return fresh(null);
      // an I/O failure says nothing about what the file holds: it's left alone, and nothing is saved over it
      const message = `${file} couldn't be read (${(err as Error).message}). It's left as it is and read again with the next change; until then the layout is an empty stand-in, and changes to it aren't saved.`;
      return { landscape: emptyLandscape(), problem: { kind: "unreadable", message, file, readOnly: true }, readOnly: true, standIn: true, standInChanges: 0 };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return this.setAside(`isn't valid JSON (${(err as Error).message})`, err, fresh);
    }
    const v = versionOf(parsed);
    if (v !== null && v > LANDSCAPE_VERSION) {
      const message = `${file} was written by a newer Mockingbird (landscape version ${v}). It's left as it is, and layout changes aren't saved until this Mockingbird is updated.`;
      this.o.log("landscape", new Error(message));
      return fresh({ kind: "newer", message, file, readOnly: true }, true);
    }
    try {
      return { landscape: parseLandscape(parsed), problem: null, readOnly: false, standIn: false, standInChanges: 0 };
    } catch (err) {
      if (!(err instanceof LandscapeShapeError)) throw err;
      return this.setAside(`isn't a landscape (${err.message})`, err, fresh);
    }
  }

  /** Move a file that isn't a landscape out of the way, so the next save can't overwrite it; when it won't move, nothing is written this run. */
  private setAside(why: string, err: unknown, fresh: (p: LandscapeProblem, readOnly?: boolean) => Loaded): Loaded {
    const file = this.o.file;
    const movedTo = `${file}.bad-${Date.now()}`;
    try {
      fs.renameSync(file, movedTo);
    } catch (moveErr) {
      const message = `${file} ${why} and couldn't be moved aside (${(moveErr as Error).message}). It's left as it is, and layout changes aren't saved until it's fixed or removed.`;
      this.o.log("landscape", new Error(message, { cause: err }));
      return fresh({ kind: "corrupt", message, file, readOnly: true }, true);
    }
    const message = `${file} ${why}. It was moved to ${movedTo}, and the layout starts over.`;
    this.o.log("landscape", new Error(message, { cause: err }));
    return fresh({ kind: "corrupt", message, file, movedTo });
  }
}
