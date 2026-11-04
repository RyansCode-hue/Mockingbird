import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { checkAdd, checkArtifactName, checkLinkUrl, checkNoteText } from "./team/artifactEvents";
import { AgentCopies } from "./team/agentCopies";
import { RepoRefs, type FetchPolicy } from "./team/artifactRepo";
import { baseSummary, blockedReasonOf, cleanName, exportArtifact, exportName, fileContent, normalizeText, type TeamArtifacts } from "./team/artifacts";
import { ArtifactStore, checkAddable, holdsPrivateKey, inside, type Sniff } from "./team/artifactStore";
import { dirInside, isMissing, writeFileAtomic } from "./fileOps";
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
interface AreaFile {
  v: 1;
  key: string;
  items: ArtifactRecord[];
}

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
  private readonly files = new Map<string, AreaFile>();
  private readonly problems = new Map<string, string[]>();
  private readonly stores = new Map<string, ArtifactStore>();
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

  /** Area `key`'s folder: made when `create`, else null while there's none. Throws for a link on the way or a key that isn't an area's. */
  private dir(key: string, create: boolean): string | null {
    const dir = dirInside(this.d.root, path.join(AREAS_DIR, folderOf(key)), create ? 0o700 : undefined);
    const top = path.join(this.d.root, AREAS_DIR);
    if (dir && !inside(fs.realpathSync(top), fs.realpathSync(dir))) throw new Error(`${dir} isn't inside ${top}`);
    return dir;
  }

  private store(key: string): ArtifactStore {
    let s = this.stores.get(key);
    if (!s) this.stores.set(key, (s = new ArtifactStore(this.dir(key, true)!)));
    return s;
  }

  /** Area `key`'s records, read once and kept. Throws when they can't be read; a file that isn't one is moved aside and said. */
  private file(key: string): AreaFile {
    const held = this.files.get(key);
    if (held) return held;
    const dir = this.dir(key, false);
    const f: AreaFile = { v: 1, key, items: [] };
    if (dir) {
      const at = path.join(dir, "area.json");
      let text: string | null = null;
      try {
        text = fs.readFileSync(at, "utf8");
      } catch (err) {
        if (!isMissing(err)) throw new Error(`${at} couldn't be read: ${(err as Error).message}`);
      }
      if (text !== null) f.items = this.parse(key, at, text);
    }
    this.files.set(key, f);
    return f;
  }

  /** The records in area.json's text; what isn't one is left out and said (the whole file moved aside when it isn't JSON). */
  private parse(key: string, at: string, text: string): ArtifactRecord[] {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch (err) {
      const moved = `${at}.bad-${this.now()}`;
      let where = `moved to ${moved}`;
      try {
        fs.renameSync(at, moved);
      } catch (moveErr) {
        where = `and couldn't be moved aside (${(moveErr as Error).message})`;
      }
      this.said(key, "file", `${at} wasn't readable (${(err as Error).message}), ${where}: the area's artifacts start over`);
      return [];
    }
    const raw = v && typeof v === "object" && Array.isArray((v as AreaFile).items) ? (v as AreaFile).items : null;
    if (!raw) {
      this.said(key, "file", `${at} has no list of artifacts; nothing in it is shown`);
      return [];
    }
    const out: ArtifactRecord[] = [];
    const bad: string[] = [];
    for (const [i, x] of (raw as unknown[]).entries()) {
      try {
        const r = x as Partial<ArtifactRecord>;
        if (typeof r.id !== "string" || !ARTIFACT_ID_RE.test(r.id)) throw new Error("its id isn't an artifact's");
        if (typeof r.addedAt !== "number" || typeof r.rev !== "string") throw new Error("it has no addedAt or rev");
        out.push({ ...checkAdd(x), id: r.id, addedBy: AREA_SELF, addedAt: r.addedAt, lamport: 0, rev: r.rev, ...(typeof r.updatedAt === "number" ? { updatedBy: AREA_SELF, updatedAt: r.updatedAt } : {}) });
      } catch (err) {
        bad.push(`#${i + 1}: ${(err as Error).message}`);
      }
    }
    if (bad.length) this.said(key, "records", `${bad.length} of the artifacts in ${at} can't be read and aren't shown (${bad.join("; ")})`);
    return out;
  }

  /** Write area `key`'s records. Throws when they can't be written; what's held in memory is then what was there before. */
  private save(key: string, items: ArtifactRecord[]): void {
    const dir = this.dir(key, true)!;
    const f: AreaFile = { v: 1, key, items };
    writeFileAtomic(path.join(dir, "area.json"), JSON.stringify(f, null, 2));
    this.files.set(key, f);
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
    return { roomId: areaShelf(key), self: AREA_SELF, items, notices: [], problems: (this.problems.get(key) ?? []).map((p) => p.replace(/^\[[^\]]+\] /, "")) };
  }

  private async summary(key: string, a: ArtifactRecord): Promise<ArtifactSummary> {
    const s = baseSummary(a, () => "You", this.blockedReason(key, a));
    if (a.kind !== "file") return s;
    const sniff = await this.sniffOf(key, a);
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
    const store = this.store(key);
    const ing = await store.ingest(source, name);
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
    ing.keep();
    const same = this.file(key).items.find((a) => a.kind === "file" && a.sha256 === ing.sha256);
    try {
      out.added.push(this.add(key, { kind: "file", name, size: ing.size, sha256: ing.sha256, mime: ing.sniff.mime, ...(credentials ? { wasSecret: true as const } : {}) }, same ? [`The same file is already here as ${same.name}`] : []));
    } catch (err) {
      this.gc(key);
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
    return fileContent(this.store(key), a, sniff);
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
    const copy = await this.store(key).viewCopy(a.id, a.sha256, a.name, sniff);
    if (copy.warning) this.said(key, `quarantine ${a.id}`, copy.warning);
    return copy.path;
  }

  saveName(key: string, id: string): string {
    return exportName(this.item(key, id));
  }

  async exportTo(key: string, id: string, dest: string): Promise<string | null> {
    const warning = await exportArtifact(this.store(key), this.item(key, id), dest);
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
    return store.sniffOf(a.sha256, a.name);
  }

  readText(key: string, a: FileRecord, max: number): { text: string; truncated: boolean } {
    const buf = this.store(key).readBlob(a.sha256, 0, Math.min(a.size, max));
    return { text: new TextDecoder("utf-8").decode(buf), truncated: a.size > max };
  }

  async copyForAgent(key: string, a: FileRecord, root: string, fileName: string): Promise<string> {
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
    let src: string | null;
    try {
      src = this.dir(from, false);
    } catch (err) {
      throw new Error(`${from}'s artifacts couldn't be found to move: ${(err as Error).message}`);
    }
    if (!src) return;
    this.files.delete(from);
    this.stores.delete(from);
    const fail = (err: unknown) => {
      const text = `${from}'s artifacts couldn't move to ${to}: ${(err as Error).message}. They're still in ${src}`;
      this.said(to, "rename", text);
      this.changed(to);
      return new Error(text);
    };
    try {
      const dest = this.dir(to, false);
      if (!dest) {
        fs.renameSync(src, path.join(path.dirname(src), folderOf(to)));
        this.files.delete(to);
        this.stores.delete(to);
        const f = this.file(to);
        if (f.items.length) this.save(to, f.items);
      } else this.merge(from, src, to);
    } catch (err) {
      throw fail(err);
    }
    const p = this.copies.rename(areaShelf(from), areaShelf(to));
    if (p) this.said(to, "copies", p);
    this.changed(from);
    this.changed(to);
  }

  /** `from`'s artifacts (in `src`) into `to`'s, which has some already; `src` goes once they're all in. */
  private merge(from: string, src: string, to: string): void {
    const old = new ArtifactStore(src);
    const theirs = (() => {
      this.files.delete(from);
      const text = (() => {
        try {
          return fs.readFileSync(path.join(src, "area.json"), "utf8");
        } catch (err) {
          if (isMissing(err)) return null;
          throw err;
        }
      })();
      return text === null ? [] : this.parse(from, path.join(src, "area.json"), text);
    })();
    const store = this.store(to);
    store.ensure();
    for (const a of theirs) {
      if (a.kind !== "file" || store.blobSize(a.sha256) === a.size) continue;
      fs.copyFileSync(old.blobPath(a.sha256), store.blobPath(a.sha256), fs.constants.COPYFILE_FICLONE);
    }
    const mine = this.file(to).items;
    this.save(to, [...mine, ...theirs.filter((a) => !mine.some((m) => m.id === a.id))]);
    fs.rmSync(src, { recursive: true, force: true });
  }

  /** Delete what no artifact of area `key` uses (blobs, view copies) and agents' copies of what's gone or secret. */
  gc(key: string): void {
    const items = this.file(key).items;
    const store = this.store(key);
    const problems: string[] = [];
    if (fs.existsSync(store.dir)) problems.push(...store.gc(new Set(items.flatMap((a) => (a.kind === "file" ? [a.sha256] : []))), new Set(items.map((a) => a.id))));
    const byId = new Map(items.map((a) => [a.id, a]));
    problems.push(...this.copies.drop((c) => c.roomId === areaShelf(key) && (!byId.has(c.id) || !!this.blockedReason(key, byId.get(c.id)!))));
    this.said(key, "cleanup", problems.length ? `Some of the area's files couldn't be cleaned up: ${problems.join("; ")}` : null);
  }

  /**
   * Copy area `key`'s artifacts into room `roomId` (sharing the area as a room offers it): a file by its bytes, a
   * note, a link and a repo reference as they are, each through the room's own add and its checks. Nothing secret
   * goes: what agents may not read here (named like a secret, from a credential store, holding a private key) stays
   * on this Mac for its owner to add by hand, knowing teammates get a copy. They all stay here too. Returns how many
   * went, and what didn't and why.
   */
  async shareTo(key: string, room: RoomAdds, roomId: string): Promise<{ shared: number; refused: { name: string; reason: string }[] }> {
    const out = { shared: 0, refused: [] as { name: string; reason: string }[] };
    for (const a of this.records(key)) {
      try {
        const secret = this.blockedReason(key, a);
        if (secret) throw new Error(`${secret.replace(/: agents never read it.*$/, "")}: add it to the room yourself if teammates should have a copy`);
        if (a.kind === "file") {
          const r = await room.addBytes(roomId, a.name, new Uint8Array(fs.readFileSync(this.store(key).blobPath(a.sha256))), false);
          if (r.refused.length) throw new Error(r.refused.map((x) => x.reason).join("; "));
        } else if (a.kind === "note") {
          const r = room.newNote(roomId, a.name, a.text, false);
          if ("needsConfirm" in r) throw new Error(`${r.reason}: add it to the room yourself if teammates should have a copy`);
        } else if (a.kind === "link") room.addLink(roomId, a.url, a.name);
        else room.addRepoRecord(roomId, { kind: "repo", name: a.name, origin: a.origin, path: a.path, commit: a.commit, ...(a.lines ? { lines: a.lines } : {}) });
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
  const on = <R>(shelf: unknown, room: (roomId: string) => R, area: (key: string) => R): R => {
    const key = areaOfShelf(String(shelf ?? ""));
    return key === null ? room(String(shelf ?? "")) : area(key);
  };
  return {
    list: (s: string) => on(s, (r) => rooms.list(r), (k) => areas.list(k)),
    addFiles: (s: string, paths: string[], confirm: boolean) => on(s, (r) => rooms.addFiles(r, paths, confirm), (k) => areas.addFiles(k, paths, confirm)),
    addBytes: (s: string, name: string, bytes: Uint8Array | ArrayBuffer, confirm: boolean) => on(s, (r) => rooms.addBytes(r, name, bytes, confirm), (k) => areas.addBytes(k, name, bytes, confirm)),
    newNote: (s: string, name: string, text: string, confirm: boolean) => on(s, (r) => rooms.newNote(r, name, text, confirm), (k) => areas.newNote(k, name, text, confirm)),
    addRepo: (s: string, req: AddRepoRequest) => on(s, (r) => rooms.addRepo(r, req), (k) => areas.addRepo(k, req)),
    addLink: (s: string, url: string, title: string) => on(s, (r) => rooms.addLink(r, url, title), (k) => areas.addLink(k, url, title)),
    rename: (s: string, id: string, name: string) => on(s, (r) => rooms.rename(r, id, name), (k) => areas.rename(k, id, name)),
    remove: (s: string, id: string) => on(s, (r) => rooms.remove(r, id), (k) => areas.remove(k, id)),
    saveNote: (s: string, id: string, text: string, base: string, mode: SaveNoteMode, confirm: boolean) => on(s, (r) => rooms.saveNote(r, id, text, base, mode, confirm), (k) => areas.saveNote(k, id, text, base, mode, confirm)),
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
