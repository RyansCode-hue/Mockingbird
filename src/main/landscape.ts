import * as fs from "fs";
import {
  LANDSCAPE_VERSION,
  LandscapeShapeError,
  applyPatch,
  emptyLandscape,
  parseLandscape,
  parsePatch,
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
  /** What reading the file found wrong, for the whole run. */
  problem: LandscapeProblem | null;
  /** The file is left as it is: changes stay in memory. */
  readOnly: boolean;
}

/**
 * Where workspaces and areas sit, owned by the main process
 * (docs/landscape-phase1.md). Windows send patches; each is merged in arrival
 * order, sent on to every window, and written soon after: changes made within
 * `saveMs` of the first unsaved one share one atomic write (temp file, then
 * rename), so a long drag is still saved every `saveMs`. Quitting flushes.
 *
 * A file that can't be used is never quietly replaced by an empty layout: a
 * corrupt or unreadable one is moved to `<file>.bad-<time>` first, and the
 * window is told (`problems`, shown as a banner). When it can't be moved, or a
 * newer Mockingbird wrote it, it's left as it is: changes this run are kept in
 * memory and never written.
 *
 * The file is read on first use, not at startup, so a second copy of the app
 * that only hands over to the first never moves it.
 */
export class LandscapeStore {
  private loaded: Loaded | null = null;
  private saveProblem: LandscapeProblem | null = null;
  private rev = 0;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly saveMs: number;

  constructor(private readonly o: LandscapeStoreOptions) {
    this.saveMs = o.saveMs ?? LANDSCAPE_SAVE_MS;
  }

  get(): LandscapeState {
    const l = this.load();
    return { landscape: l.landscape, rev: this.rev, problems: this.problems() };
  }

  /** Merge a window's patch. Throws LandscapeShapeError, changing nothing, when the patch isn't one or would leave an entry incomplete. */
  update(raw: unknown): LandscapeState {
    const l = this.load();
    const patch = parsePatch(raw);
    l.landscape = applyPatch(l.landscape, patch);
    this.rev++;
    // the save is due before the windows hear of it, so a window that can't be told never keeps it from disk
    if (!l.readOnly) {
      this.dirty = true;
      this.timer ??= setTimeout(() => {
        this.timer = null;
        this.saveNow();
      }, this.saveMs);
    }
    this.o.emit({ rev: this.rev, patch, problems: this.problems() });
    return this.get();
  }

  /** Write what hasn't been yet, now (quitting). Throws when it can't be written; the changes stay unsaved and reported. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || !this.loaded || this.loaded.readOnly) return;
    const err = this.save(this.loaded);
    if (err) throw err;
  }

  private problems(): LandscapeProblem[] {
    return [this.loaded?.problem, this.saveProblem].filter((p): p is LandscapeProblem => !!p);
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
      if (changed) this.o.emit({ rev: this.rev, patch: null, problems: this.problems() });
      return err as Error;
    }
    this.dirty = false;
    if (this.saveProblem) {
      this.saveProblem = null;
      this.o.emit({ rev: this.rev, patch: null, problems: this.problems() });
    }
    return null;
  }

  private load(): Loaded {
    if (this.loaded) return this.loaded;
    const file = this.o.file;
    const fresh = (problem: LandscapeProblem | null, readOnly = false): Loaded => (this.loaded = { landscape: emptyLandscape(), problem, readOnly });
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (isMissing(err)) return fresh(null);
      return this.setAside("unreadable", `couldn't be read (${(err as Error).message})`, err, fresh);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return this.setAside("corrupt", `isn't valid JSON (${(err as Error).message})`, err, fresh);
    }
    const v = versionOf(parsed);
    if (v !== null && v > LANDSCAPE_VERSION) {
      const message = `${file} was written by a newer Mockingbird (landscape version ${v}). It's left as it is, and layout changes aren't saved until this Mockingbird is updated.`;
      this.o.log("landscape", new Error(message));
      return fresh({ kind: "newer", message, file, readOnly: true }, true);
    }
    try {
      return (this.loaded = { landscape: parseLandscape(parsed), problem: null, readOnly: false });
    } catch (err) {
      if (!(err instanceof LandscapeShapeError)) throw err;
      return this.setAside("corrupt", `isn't a landscape (${err.message})`, err, fresh);
    }
  }

  /** Move an unusable file out of the way, so the next save can't overwrite it; when it won't move, nothing is written this run. */
  private setAside(kind: "corrupt" | "unreadable", why: string, err: unknown, fresh: (p: LandscapeProblem, readOnly?: boolean) => Loaded): Loaded {
    const file = this.o.file;
    const movedTo = `${file}.bad-${Date.now()}`;
    try {
      fs.renameSync(file, movedTo);
    } catch (moveErr) {
      const message = `${file} ${why} and couldn't be moved aside (${(moveErr as Error).message}). It's left as it is, and layout changes aren't saved until it's fixed or removed.`;
      this.o.log("landscape", new Error(message, { cause: err }));
      return fresh({ kind, message, file, readOnly: true }, true);
    }
    const message = `${file} ${why}. It was moved to ${movedTo}, and the layout starts over.`;
    this.o.log("landscape", new Error(message, { cause: err }));
    return fresh({ kind, message, file, movedTo });
  }
}
