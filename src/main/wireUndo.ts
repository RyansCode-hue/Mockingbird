import { readJsonOrSetAside, writeFileAtomic } from "./fileOps";
import { isObj } from "../shared/landscape";
import { parseWireBook, WIRE_VERSION, type Wire } from "../shared/wires";
import type { SessionInfo } from "../shared/types";

/** A wire and its id, as a forgotten session's wires were. */
export interface HeldWire {
  id: string;
  wire: Wire;
}

/**
 * What a wire's Undo puts back:
 * - removed: the record WireService.remove took, counters included;
 * - repointed: the record before repoint moved its ends, and the ends it moved them to;
 * - forgot: a forgotten session's record (a not-started step's, or a closed or running one's, null when it wasn't kept),
 *   the wires that went with it, and the handoffs made over it (bridges) that its Undo takes away again.
 */
export type WireUndoEntry =
  | { kind: "removed"; wire: Wire; at: number }
  | { kind: "repointed"; before: Wire; after: { from: string; to: string }; at: number }
  | { kind: "forgot"; session: SessionInfo | null; wires: HeldWire[]; bridges: string[]; at: number };

/** The file's own format; one this version can't read is set aside as a corrupt one is. */
const UNDO_VERSION = 1;

/**
 * Wire Undo that outlives a restart, kept beside landscape.json (wire-undo.json) as the wires themselves are kept: the
 * most recent `max` of each kind, as many as were held in memory before. Each change is written whole and at once
 * (writeFileAtomic); a write that fails is logged, and the entry still works until the app quits. A file that isn't
 * JSON is moved aside and logged (readJsonOrSetAside); an entry in it that can't be read is logged and dropped. Nothing
 * in it can stop the app starting. Without a file (a test's), it's held in memory only.
 */
export class WireUndo {
  private entries = new Map<string, WireUndoEntry>();

  constructor(private readonly o: { file?: string; max: number; log: (context: string, err: unknown) => void }) {
    if (o.file) this.load(o.file);
  }

  get(key: string): WireUndoEntry | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Hold `entry` under `key`, the newest of its kind; the oldest of its kind past `max` goes. */
  set(key: string, entry: WireUndoEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    const mine = [...this.entries].filter(([, e]) => e.kind === entry.kind);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - this.o.max))) this.entries.delete(k);
    this.save();
  }

  delete(key: string): void {
    if (this.entries.delete(key)) this.save();
  }

  private save(): void {
    if (!this.o.file) return;
    try {
      writeFileAtomic(this.o.file, JSON.stringify({ v: UNDO_VERSION, entries: Object.fromEntries(this.entries) }));
    } catch (err) {
      this.o.log(`wires: couldn't save what Undo puts back to ${this.o.file}, so it lasts only until Mockingbird quits`, err);
    }
  }

  private load(file: string): void {
    let raw: unknown;
    try {
      raw = readJsonOrSetAside(file, null, "Wire Undo's file");
    } catch (err) {
      this.o.log(`wires: couldn't read ${file}, so nothing removed before this run can be put back`, err);
      return;
    }
    if (raw === null) return;
    if (!isObj(raw) || raw.v !== UNDO_VERSION || !isObj(raw.entries)) {
      this.o.log(`wires: ${file} isn't one this Mockingbird reads, so nothing removed before this run can be put back`, new Error(`its version is ${JSON.stringify(isObj(raw) ? raw.v : raw)}`));
      return;
    }
    for (const [key, e] of Object.entries(raw.entries)) {
      const entry = readEntry(e);
      if (typeof entry === "string") this.o.log(`wires: Undo entry ${JSON.stringify(key)} in ${file} can't be read, and was dropped`, new Error(entry));
      else this.entries.set(key, entry);
    }
  }
}

/** A wire as the book reads one (shared/wires.ts' checks), or why it isn't one. */
function readWire(raw: unknown): Wire | string {
  const r = parseWireBook({ wv: WIRE_VERSION, links: { w: raw }, notes: {} });
  if (r.status !== "ok") return r.problems[0]?.message ?? "it isn't a wire";
  return r.book.links.w ?? r.problems[0]?.message ?? "it isn't a wire";
}

/** A stored entry, checked, or why it can't be used. */
function readEntry(raw: unknown): WireUndoEntry | string {
  if (!isObj(raw) || typeof raw.at !== "number") return "it isn't an Undo entry";
  if (raw.kind === "removed") {
    const wire = readWire(raw.wire);
    return typeof wire === "string" ? wire : { kind: "removed", wire, at: raw.at };
  }
  if (raw.kind === "repointed") {
    const before = readWire(raw.before);
    if (typeof before === "string") return before;
    const after = raw.after;
    if (!isObj(after) || typeof after.from !== "string" || typeof after.to !== "string") return "its moved ends can't be read";
    return { kind: "repointed", before, after: { from: after.from, to: after.to }, at: raw.at };
  }
  if (raw.kind === "forgot") {
    const s = raw.session;
    if (s !== null && (!isObj(s) || typeof s.id !== "string" || !s.id || typeof s.title !== "string" || typeof s.cwd !== "string")) return "its session's record can't be read";
    if (!Array.isArray(raw.wires) || !Array.isArray(raw.bridges) || !raw.bridges.every((b) => typeof b === "string")) return "its wires can't be read";
    const wires: HeldWire[] = [];
    for (const h of raw.wires) {
      if (!isObj(h) || typeof h.id !== "string") return "one of its wires has no id";
      const wire = readWire(h.wire);
      if (typeof wire === "string") return wire;
      wires.push({ id: h.id, wire });
    }
    return { kind: "forgot", session: s as SessionInfo | null, wires, bridges: raw.bridges as string[], at: raw.at };
  }
  return `there's no Undo of kind ${JSON.stringify(raw.kind)}`;
}
