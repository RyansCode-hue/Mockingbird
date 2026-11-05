import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { checkAdd, checkArtifactName, checkLinkUrl, checkNoteText } from "./team/artifactEvents";
import { AgentCopies } from "./team/agentCopies";
import { RepoRefs, type FetchPolicy } from "./team/artifactRepo";
import { baseSummary, blockedReasonOf, cleanName, exportArtifact, exportName, fileContent, normalizeText, type TeamArtifacts } from "./team/artifacts";
import { ArtifactStore, checkAddable, holdsPrivateKey, inside, type Sniff } from "./team/artifactStore";
import { dirInside, isMissing, readRegularFile, writeFileAtomic } from "./fileOps";
import { homeSecretPlace, isSecretFileName } from "./secrets";
import { AREA_SELF, areaOfShelf, areaShelf } from "../shared/areaArtifacts";
import { LOOSE_GROUP } from "../shared/landscape";
import {
  ARTIFACT_ID_RE,
  MAX_ARTIFACTS,
  linkLabel,
  type AddFilesResult,
  type AddRepoRequest,
  type ArtifactAdd,
  type ArtifactAdded,
  type ArtifactContent,
  type ArtifactRecord,
  type ArtifactSummary,
  type RepoResolution,
  type RoomArtifactsView,
  type SaveNoteMode,
  type SaveNoteResult,
  type SecretConfirm,
} from "../shared/team/artifacts";
import type { SessionInfo } from "../shared/types";

/**
 * An area's artifacts on this Mac (docs/landscape.md, Tools): for an area that isn't a team room's, the Artifacts
 * window's files, notes, repo file references and links, kept under `<root>/artifacts/areas/<area>/`:
 *
 *   area.json             { v, key, items }: the records, as a room's are (shared/team/artifacts.ts)
 *   artifacts/blobs/…     the files' bytes, by hash (ArtifactStore, as a room's)
 *
 * `areas/` keeps them apart from `<root>/artifacts/<id>/`, where a session started in the home folder gets its
 * agents' copies (AGENT_ARTIFACTS_DIR). The folder's name comes from the area's key (folderOf): every character that
 * could leave the folder, or name it "." or "..", is escaped, and no folder on the way is followed through a symbolic
 * link (dirInside), so no key reaches outside `areas/`. Room agents are denied the folder by path (HOME_PRIVATE_DATA).
 * Nothing here is shared: a room's area shows the room's artifacts instead (TeamArtifacts), and sharing an area as a
 * room offers to copy these into it (shareTo).
 *
 * A read or write that fails throws, and the window says so; a list that can't be read is an error, never an empty
 * shelf. A records file that isn't JSON is moved aside and said in the shelf's problems.
 */

type FileRecord = Extract<ArtifactRecord, { kind: "file" }>;

export interface AreaArtifactsDeps {
  /** ~/.mockingbird: the area folders are in its `artifacts/`. */
  root: string;
  /** Live sessions (repo references). */
  sessions: () => SessionInfo[];
  knownRepos: () => string[];
  /** Secret files at known places (the ADO PAT file): never added. */
  secretFiles: () => string[];
  /** Folders whose files are never added (the team folder, the room folders). */
  neverAdd: string[];
  /** An area's artifacts changed: the window's `artifacts:changed`, with its shelf. */
  emit: (shelf: string) => void;
  /** The team room area `key` is shared as, or null: a room's area has the room's artifacts, not these. */
  roomOfArea: (key: string) => string | null;
  log: (context: string, err: unknown) => string;
  now?: () => number;
}

/** What area.json holds. */
/** area.json's version: one a newer Mockingbird raised is read but never written (S1's rule for landscape.json). */
export const AREA_FILE_VERSION = 1;

interface AreaFile {
  v: typeof AREA_FILE_VERSION;
  key: string;
  items: unknown[];
}

/**
 * What's held for an area: the records this version reads, and each one's object as the file had it (`raw`, by id);
 * those it can't (`kept`); the file's own keys besides v, key and items (`extra`). A save writes each record over its
 * raw object, and the kept records and the extra keys as they were, so nothing a newer build added is ever dropped.
 * Also why the file mustn't be changed (written by a newer Mockingbird), or null; and whether every record was read
 * (`complete`), which a merge needs before it lets the old folder go.
 */
interface Held {
  items: ArtifactRecord[];
  raw: ReadonlyMap<string, Record<string, unknown>>;
  kept: unknown[];
  extra: Record<string, unknown>;
  readOnly: string | null;
  complete: boolean;
}

const EMPTY: Held = { items: [], raw: new Map(), kept: [], extra: {}, readOnly: null, complete: true };

/** The largest area.json (or a copy set aside) ever read: 500 notes of 60,000 characters, escaped, and their fields. */
const MAX_AREA_FILE = 256 * 1024 * 1024;

/** Under the root (~/.mockingbird): the areas' folders. */
export const AREAS_DIR = path.join("artifacts", "areas");
const KEY_IN_NOTE: SecretConfirm = { needsConfirm: "secret", reason: "It holds a private key. Agents never read it" };
const MAX_KEY = 400;
const MAX_FOLDER = 160;

/**
 * The folder name area `key`'s artifacts are kept under: the key with every byte other than letters, digits, "-", "_"
 * and inner spaces escaped (%XX of its UTF-8), so "." and ".." and anything with a slash can't be one. The disk is
 * case-insensitive, so a key with capitals ends in a hash of the whole key ("Docs" and "docs" are two folders), as a
 * long key does after its start. Throws for a key that can't be an area's.
 */
export function folderOf(key: string): string {
  if (typeof key !== "string" || !key || key === LOOSE_GROUP || key.length > MAX_KEY) throw new Error(`“${String(key).slice(0, 80)}” isn't an area`);
  const escaped = [...Buffer.from(key, "utf8")]
    .map((b) => (/[A-Za-z0-9 _-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`))
    .join("")
    .replace(/^ +| +$/g, (m) => "%20".repeat(m.length));
  const hash = () => crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (escaped.length > MAX_FOLDER) return `${escaped.slice(0, 100)}~${hash()}`;
  return /[A-Z]/.test(key) ? `${escaped}~${hash()}` : escaped;
}

/** Throws when anything inside `dir` is a symbolic link: an area's artifacts are never read or written through one. */
function noLinksInside(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`${p} is a symbolic link: an area's artifacts are never read or written through one`);
    if (e.isDirectory()) noLinksInside(p);
  }
}

/**
 * Every blob hash and artifact id area `dir`'s files may name: the records this version reads, and anything in
 * area.json as it is on disk (records it keeps but can't read, fields of those it reads that it doesn't know, keys of
 * the file's own) and in the copies of it set aside (`area.json.bad-*`). They're found by their shape anywhere in the
 * text, so what this version can't parse still keeps its bytes (keeping one too many is harmless; sweeping one is a
 * loss). Throws when one of the files can't be read: never through a link, never past MAX_AREA_FILE.
 */
function liveRefs(dir: string, held: Held): { shas: Set<string>; ids: Set<string> } {
  const shas = new Set(held.items.flatMap((a) => (a.kind === "file" ? [a.sha256] : [])));
  const ids = new Set(held.items.map((a) => a.id));
  const texts: string[] = [];
  for (const n of fs.readdirSync(dir)) {
    if (n !== "area.json" && !n.startsWith("area.json.bad-")) continue;
    const f = readRegularFile(path.join(dir, n), dir, MAX_AREA_FILE);
    if (f) texts.push(f.text);
  }
  for (const t of texts) {
    for (const m of t.matchAll(/[0-9a-f]{64}/g)) shas.add(m[0]);
    for (const m of t.matchAll(/"([A-Za-z0-9_-]{22})"/g)) ids.add(m[1]);
  }
  return { shas, ids };
}

/**
 * What in `src`, an area's folder a merge took the records of, isn't area.json, its store's own folders and files or
 * a blob of `shas` (the records taken): what removing the folder would lose.
 */
function leftIn(src: string, shas: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const n of fs.readdirSync(src)) {
    if (n === "area.json") continue;
    if (n !== "artifacts") {
      out.push(n);
      continue;
    }
    const store = path.join(src, n);
    for (const m of fs.readdirSync(store)) {
      if (m === "blobs") out.push(...fs.readdirSync(path.join(store, m)).filter((b) => !shas.has(b)).map((b) => `artifacts/blobs/${b}`));
      else if (!["partial", "tmp", "view", "sniff.json"].includes(m)) out.push(`artifacts/${m}`);
    }
  }
  return out;
}

/**
 * A store's folder, and the folders and files of its own in it, as they must be (none a link), checked before each
 * use: a link planted at one since the area's folder was first walked is never followed. Missing ones are fine.
 */
function checkStore(store: ArtifactStore): void {
  for (const [name, folder] of [["", true], ["blobs", true], ["partial", true], ["tmp", true], ["view", true], ["sniff.json", false]] as const) {
    const at = name ? path.join(store.dir, name) : store.dir;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(at);
    } catch (err) {
      if (!isMissing(err)) throw err;
      if (!name) return;
      continue;
    }
    if (st.isSymbolicLink()) throw new Error(`${at} is a symbolic link: an area's artifacts are never read or written through one`);
    if (folder ? !st.isDirectory() : !st.isFile()) throw new Error(`${at} isn't a ${folder ? "folder" : "file"}`);
  }
}

/** Up to `length` bytes of the file at `file` from its start, opened without following a link (O_NOFOLLOW). */
function readNoFollow(file: string, length: number): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} isn't a file`);
    const buf = Buffer.alloc(length);
    return buf.subarray(0, fs.readSync(fd, buf, 0, length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether a merge's record and the target's of the same id are one artifact as it is now (same rev, name and bytes). */
function sameRecord(a: ArtifactRecord, b: ArtifactRecord): boolean {
  return a.kind === b.kind && a.rev === b.rev && a.name === b.name && (a.kind !== "file" || (b.kind === "file" && a.sha256 === b.sha256 && a.size === b.size));
}

/** What sharing an area's artifacts into a room adds them with: the room's own adds, and their checks (TeamArtifacts). */
export interface RoomAdds {
  addBytes(roomId: string, name: string, bytes: Uint8Array, confirmSecret?: boolean): Promise<AddFilesResult>;
  newNote(roomId: string, name: string, text: string, confirmSecret?: boolean): ArtifactAdded | SecretConfirm;
  addLink(roomId: string, url: string, title: string): ArtifactAdded;
  addRepoRecord(roomId: string, body: Extract<ArtifactAdd, { kind: "repo" }>): ArtifactAdded;
}

let active: AreaArtifacts | null = null;

/** The running area artifacts, for the agents' tools (artifactTools.ts); null before they start. */
export const runningAreaArtifacts = (): AreaArtifacts | null => active;

export class AreaArtifacts {
  readonly repos: RepoRefs;
  private readonly copies: AgentCopies;
  private readonly files = new Map<string, Held>();
  /** The areas whose folders were checked for links inside this run. */
  private readonly linkFree = new Set<string>();
  private readonly problems = new Map<string, string[]>();
  private readonly stores = new Map<string, ArtifactStore>();
  /** Each area's renames so far in this run: an add that waited across one is refused rather than kept in the old folder. */
  private readonly gens = new Map<string, number>();
  /** The areas whose tmp/ (adds cut short by quitting) was cleared in this run. */
  private readonly tmpCleared = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly d: AreaArtifactsDeps) {
    this.now = d.now ?? Date.now;
    this.repos = new RepoRefs({ sessions: d.sessions, knownRepos: d.knownRepos, log: d.log });
    this.copies = new AgentCopies(path.join(d.root, "artifacts", "area-agent-copies.json"), d.log, "area artifacts", "area");
  }

  /** Agents' tools reach these from now on. */
  start(): void {
    active = this;
  }

  stop(): void {
    if (active === this) active = null;
  }

  roomOfArea(key: string): string | null {
    return this.d.roomOfArea(key);
  }

  /** Log a failure the agents' tools met; returns the message logged. */
  report(context: string, err: unknown): string {
    return this.d.log(context, err);
  }

  // ---- where they're kept ---------------------------------------------------------------------------

  /**
   * Area `key`'s folder: made when `create`, else null while there's none. Throws for a key that isn't an area's, or a
   * link: on the way to the folder (checked every time), or anywhere inside it (checked the first time it's opened in
   * a run, before anything in it is read or written).
   */
  private dir(key: string, create: boolean): string | null {
    const dir = dirInside(this.d.root, path.join(AREAS_DIR, folderOf(key)), create ? 0o700 : undefined);
    const top = path.join(this.d.root, AREAS_DIR);
    if (dir && !inside(fs.realpathSync(top), fs.realpathSync(dir))) throw new Error(`${dir} isn't inside ${top}`);
    if (dir && !this.linkFree.has(key)) {
      noLinksInside(dir);
      this.linkFree.add(key);
    }
    return dir;
  }

  /**
   * Area `key`'s store, checked again each time it's used: the way to its folder and that it's inside the areas folder
   * (dir), and its own folders and files (checkStore). Its folder is made only when `create` (an add, a merge into
   * it): reading an area that has none finds nothing in it, and never makes one.
   */
  private store(key: string, create = false): ArtifactStore {
    const dir = this.dir(key, create) ?? path.join(this.d.root, AREAS_DIR, folderOf(key));
    let s = this.stores.get(key);
    if (!s || s.dir !== path.join(dir, "artifacts")) this.stores.set(key, (s = new ArtifactStore(dir)));
    s.readOnly = !!this.file(key).readOnly;
    checkStore(s);
    return s;
  }

  /**
   * Area `key`'s records, read once and kept. Throws when they can't be read; a file that isn't one is moved aside and
   * said. Its first read in a run clears what adds cut short by quitting left in its tmp/, unless it can't be changed;
   * only the first, folder or not: a read again (after a rename) mustn't clear an add of this run's still in it.
   */
  private file(key: string): Held {
    const held = this.files.get(key);
    if (held) return held;
    const dir = this.dir(key, false);
    const f = dir ? this.readFile(key, dir, key) : EMPTY;
    this.files.set(key, f);
    const first = !this.tmpCleared.has(key);
    this.tmpCleared.add(key);
    if (dir && !f.readOnly && first) {
      try {
        const store = new ArtifactStore(dir);
        checkStore(store);
        store.clearTmp();
      } catch (err) {
        this.said(key, "tmp", `What unfinished adds left in its folder couldn't be cleared: ${(err as Error).message}`);
      }
    }
    return f;
  }

  private gen(key: string): number {
    return this.gens.get(key) ?? 0;
  }

  /**
   * Refuses a change to area `key` before anything of it is written: when its file can't be changed (readOnly), or its
   * folder, its store or its area.json isn't what it must be (a link planted since it was opened). Returns its folder.
   */
  private writable(key: string): string {
    const { readOnly } = this.file(key);
    if (readOnly) throw new Error(readOnly);
    const dir = this.dir(key, true)!;
    this.store(key, true);
    const at = path.join(dir, "area.json");
    // writeFileAtomic writes where a link points: one planted at area.json since the folder was checked is refused
    try {
      if (!fs.lstatSync(at).isFile()) throw new Error(`${at} isn't a regular file (a symbolic link or a folder): an area's artifacts are never written through one`);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    return dir;
  }

  /**
   * The area.json in `dir` (area `key`'s), what's wrong with it said on area `sayOn`'s shelf, under problems tagged
   * `tag` (a merge's source, apart from the shelf's own). Never read through a link. Throws when it can't be read.
   */
  private readFile(key: string, dir: string, sayOn: string, tag = ""): Held {
    const at = path.join(dir, "area.json");
    let text: string | null;
    try {
      text = readRegularFile(at, dir, MAX_AREA_FILE)?.text ?? null;
    } catch (err) {
      throw new Error(`${at} couldn't be read: ${(err as Error).message}`);
    }
    return text === null ? EMPTY : this.parse(key, at, text, sayOn, tag);
  }

  /**
   * A file at `at` this version can't read as area.json (`why`), moved aside to `<at>.bad-<ts>` and said: the area
   * starts over. One that can't be moved is left as it is and the area can't be changed, so nothing writes over it.
   */
  private unreadable(at: string, why: string, sayOn: string, tag: string): Held {
    const moved = `${at}.bad-${this.now()}`;
    try {
      fs.renameSync(at, moved);
    } catch (err) {
      const text = `${at} ${why}, and couldn't be moved aside (${(err as Error).message}): it's left as it is, and this area's artifacts can't be changed until it's moved or fixed`;
      this.said(sayOn, `${tag}file`, text);
      return { ...EMPTY, readOnly: text, complete: false };
    }
    this.said(sayOn, `${tag}file`, `${at} ${why}, moved to ${moved}: the area's artifacts start over`);
    return { ...EMPTY, complete: false };
  }

  /**
   * The records in area.json's text. Its version is read first, as S1 reads landscape.json: one a newer Mockingbird
   * wrote is read as far as it can be and never written, whatever its shape. A file that isn't one (not JSON, no
   * version, no list) is moved aside and said, and the area starts over. A record this version can't read is said and
   * kept, to be written back as it was.
   */
  private parse(key: string, at: string, text: string, sayOn = key, tag = ""): Held {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch (err) {
      return this.unreadable(at, `wasn't readable (${(err as Error).message})`, sayOn, tag);
    }
    const f = v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<AreaFile>) : null;
    const version = f && typeof f.v === "number" && Number.isInteger(f.v) && f.v >= 1 ? f.v : null;
    const readOnly = version !== null && version > AREA_FILE_VERSION ? `${at} was written by a newer Mockingbird (its version ${version}, this one reads ${AREA_FILE_VERSION}): update Mockingbird to change this area's artifacts` : null;
    if (readOnly && !Array.isArray(f!.items)) {
      this.said(sayOn, `${tag}version`, readOnly);
      return { ...EMPTY, readOnly, complete: false };
    }
    if (!f || version === null || !Array.isArray(f.items)) return this.unreadable(at, `isn't an area's artifacts list (${version === null ? "no version" : "no list of artifacts"})`, sayOn, tag);
    const items: ArtifactRecord[] = [];
    const raw = new Map<string, Record<string, unknown>>();
    const kept: unknown[] = [];
    const bad: string[] = [];
    const extra = Object.fromEntries(Object.entries(f).filter(([k]) => k !== "v" && k !== "key" && k !== "items"));
    for (const [i, x] of (f.items as unknown[]).entries()) {
      try {
        const r = x as Partial<ArtifactRecord>;
        if (typeof r.id !== "string" || !ARTIFACT_ID_RE.test(r.id)) throw new Error("its id isn't an artifact's");
        if (typeof r.addedAt !== "number" || typeof r.rev !== "string") throw new Error("it has no addedAt or rev");
        items.push({ ...checkAdd(x), id: r.id, addedBy: AREA_SELF, addedAt: r.addedAt, lamport: 0, rev: r.rev, ...(typeof r.updatedAt === "number" ? { updatedBy: AREA_SELF, updatedAt: r.updatedAt } : {}) });
        raw.set(r.id, x as Record<string, unknown>);
      } catch (err) {
        kept.push(x);
        bad.push(`#${i + 1}: ${(err as Error).message}`);
      }
    }
    this.said(sayOn, `${tag}version`, readOnly);
    this.said(sayOn, `${tag}records`, bad.length ? `${bad.length} of the artifacts in ${at} can't be read here and aren't shown; they're kept in the file as they are (${bad.join("; ")})` : null);
    return { items, raw, kept, extra, readOnly, complete: !bad.length && !readOnly };
  }

  /**
   * Write area `key`'s records, each over its object as the file had it (`raw`, or `moreRaw` for records from
   * elsewhere: a merge's), with those this version can't read and the file's own keys it doesn't know written back as
   * they were. Refused for a file a newer Mockingbird wrote. Throws when they can't be written; what's held in memory
   * is then what was there before.
   */
  private save(key: string, items: ArtifactRecord[], moreRaw?: ReadonlyMap<string, Record<string, unknown>>): void {
    const held = this.file(key);
    const at = path.join(this.writable(key), "area.json");
    const written = items.map((a) => ({ ...(held.raw.get(a.id) ?? moreRaw?.get(a.id) ?? {}), ...a }));
    const f = { ...held.extra, v: AREA_FILE_VERSION, key, items: [...written, ...held.kept] } satisfies AreaFile;
    writeFileAtomic(at, JSON.stringify(f, null, 2));
    this.files.set(key, { ...held, items, raw: new Map(items.map((a, i) => [a.id, written[i]])) });
    this.changed(key);
  }

  private said(key: string, what: string, text: string | null): void {
    const list = (this.problems.get(key) ?? []).filter((p) => !p.startsWith(`[${what}] `));
    if (text) {
      this.d.log(`area artifacts: ${key}`, text);
      list.push(`[${what}] ${text}`);
    }
    this.problems.set(key, list);
  }

  private changed(key: string): void {
    try {
      this.d.emit(areaShelf(key));
    } catch (err) {
      this.d.log(`area artifacts: telling the window about ${key}`, err);
    }
  }

  private item(key: string, id: string): ArtifactRecord {
    const a = this.file(key).items.find((x) => x.id === id);
    if (!a) throw new Error("That artifact isn't in the area any more");
    return a;
  }

  private add(key: string, body: ArtifactAdd, warnings: string[] = []): ArtifactAdded {
    const items = this.file(key).items;
    if (items.length >= MAX_ARTIFACTS) throw new Error(`An area keeps at most ${MAX_ARTIFACTS} artifacts`);
    const id = crypto.randomBytes(16).toString("base64url");
    const rec: ArtifactRecord = { ...checkAdd(body), id, addedBy: AREA_SELF, addedAt: this.now(), lamport: 0, rev: id };
    this.save(key, [...items, rec]);
    return { id, name: rec.name, warnings };
  }

  // ---- the window -------------------------------------------------------------------------------

  async list(key: string): Promise<RoomArtifactsView> {
    const f = this.file(key);
    const items: ArtifactSummary[] = [];
    for (const a of [...f.items].reverse()) items.push(await this.summary(key, a));
    return {
      roomId: areaShelf(key),
      self: AREA_SELF,
      items,
      notices: [],
      problems: (this.problems.get(key) ?? []).map((p) => p.replace(/^\[[^\]]+\] /, "")),
      ...(f.readOnly ? { readOnly: f.readOnly } : {}),
    };
  }

  private async summary(key: string, a: ArtifactRecord): Promise<ArtifactSummary> {
    const s = baseSummary(a, () => "You", this.blockedReason(key, a));
    if (a.kind !== "file") return s;
    let sniff: Sniff | null;
    try {
      sniff = await this.sniffOf(key, a);
    } catch (err) {
      return { ...s, local: { state: "failed", problem: this.d.log(`area artifacts: ${a.name} in ${key}`, err) } };
    }
    return { ...s, local: sniff ? { state: "present", view: sniff.view, mime: sniff.mime } : { state: "failed", problem: `${a.name}'s file isn't in this area's folder any more` } };
  }

  async addFiles(key: string, paths: string[], confirmSecret = false): Promise<AddFilesResult> {
    if (!Array.isArray(paths)) throw new Error("No files to add");
    const out: AddFilesResult = { added: [], refused: [] };
    for (const p of paths) {
      const name = cleanName(path.basename(String(p ?? "")), "file");
      try {
        const { real } = checkAddable(String(p), { never: [...this.d.neverAdd, path.join(this.d.root, AREAS_DIR)], secretFiles: this.d.secretFiles() });
        await this.ingest(key, name, { file: real }, confirmSecret, out, homeSecretPlace(real));
      } catch (err) {
        out.refused.push({ name, reason: (err as Error).message });
      }
    }
    for (const r of out.refused) if (!r.needsConfirm) this.d.log(`area artifacts: ${r.name} wasn't added to ${key}`, r.reason);
    return out;
  }

  async addBytes(key: string, rawName: string, bytes: Uint8Array | ArrayBuffer, confirmSecret = false): Promise<AddFilesResult> {
    const name = cleanName(String(rawName ?? ""), "pasted");
    const out: AddFilesResult = { added: [], refused: [] };
    try {
      const data = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
      if (!data) throw new Error("No bytes to add");
      await this.ingest(key, name, { bytes: data }, confirmSecret, out);
    } catch (err) {
      out.refused.push({ name, reason: (err as Error).message });
      this.d.log(`area artifacts: ${name} wasn't added to ${key}`, err);
    }
    return out;
  }

  private async ingest(key: string, name: string, source: { file: string } | { bytes: Uint8Array }, confirmSecret: boolean, out: AddFilesResult, credentials: string | null = null): Promise<void> {
    this.writable(key);
    const gen = this.gen(key);
    const ing = await this.store(key, true).ingest(source, name);
    if (this.gen(key) !== gen) {
      ing.drop();
      throw new Error(`${key} was renamed while ${name} was being added, so it wasn't: add it again where it is now`);
    }
    const secret = isSecretFileName(name)
      ? `${name} is named like a secret file`
      : credentials
        ? `${name} is one of this Mac's credential files (${credentials})`
        : ing.sniff.privateKey
          ? `${name} holds a private key`
          : null;
    if (secret && !confirmSecret) {
      ing.drop();
      out.refused.push({ name, reason: `${secret}. Agents never read it.`, needsConfirm: "secret" });
      return;
    }
    // a link planted while it was read in is refused before its bytes are kept
    try {
      this.writable(key);
    } catch (err) {
      ing.drop();
      throw err;
    }
    ing.keep();
    const same = this.file(key).items.find((a) => a.kind === "file" && a.sha256 === ing.sha256);
    try {
      out.added.push(this.add(key, { kind: "file", name, size: ing.size, sha256: ing.sha256, mime: ing.sniff.mime, ...(credentials ? { wasSecret: true as const } : {}) }, same ? [`The same file is already here as ${same.name}`] : []));
    } catch (err) {
      try {
        this.gc(key);
      } catch (gcErr) {
        this.d.log(`area artifacts: cleaning up after ${name} wasn't added to ${key}`, gcErr);
      }
      throw err;
    }
  }

  newNote(key: string, rawName: string, rawText: string, confirmSecret = false): ArtifactAdded | SecretConfirm {
    if (!confirmSecret && holdsPrivateKey(normalizeText(rawText))) return KEY_IN_NOTE;
    return this.addNote(key, rawName, rawText);
  }

  addNote(key: string, rawName: string, rawText: string, o: { wasSecret?: boolean } = {}): ArtifactAdded {
    const name = checkArtifactName(cleanName(String(rawName ?? ""), "Note"));
    return this.add(key, { kind: "note", name, text: this.noteText(rawText), ...(o.wasSecret ? { wasSecret: true as const } : {}) });
  }

  addLink(key: string, rawUrl: string, title: string): ArtifactAdded {
    const url = String(rawUrl ?? "").trim();
    try {
      checkLinkUrl(url);
    } catch (err) {
      throw new Error(`That link can't be added: ${(err as Error).message.replace(/^url /, "it ")}`);
    }
    const l = linkLabel(url);
    return this.add(key, { kind: "link", name: checkArtifactName(cleanName(String(title ?? ""), l?.label ?? l?.host ?? "Link")), url });
  }

  async addRepo(key: string, req: AddRepoRequest): Promise<ArtifactAdded> {
    const session = this.d.sessions().find((s) => s.id === req?.sessionId && s.status !== "dead");
    if (!session) throw new Error("That session isn't running here");
    const { body, warnings } = await this.repos.reference(session, req);
    return this.add(key, body, warnings);
  }

  rename(key: string, id: string, rawName: string): null {
    const items = this.file(key).items;
    const a = this.item(key, id);
    const name = checkArtifactName(cleanName(String(rawName ?? ""), a.name));
    if (name !== a.name) this.save(key, items.map((x) => (x.id === id ? { ...x, name, updatedBy: AREA_SELF, updatedAt: this.now() } : x)));
    return null;
  }

  remove(key: string, id: string): null {
    const items = this.file(key).items;
    this.item(key, id);
    this.save(key, items.filter((x) => x.id !== id));
    this.gc(key);
    return null;
  }

  /** A note's new text: "save" from a revision that's since changed (another window's edit) is said, as a room's is. */
  saveNote(key: string, id: string, rawText: string, base: string, mode: SaveNoteMode, confirmSecret = false): SaveNoteResult {
    const a = this.item(key, id);
    if (a.kind !== "note") throw new Error("Only notes are edited here");
    const text = this.noteText(rawText);
    const asks = !confirmSecret && holdsPrivateKey(text) && (mode === "copy" || !holdsPrivateKey(a.text));
    if (asks && !(mode === "save" && a.rev !== base)) return KEY_IN_NOTE;
    if (mode === "copy") return { copy: this.addNote(key, `${a.name.slice(0, 190)} (copy)`, text, { wasSecret: !!a.wasSecret || isSecretFileName(a.name) }).id };
    if (mode !== "save" && mode !== "overwrite") throw new Error(`Unknown save: ${mode}`);
    if (mode === "save" && a.rev !== base) return { stale: { rev: a.rev, byName: "You", at: a.updatedAt ?? a.addedAt } };
    if (text === a.text) return { rev: a.rev };
    const rev = crypto.randomBytes(16).toString("base64url");
    this.save(key, this.file(key).items.map((x) => (x.id === id ? { ...x, text, rev, updatedBy: AREA_SELF, updatedAt: this.now() } : x)));
    return { rev };
  }

  private noteText(raw: string): string {
    try {
      return checkNoteText(normalizeText(raw));
    } catch (err) {
      throw new Error(`The note can't be saved: its ${(err as Error).message}`);
    }
  }

  async read(key: string, id: string): Promise<ArtifactContent> {
    const a = this.item(key, id);
    switch (a.kind) {
      case "note":
        return { view: "note", text: a.text, rev: a.rev };
      case "link":
        return { view: "link", url: a.url };
      case "repo":
        throw new Error("A repo reference opens in its repository (resolveRepo)");
    }
    const sniff = await this.sniffOf(key, a);
    if (!sniff) return { view: "missing", local: { state: "failed", problem: `${a.name}'s file isn't in this area's folder any more` } };
    const store = this.store(key);
    this.blobAt(store, a);
    return fileContent(store, a, sniff);
  }

  /** An area's files are all on this Mac: there's nothing to fetch. */
  download(key: string, id: string): null {
    if (this.item(key, id).kind !== "file") throw new Error("Only files are downloaded");
    return null;
  }

  async resolveRepo(key: string, id: string, preferSessionId: string | null, fetch: FetchPolicy = "always"): Promise<RepoResolution> {
    const a = this.item(key, id);
    if (a.kind !== "repo") throw new Error("That isn't a repo reference");
    return this.repos.resolve(a, { prefer: preferSessionId, groupKey: key, fetch });
  }

  async viewFile(key: string, id: string): Promise<string> {
    const a = this.item(key, id);
    if (a.kind !== "file") throw new Error("Only files open in Quick Look or Finder");
    const sniff = await this.sniffOf(key, a);
    if (!sniff) throw new Error(`${a.name}'s file isn't in this area's folder any more`);
    const store = this.store(key);
    if (store.readOnly) throw new Error(`${a.name} can't open in Quick Look or Finder here: they need a copy kept in the area's folder, and ${this.file(key).readOnly}`);
    this.blobAt(store, a);
    // view/<id> and the copy in it, checked as the store's own folders are: the copy is opened by its path
    const folder = path.join(store.dir, "view", a.id);
    for (const at of [folder, ...(fs.existsSync(folder) ? fs.readdirSync(folder).map((n) => path.join(folder, n)) : [])]) {
      const st = fs.lstatSync(at, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) throw new Error(`${at} is a symbolic link: an area's artifacts are never opened through one`);
    }
    const copy = await store.viewCopy(a.id, a.sha256, a.name, sniff);
    if (copy.warning) this.said(key, `quarantine ${a.id}`, copy.warning);
    return copy.path;
  }

  saveName(key: string, id: string): string {
    return exportName(this.item(key, id));
  }

  async exportTo(key: string, id: string, dest: string): Promise<string | null> {
    const a = this.item(key, id);
    if (a.kind === "file") this.blobAt(this.store(key), a);
    const warning = await exportArtifact(this.store(key), a, dest);
    if (warning) this.d.log("area artifacts: Save as", warning);
    return warning;
  }

  /** An area's shelf has no notices (they're about teammates' crossing edits). */
  dismissNotice(): null {
    return null;
  }

  // ---- for agents (artifactTools.ts) ----------------------------------------------------------------

  /** Area `key`'s artifacts, oldest first; none when it has none on this Mac. Throws when they can't be read. */
  records(key: string): readonly ArtifactRecord[] {
    return this.file(key).items;
  }

  /** Whether area `key` has any artifacts here, without making its folder; false when they can't be read (logged). */
  has(key: string): boolean {
    try {
      return this.file(key).items.length > 0;
    } catch (err) {
      this.d.log(`area artifacts: reading ${key}'s`, err);
      return false;
    }
  }

  blockedReason(key: string, a: ArtifactRecord): string | null {
    return blockedReasonOf(this.store(key), a);
  }

  async sniffOf(key: string, a: FileRecord): Promise<Sniff | null> {
    const store = this.store(key);
    if (store.blobSize(a.sha256) !== a.size) return null;
    this.blobAt(store, a);
    return store.sniffOf(a.sha256, a.name);
  }

  readText(key: string, a: FileRecord, max: number): { text: string; truncated: boolean } {
    const buf = readNoFollow(this.blobAt(this.store(key), a), Math.min(a.size, max));
    return { text: new TextDecoder("utf-8").decode(buf), truncated: a.size > max };
  }

  async copyForAgent(key: string, a: FileRecord, root: string, fileName: string): Promise<string> {
    this.blobAt(this.store(key), a);
    const { file, warning } = await this.copies.copy(areaShelf(key), this.store(key), a, root, fileName);
    if (warning) this.said(key, `quarantine-agent ${a.id}`, warning);
    return file;
  }

  // ---- the area changing -------------------------------------------------------------------------

  /**
   * Group `from` was renamed to `to`: its artifacts go with it. Its folder is renamed; renaming onto an area that has
   * artifacts already merges them in (files by hash, records appended). A failure is logged, said on both shelves and
   * thrown: the rename itself is done by then, so the caller logs it rather than refusing.
   */
  areaRenamed(from: string, to: string): void {
    if (from === to) return;
    // an add to either that's still reading its file in is refused when it's done (ingest)
    for (const k of [from, to]) this.gens.set(k, this.gen(k) + 1);
    let src: string | null;
    try {
      src = this.dir(from, false);
    } catch (err) {
      throw new Error(`${from}'s artifacts couldn't be found to move: ${(err as Error).message}`);
    }
    if (!src) return;
    this.files.delete(from);
    this.stores.delete(from);
    this.linkFree.delete(from);
    // where from's artifacts are: src until its folder is renamed
    let at = src;
    const fail = (err: unknown) => {
      const why = (err as Error).message;
      const text =
        at === src
          ? `${from}'s artifacts couldn't move to ${to}: ${why}. They're still in ${src}`
          : `${from}'s artifacts moved to ${at} with ${to}, but its area.json couldn't be written with the new name (${why}): they're all there, read as ${to}'s`;
      this.said(to, "rename", text);
      this.changed(to);
      return new Error(text);
    };
    const relabel = () => {
      const p = this.copies.rename(areaShelf(from), areaShelf(to));
      if (p) this.said(to, "copies", p);
    };
    try {
      const dest = this.dir(to, false);
      if (!dest) {
        const moved = path.join(path.dirname(src), folderOf(to));
        fs.renameSync(src, moved);
        at = moved;
        this.files.delete(to);
        this.stores.delete(to);
        this.linkFree.delete(to);
        // agents' copies follow the folder, so they're to's even when the save below fails
        relabel();
        // its key written anew; a newer Mockingbird's file is left as it is
        const f = this.file(to);
        if (!f.readOnly && (f.items.length || f.kept.length)) this.save(to, f.items);
      } else {
        this.merge(from, src, to);
        relabel();
      }
    } catch (err) {
      throw fail(err);
    }
    this.changed(from);
    this.changed(to);
  }

  /**
   * `from`'s artifacts (in `src`) into `to`'s, which has some already. What can be read comes along, a file whose
   * bytes are missing as a record without them (said, one by one). `src` goes only once every record was read, every
   * file copied, and it holds nothing else (a set-aside copy, a blob no record names); otherwise it's kept as it is,
   * under the old name, and said on `to` (the problems of its file apart from `to`'s own), so nothing is lost.
   */
  private merge(from: string, src: string, to: string): void {
    this.files.delete(from);
    // a target this build can't change, or one not as it must be: nothing is copied into it
    this.writable(to);
    const tag = `from ${from}: `;
    const theirs = this.readFile(from, src, to, tag);
    const old = new ArtifactStore(src);
    checkStore(old);
    const store = this.store(to, true);
    store.ensure();
    // a record of the same id here already comes along only as the same artifact; another version of it stays in src
    const mine = this.file(to).items;
    const taken: ArtifactRecord[] = [];
    const same: ArtifactRecord[] = [];
    const clash: string[] = [];
    for (const a of theirs.items) {
      const m = mine.find((x) => x.id === a.id);
      if (!m) taken.push(a);
      else if (sameRecord(a, m)) same.push(a);
      else clash.push(a.name);
    }
    const missing: string[] = [];
    const failed: string[] = [];
    for (const a of [...taken, ...same]) {
      if (a.kind !== "file" || store.blobSize(a.sha256) === a.size) continue;
      try {
        fs.copyFileSync(this.blobAt(old, a), store.blobPath(a.sha256), fs.constants.COPYFILE_FICLONE);
      } catch (err) {
        if (isMissing(err)) missing.push(a.name);
        else failed.push(`${a.name}: ${(err as Error).message}`);
      }
    }
    this.save(to, [...mine, ...taken], theirs.raw);
    this.said(to, `${tag}missing`, missing.length ? `${missing.length} of ${from}'s files weren't in its folder, so they came along without their bytes: ${missing.join(", ")}` : null);
    const unknownKeys = Object.keys(theirs.extra);
    const whole = theirs.complete && !failed.length && !clash.length && !unknownKeys.length;
    const left = whole ? leftIn(src, new Set([...taken, ...same].flatMap((a) => (a.kind === "file" ? [a.sha256] : [])))) : [];
    if (whole && !left.length) {
      this.said(to, `${tag}merge`, null);
      return void fs.rmSync(src, { recursive: true, force: true });
    }
    const why = failed.length
      ? ` (${failed.join("; ")})`
      : clash.length
        ? ` (${clash.length === 1 ? "one of its artifacts is" : `${clash.length} of its artifacts are`} here already as another version: ${clash.join(", ")})`
        : unknownKeys.length
          ? ` (its area.json also holds what this version doesn't read: ${unknownKeys.join(", ")})`
          : left.length
            ? ` (its folder also holds ${left.join(", ")})`
            : "";
    this.said(to, `${tag}merge`, `Not everything of ${from}'s could come along${why}: what could be read is here, and ${src} is kept as it was, under the old name`);
  }

  /**
   * The blob of file record `a` in `store`, checked just before it's read or copied: the store's folder, its blobs
   * folder and the blob are what they look like, none a symbolic link (one planted since the area's folder was first
   * checked would otherwise be followed; the way to the store is checked by store()). Throws when one is, and says
   * the file isn't here when it isn't (an ENOENT still, for a merge to tell apart). Node has no openat, so a link
   * swapped in between this check and a copy isn't caught; one there already always is, and a read of the blob here
   * opens it without following one (readNoFollow).
   */
  private blobAt(store: ArtifactStore, a: FileRecord): string {
    const blob = store.blobPath(a.sha256);
    for (const [at, dir] of [[store.dir, true], [path.dirname(blob), true], [blob, false]] as const) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(at);
      } catch (err) {
        if (isMissing(err)) throw Object.assign(new Error(`${a.name}'s file isn't in this area's folder any more`), { code: "ENOENT" });
        throw err;
      }
      if (st.isSymbolicLink()) throw new Error(`${at} is a symbolic link: an area's artifacts are never read through one`);
      if (dir ? !st.isDirectory() : !st.isFile()) throw new Error(`${at} isn't a ${dir ? "folder" : "file"}`);
    }
    return blob;
  }

  /**
   * Delete what nothing of area `key` uses (blobs, view copies) and agents' copies of what's gone or secret. What it
   * keeps but can't read counts as used: the records this version can't read, and the copies of area.json set aside.
   * Nothing is cleaned up on a shelf that can't be changed (a newer Mockingbird's file, or one left in place).
   */
  gc(key: string): void {
    const held = this.file(key);
    if (held.readOnly) return;
    const dir = this.dir(key, false);
    if (!dir) return;
    const problems: string[] = [];
    let live: { shas: Set<string>; ids: Set<string> } | null = null;
    try {
      live = liveRefs(dir, held);
    } catch (err) {
      problems.push(`nothing was cleaned up, since what's kept couldn't all be read: ${(err as Error).message}`);
    }
    if (live) {
      const { ids } = live;
      const store = this.store(key);
      if (fs.existsSync(store.dir)) problems.push(...store.gc(live.shas, ids));
      // an agent's copy goes with its artifact, or once agents may not read it; one of a record kept but not read stays
      const byId = new Map(held.items.map((a) => [a.id, a]));
      problems.push(...this.copies.drop((c) => c.roomId === areaShelf(key) && (!ids.has(c.id) || (byId.has(c.id) && !!this.blockedReason(key, byId.get(c.id)!)))));
    }
    this.said(key, "cleanup", problems.length ? `Some of the area's files couldn't be cleaned up: ${problems.join("; ")}` : null);
  }

  /**
   * Copy area `key`'s artifacts into room `roomId` (sharing the area as a room offers it): a file by its bytes, a
   * note, a link and a repo reference as they are, each through the room's own add and its checks. Nothing secret
   * goes: what agents may not read here (named like a secret, from a credential store, holding a private key) stays
   * on this Mac for its owner to add by hand, knowing teammates get a copy. They all stay here too. Returns how many
   * went, what didn't and why, and each one's id in the room by its id here (`ids`: what the area's cards follow).
   */
  async shareTo(key: string, room: RoomAdds, roomId: string): Promise<{ shared: number; refused: { name: string; reason: string }[]; ids: Record<string, string> }> {
    const out = { shared: 0, refused: [] as { name: string; reason: string }[], ids: {} as Record<string, string> };
    for (const a of this.records(key)) {
      try {
        const secret = this.blockedReason(key, a);
        if (secret) throw new Error(`${secret.replace(/: agents never read it.*$/, "")}: add it to the room yourself if teammates should have a copy`);
        if (a.kind === "file") {
          const r = await room.addBytes(roomId, a.name, new Uint8Array(readNoFollow(this.blobAt(this.store(key), a), a.size)), false);
          if (r.refused.length) throw new Error(r.refused.map((x) => x.reason).join("; "));
          if (!r.added[0]) throw new Error("the room didn't say it was added");
          out.ids[a.id] = r.added[0].id;
        } else if (a.kind === "note") {
          const r = room.newNote(roomId, a.name, a.text, false);
          if ("needsConfirm" in r) throw new Error(`${r.reason}: add it to the room yourself if teammates should have a copy`);
          out.ids[a.id] = r.id;
        } else if (a.kind === "link") out.ids[a.id] = room.addLink(roomId, a.url, a.name).id;
        else out.ids[a.id] = room.addRepoRecord(roomId, { kind: "repo", name: a.name, origin: a.origin, path: a.path, commit: a.commit, ...(a.lines ? { lines: a.lines } : {}) }).id;
        out.shared++;
      } catch (err) {
        out.refused.push({ name: a.name, reason: (err as Error).message });
        this.d.log(`area artifacts: sharing ${a.name} from ${key} with room ${roomId}`, err);
      }
    }
    return out;
  }
}

/**
 * The window's artifact calls, by shelf (shared/areaArtifacts.ts): a room's id goes to the room's artifacts, an
 * `area:<key>` to that area's on this Mac. Each answers as the room's call does, so the window, its viewer and the
 * shelf serve both.
 */
export function artifactShelves(rooms: TeamArtifacts, areas: AreaArtifacts) {
  /**
   * `room` for a room's shelf, `area` for an area's. A room's area takes changes only on the room's shelf: what's kept
   * here from before it was shared (the cards placed from it, the copies not shared) is still read, never changed.
   */
  const on = <R>(shelf: unknown, room: (roomId: string) => R, area: (key: string) => R, change = false): R => {
    const key = areaOfShelf(String(shelf ?? ""));
    if (key === null) return room(String(shelf ?? ""));
    if (change && areas.roomOfArea(key)) throw new Error(`${key} is a team room's area: its artifacts are the room's, change them there`);
    return area(key);
  };
  const change = <R>(shelf: unknown, room: (roomId: string) => R, area: (key: string) => R): R => on(shelf, room, area, true);
  return {
    list: (s: string) => on(s, (r) => rooms.list(r), (k) => areas.list(k)),
    addFiles: (s: string, paths: string[], confirm: boolean) => change(s, (r) => rooms.addFiles(r, paths, confirm), (k) => areas.addFiles(k, paths, confirm)),
    addBytes: (s: string, name: string, bytes: Uint8Array | ArrayBuffer, confirm: boolean) => change(s, (r) => rooms.addBytes(r, name, bytes, confirm), (k) => areas.addBytes(k, name, bytes, confirm)),
    newNote: (s: string, name: string, text: string, confirm: boolean) => change(s, (r) => rooms.newNote(r, name, text, confirm), (k) => areas.newNote(k, name, text, confirm)),
    addRepo: (s: string, req: AddRepoRequest) => change(s, (r) => rooms.addRepo(r, req), (k) => areas.addRepo(k, req)),
    addLink: (s: string, url: string, title: string) => change(s, (r) => rooms.addLink(r, url, title), (k) => areas.addLink(k, url, title)),
    rename: (s: string, id: string, name: string) => change(s, (r) => rooms.rename(r, id, name), (k) => areas.rename(k, id, name)),
    remove: (s: string, id: string) => change(s, (r) => rooms.remove(r, id), (k) => areas.remove(k, id)),
    saveNote: (s: string, id: string, text: string, base: string, mode: SaveNoteMode, confirm: boolean) => change(s, (r) => rooms.saveNote(r, id, text, base, mode, confirm), (k) => areas.saveNote(k, id, text, base, mode, confirm)),
    read: (s: string, id: string) => on(s, (r) => rooms.read(r, id), (k) => areas.read(k, id)),
    download: (s: string, id: string) => on(s, (r) => rooms.download(r, id), (k) => areas.download(k, id)),
    resolveRepo: (s: string, id: string, prefer: string | null) => on(s, (r) => rooms.resolveRepo(r, id, prefer), (k) => areas.resolveRepo(k, id, prefer)),
    dismissNotice: (s: string, noticeId: string) => on(s, (r) => rooms.dismissNotice(r, noticeId), () => areas.dismissNotice()),
    viewFile: (s: string, id: string) => on(s, (r) => rooms.viewFile(r, id), (k) => areas.viewFile(k, id)),
    records: (s: string) => on(s, (r) => rooms.records(r), (k) => areas.records(k)),
    saveName: (s: string, id: string) => on(s, (r) => rooms.saveName(r, id), (k) => areas.saveName(k, id)),
    exportTo: (s: string, id: string, dest: string) => on(s, (r) => rooms.exportTo(r, id, dest), (k) => areas.exportTo(k, id, dest)),
  };
}

export type ArtifactShelves = ReturnType<typeof artifactShelves>;
