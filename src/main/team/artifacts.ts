import * as fs from "fs";
import * as path from "path";
import { artifactItems, checkArtifactName, checkLinkUrl, checkNoteText } from "./artifactEvents";
import { ArtifactFetcher, type FetchTiming } from "./artifactFetch";
import { RepoRefs, type FetchPolicy } from "./artifactRepo";
import { ArtifactStore, checkAddable, formatBytes, holdsPrivateKey, inside, quarantine, type Sniff } from "./artifactStore";
import { TEAM_DIR } from "./identity";
import { ROOMS_DIR } from "./rooms";
import { roomOfSession } from "./roomSessions";
import type { Team, Unsubscribe } from "./transport";
import { dirInside, isMissing, readJsonOrSetAside, writeFileAtomic } from "../fileOps";
import { homeSecretPlace, isSecretFileName } from "../secrets";
import {
  AGENT_ARTIFACTS_DIR,
  ARTIFACT_ID_RE,
  linkLabel,
  safeArtifactFileName,
  type AddFilesResult,
  type AddRepoRequest,
  type ArtifactAdded,
  type ArtifactContent,
  type ArtifactLocal,
  type ArtifactNotice,
  type ArtifactRecord,
  type ArtifactSummary,
  type RepoResolution,
  type RoomArtifactsView,
  type SaveNoteMode,
  type SaveNoteResult,
  type SecretConfirm,
} from "../../shared/team/artifacts";
import type { SessionInfo } from "../../shared/types";
import type { MemberId, RoomEvent, RoomId, RoomState } from "../../shared/team/types";

/**
 * Room artifacts on this install (docs/team-rooms.md, "Artifacts"): what the
 * window lists, opens and adds, the files' bytes kept and fetched (the store
 * and the fetcher), notes edited together, repo references resolved against
 * this Mac's clones, and what room agents and @assistant may read
 * (artifactTools.ts).
 *
 * The store lives in the room's folder, so leaving the room deletes it;
 * roomLeft stops the room's downloads first and deletes the copies agents
 * were given in their worktrees. Agents never reach the store: they get a
 * copy through their tool, after the secret check, and a copy goes again
 * when its artifact is removed or becomes secret.
 */

type FileRecord = Extract<ArtifactRecord, { kind: "file" }>;
type NoteRecord = Extract<ArtifactRecord, { kind: "note" }>;

/** Text files beyond this are shown cut. */
const MAX_VIEW_TEXT = 2 * 1024 * 1024;
const GC_DELAY_MS = 1_000;
const MAX_PROBLEMS = 10;

/** A copy of an artifact handed to an agent, in its folder: deleted when the artifact goes, becomes secret, or the room is left. */
export interface AgentCopy {
  roomId: RoomId;
  id: string;
  dir: string;
}

export interface TeamArtifactsDeps {
  /** Live sessions (repo references, agents' rooms). */
  sessions: () => SessionInfo[];
  /** Folders that may be clones of a room's repositories. */
  knownRepos: () => string[];
  /** Which local group each room is shown as (its sessions are opened first). */
  roomGroups: () => { roomId: RoomId; groupKey: string }[];
  /** Secret files at known places (the ADO PAT file): never added. */
  secretFiles: () => string[];
  /** A room's artifacts changed (the window's `artifacts:changed`). */
  emit: (roomId: RoomId) => void;
  log: (context: string, err: unknown) => string;
  /** The room a session of this install's is in (default: the live panes'). */
  roomOf?: (sessionId: string) => RoomId | null;
  roomsDir?: string;
  /** Where agents' copies are listed (default ~/.mockingbird/team/artifact-copies.json). */
  copiesFile?: string;
  /** Folders whose files are never added (default: the team folder). */
  neverAdd?: string[];
  now?: () => number;
  eagerBytes?: number;
  fetchTiming?: Partial<FetchTiming>;
}

let active: TeamArtifacts | null = null;

/** The running room artifacts, for the agents' tools and @assistant; null before team rooms start. */
export const runningArtifacts = (): TeamArtifacts | null => active;

const cleanName = (name: string, fallback: string) => name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200).trim() || fallback;
const normalizeText = (text: string) => String(text ?? "").replace(/\r\n?/g, "\n");
const KEY_IN_NOTE: SecretConfirm = { needsConfirm: "secret", reason: "It holds a private key. Everyone in the room gets a copy; room agents never read it" };

export class TeamArtifacts {
  readonly repos: RepoRefs;
  private team: Team | null = null;
  private fetcher: ArtifactFetcher | null = null;
  private stores = new Map<RoomId, ArtifactStore>();
  private offs: Unsubscribe[] = [];
  private notices = new Map<RoomId, ArtifactNotice[]>();
  private noticed = new Set<string>();
  private problems = new Map<RoomId, Map<string, string[]>>();
  private emitQueued = new Set<RoomId>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private gcTimers = new Map<RoomId, ReturnType<typeof setTimeout>>();
  private copies: AgentCopy[];
  private readonly copiesFile: string;
  private readonly roomsDir: string;
  private readonly now: () => number;

  constructor(private d: TeamArtifactsDeps) {
    this.roomsDir = d.roomsDir ?? ROOMS_DIR;
    this.copiesFile = d.copiesFile ?? path.join(TEAM_DIR, "artifact-copies.json");
    this.now = d.now ?? Date.now;
    this.repos = new RepoRefs({ sessions: d.sessions, knownRepos: d.knownRepos, log: d.log });
    this.copies = this.loadCopies();
  }

  /**
   * The agents' copies list. An entry that names a copy's folder but not its
   * room can't be matched to an artifact again: its copy is deleted now. An
   * entry without a folder can't be cleaned up at all. Either way it's
   * logged, never dropped silently.
   */
  private loadCopies(): AgentCopy[] {
    const v = readJsonOrSetAside(this.copiesFile, [], "the room artifacts' agent copies");
    if (!Array.isArray(v)) {
      this.d.log("room artifacts: the agents' copies list", `${this.copiesFile} isn't a list; the copies it named aren't tracked any more`);
      return [];
    }
    const good: AgentCopy[] = [];
    const orphans: AgentCopy[] = [];
    const lost: string[] = [];
    for (const c of v as Partial<AgentCopy>[]) {
      if (c && typeof c.roomId === "string" && typeof c.id === "string" && typeof c.dir === "string") good.push(c as AgentCopy);
      else if (c && typeof c.id === "string" && typeof c.dir === "string") orphans.push({ roomId: "", id: c.id, dir: c.dir });
      else lost.push(JSON.stringify(c)?.slice(0, 200) ?? String(c));
    }
    if (lost.length) this.d.log("room artifacts: the agents' copies list", `${lost.length} entries in ${this.copiesFile} name no copy's folder and were dropped: ${lost.join("; ")}`);
    if (!orphans.length) {
      try {
        if (lost.length) writeFileAtomic(this.copiesFile, JSON.stringify(good, null, 2));
      } catch (err) {
        this.d.log(`room artifacts: saving ${this.copiesFile}`, err);
      }
      return good;
    }
    this.d.log("room artifacts: the agents' copies list", `${orphans.length} entries in ${this.copiesFile} name no room; their copies are deleted now: ${orphans.map((c) => c.dir).join(", ")}`);
    this.copies = [...good, ...orphans];
    for (const p of this.dropCopies((c) => c.roomId === "")) this.d.log("room artifacts: cleaning up", p);
    return this.copies;
  }

  start(team: Team): void {
    this.stop();
    this.team = team;
    active = this;
    for (const room of team.rooms()) {
      try {
        this.store(room.id).clearTmp();
      } catch (err) {
        this.problem(room.id, "store", `Unfinished adds couldn't be cleared: ${this.d.log("room artifacts: clearing tmp/", err)}`);
      }
      // crossed edits from before this start were told about then
      for (const a of artifactItems(room)) if (a.conflictOf) this.noticed.add(a.id);
    }
    this.fetcher = new ArtifactFetcher({
      team,
      store: (roomId) => this.store(roomId),
      files: (roomId) => this.files(roomId),
      nameOf: (roomId, id) => this.nameOf(roomId, id),
      changed: (roomId) => this.changed(roomId),
      log: (msg) => void this.d.log("room artifacts", msg),
      now: this.d.now,
      eagerBytes: this.d.eagerBytes,
      timing: this.d.fetchTiming,
    });
    this.offs.push(
      team.onEvent("artifact.add", (e, room) => this.onEvent(e, room)),
      team.onEvent("artifact.update", (e, room) => this.onEvent(e, room)),
      team.onEvent("artifact.remove", (e, room) => this.onEvent(e, room)),
      team.onPresence((roomId) => this.changed(roomId))
    );
    this.fetcher.start();
    for (const room of team.rooms()) this.gcSoon(room.id);
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.fetcher?.stop();
    this.fetcher = null;
    for (const t of this.gcTimers.values()) clearTimeout(t);
    this.gcTimers.clear();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.team = null;
    if (active === this) active = null;
  }

  /** This install isn't in the room any more: downloads stop, agents' copies go (the store goes with the room's folder). */
  async roomLeft(roomId: RoomId): Promise<string[]> {
    this.stores.get(roomId)?.close();
    await this.fetcher?.roomLeft(roomId);
    const t = this.gcTimers.get(roomId);
    if (t) clearTimeout(t);
    this.gcTimers.delete(roomId);
    this.stores.delete(roomId);
    this.notices.delete(roomId);
    this.problems.delete(roomId);
    return this.dropCopies((c) => c.roomId === roomId);
  }

  // ---- the window -------------------------------------------------------------------------------

  async list(roomId: RoomId): Promise<RoomArtifactsView> {
    const { team, room } = this.need(roomId);
    const items: ArtifactSummary[] = [];
    // newest first, as the Team tab lists them
    for (const a of [...artifactItems(room)].reverse()) items.push(await this.summary(room, a));
    return { roomId, self: team.self.id, items, notices: this.notices.get(roomId) ?? [], problems: [...(this.problems.get(roomId)?.values() ?? [])].flat().slice(-MAX_PROBLEMS) };
  }

  private async summary(room: RoomState, a: ArtifactRecord): Promise<ArtifactSummary> {
    const s: ArtifactSummary = {
      id: a.id,
      kind: a.kind,
      name: a.name,
      addedBy: a.addedBy,
      addedByName: this.nameOf(room.id, a.addedBy),
      addedAt: a.addedAt,
      ...(a.updatedBy ? { updatedByName: this.nameOf(room.id, a.updatedBy), updatedAt: a.updatedAt } : {}),
      agentsBlocked: this.blockedReason(room.id, a),
      ...(a.conflictOf ? { conflictOf: a.conflictOf } : {}),
    };
    switch (a.kind) {
      case "file":
        return { ...s, size: a.size, local: await this.localOf(room.id, a) };
      case "note":
        return { ...s, rev: a.rev, chars: a.text.length };
      case "repo":
        return { ...s, origin: a.origin, path: a.path, commit: a.commit, ...(a.lines ? { lines: a.lines } : {}) };
      case "link": {
        const l = linkLabel(a.url);
        return { ...s, url: a.url, ...(l ? { host: l.host, ...(l.label ? { label: l.label } : {}) } : {}) };
      }
    }
  }

  /** Where a file stands here: present (and how it's shown), or how its download goes. */
  private async localOf(roomId: RoomId, a: FileRecord): Promise<ArtifactLocal> {
    const sniff = await this.sniffOf(roomId, a);
    if (sniff) return { state: "present", view: sniff.view, mime: sniff.mime };
    return this.fetcher?.local(roomId, a.sha256) ?? { state: "failed", problem: "Team rooms aren't running" };
  }

  /** A present file's content type (sniffed here); null when it isn't here, or its size isn't the record's. */
  async sniffOf(roomId: RoomId, a: FileRecord): Promise<Sniff | null> {
    const store = this.store(roomId);
    if (store.blobSize(a.sha256) !== a.size) return null;
    try {
      return await store.sniffOf(a.sha256, a.name);
    } catch (err) {
      this.problem(roomId, `sniff ${a.sha256}`, `${a.name} couldn't be read here: ${this.d.log("room artifacts: sniffing a file", err)}`);
      return null;
    }
  }

  /** Add files from disk. Each is checked, hashed and sniffed; a secret-looking one needs `confirmSecret`. */
  async addFiles(roomId: RoomId, paths: string[], confirmSecret = false): Promise<AddFilesResult> {
    this.need(roomId);
    if (!Array.isArray(paths)) throw new Error("No files to add");
    const out: AddFilesResult = { added: [], refused: [] };
    for (const p of paths) {
      const name = cleanName(path.basename(String(p ?? "")), "file");
      try {
        const { real } = checkAddable(String(p), { never: this.d.neverAdd ?? [TEAM_DIR, this.roomsDir], secretFiles: this.d.secretFiles() });
        await this.addIngested(roomId, name, { file: real }, confirmSecret, out, homeSecretPlace(real));
      } catch (err) {
        out.refused.push({ name, reason: (err as Error).message });
      }
    }
    for (const r of out.refused) if (!r.needsConfirm) this.d.log(`room artifacts: ${r.name} wasn't added`, r.reason);
    return out;
  }

  /** Add a file that has no path on disk (a pasted screenshot, an image dragged from a browser). */
  async addBytes(roomId: RoomId, rawName: string, bytes: Uint8Array | ArrayBuffer, confirmSecret = false): Promise<AddFilesResult> {
    this.need(roomId);
    const name = cleanName(String(rawName ?? ""), "pasted");
    const out: AddFilesResult = { added: [], refused: [] };
    try {
      const data = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
      if (!data) throw new Error("No bytes to add");
      await this.addIngested(roomId, name, { bytes: data }, confirmSecret, out);
    } catch (err) {
      out.refused.push({ name, reason: (err as Error).message });
      this.d.log(`room artifacts: ${name} wasn't added`, err);
    }
    return out;
  }

  /** `credentials`: the credential store the file is in (homeSecretPlace), if any: asked about, and kept from agents for good. */
  private async addIngested(roomId: RoomId, name: string, source: { file: string } | { bytes: Uint8Array }, confirmSecret: boolean, out: AddFilesResult, credentials: string | null = null): Promise<void> {
    const { team, room } = this.need(roomId);
    const ing = await this.store(roomId).ingest(source, name);
    const secret = isSecretFileName(name)
      ? `${name} is named like a secret file`
      : credentials
        ? `${name} is one of this Mac's credential files (${credentials})`
        : ing.sniff.privateKey
          ? `${name} holds a private key`
          : null;
    if (secret && !confirmSecret) {
      ing.drop();
      out.refused.push({ name, reason: `${secret}. Teammates get a copy; room agents never read it.`, needsConfirm: "secret" });
      return;
    }
    ing.keep();
    const warnings: string[] = [];
    const same = this.files(roomId).find((f) => f.sha256 === ing.sha256);
    if (same) warnings.push(`The same file is already in ${room.name} as ${same.name}`);
    try {
      const e = team.publish(roomId, "artifact.add", { kind: "file", name, size: ing.size, sha256: ing.sha256, mime: ing.sniff.mime, ...(credentials ? { wasSecret: true as const } : {}) });
      out.added.push({ id: e.id, name, warnings });
    } catch (err) {
      this.gcSoon(roomId);
      throw err;
    }
  }

  /** The window's New note: one whose text holds a private key is added only once the person confirms (`confirmSecret`), as a file is. */
  newNote(roomId: RoomId, rawName: string, rawText: string, confirmSecret = false): ArtifactAdded | SecretConfirm {
    if (!confirmSecret && holdsPrivateKey(normalizeText(rawText))) return KEY_IN_NOTE;
    return this.addNote(roomId, rawName, rawText);
  }

  /** Add a note. `wasSecret`: it's a copy of one agents may not read, and stays so whatever it's called. */
  addNote(roomId: RoomId, rawName: string, rawText: string, o: { wasSecret?: boolean } = {}): ArtifactAdded {
    const { team } = this.need(roomId);
    const name = checkArtifactName(cleanName(String(rawName ?? ""), "Note"));
    const text = this.noteText(rawText);
    const e = team.publish(roomId, "artifact.add", { kind: "note", name, text, ...(o.wasSecret ? { wasSecret: true as const } : {}) });
    return { id: e.id, name, warnings: [] };
  }

  addLink(roomId: RoomId, rawUrl: string, title: string): ArtifactAdded {
    const { team } = this.need(roomId);
    const url = String(rawUrl ?? "").trim();
    try {
      checkLinkUrl(url);
    } catch (err) {
      throw new Error(`That link can't be added: ${(err as Error).message.replace(/^url /, "it ")}`);
    }
    const l = linkLabel(url);
    const name = checkArtifactName(cleanName(String(title ?? ""), l?.label ?? l?.host ?? "Link"));
    const e = team.publish(roomId, "artifact.add", { kind: "link", name, url });
    return { id: e.id, name, warnings: [] };
  }

  /** A reference to a file in one of this install's sessions, at its HEAD. */
  async addRepo(roomId: RoomId, req: AddRepoRequest): Promise<ArtifactAdded> {
    const { team } = this.need(roomId);
    const session = this.d.sessions().find((s) => s.id === req?.sessionId && s.status !== "dead");
    if (!session) throw new Error("That session isn't running here");
    const { body, warnings } = await this.repos.reference(session, req);
    const e = team.publish(roomId, "artifact.add", body);
    return { id: e.id, name: body.name, warnings };
  }

  rename(roomId: RoomId, id: string, rawName: string): null {
    const { team } = this.need(roomId);
    const a = this.item(roomId, id);
    const name = checkArtifactName(cleanName(String(rawName ?? ""), a.name));
    if (name !== a.name) team.publish(roomId, "artifact.update", { id, name });
    return null;
  }

  remove(roomId: RoomId, id: string): null {
    const { team } = this.need(roomId);
    this.item(roomId, id);
    team.publish(roomId, "artifact.remove", { id });
    return null;
  }

  /**
   * Save a note's new text. "save" from a revision someone else's edit
   * replaced publishes nothing and says whose edit it was (the editor offers
   * to overwrite it, or to keep this text as a copy); "overwrite" replaces
   * whatever is current; "copy" adds the text as a new note. A text that
   * brings in a private key is saved only once the person confirms
   * (`confirmSecret`).
   */
  saveNote(roomId: RoomId, id: string, rawText: string, base: string, mode: SaveNoteMode, confirmSecret = false): SaveNoteResult {
    const { team, room } = this.need(roomId);
    const a = this.item(roomId, id);
    if (a.kind !== "note") throw new Error("Only notes are edited here");
    const text = this.noteText(rawText);
    const asks = !confirmSecret && holdsPrivateKey(text) && (mode === "copy" || !holdsPrivateKey(a.text));
    if (asks && !(mode === "save" && a.rev !== base)) return KEY_IN_NOTE;
    if (mode === "copy") return { copy: this.addNote(roomId, `${a.name.slice(0, 190)} (copy)`, text, { wasSecret: !!a.wasSecret || isSecretFileName(a.name) }).id };
    if (mode !== "save" && mode !== "overwrite") throw new Error(`Unknown save: ${mode}`);
    if (mode === "save" && a.rev !== base) return { stale: { rev: a.rev, byName: this.nameOf(room.id, a.updatedBy ?? a.addedBy), at: a.updatedAt ?? a.addedAt } };
    if (text === a.text) return { rev: a.rev };
    const e = team.publish(roomId, "artifact.update", { id, text, base: a.rev });
    return { rev: e.id };
  }

  private noteText(raw: string): string {
    const text = normalizeText(raw);
    try {
      return checkNoteText(text);
    } catch (err) {
      throw new Error(`The note can't be saved: its ${(err as Error).message}`);
    }
  }

  /** What the viewer shows. A file that isn't here yet is fetched first in line. */
  async read(roomId: RoomId, id: string): Promise<ArtifactContent> {
    const a = this.item(roomId, id);
    switch (a.kind) {
      case "note":
        return { view: "note", text: a.text, rev: a.rev };
      case "link":
        return { view: "link", url: a.url };
      case "repo":
        throw new Error("A repo reference opens in its repository (resolveRepo)");
    }
    const sniff = await this.sniffOf(roomId, a);
    if (!sniff) {
      this.fetcher?.prioritize(roomId, a.sha256);
      return { view: "missing", local: await this.localOf(roomId, a) };
    }
    const blob = this.store(roomId).blobPath(a.sha256);
    if (sniff.view === "image") return { view: "image", mime: sniff.mime, bytes: new Uint8Array(fs.readFileSync(blob)) };
    if (sniff.view === "markdown" || sniff.view === "text" || sniff.view === "csv") {
      const buf = this.store(roomId).readBlob(a.sha256, 0, Math.min(a.size, MAX_VIEW_TEXT));
      return { view: sniff.view, text: new TextDecoder("utf-8").decode(buf), truncated: a.size > MAX_VIEW_TEXT };
    }
    return { view: sniff.view, mime: sniff.mime, size: a.size };
  }

  /** Fetch a file now, ahead of the rest (Download, Retry). */
  download(roomId: RoomId, id: string): null {
    const a = this.item(roomId, id);
    if (a.kind !== "file") throw new Error("Only files are downloaded");
    this.fetcher?.prioritize(roomId, a.sha256);
    return null;
  }

  /** Where a repo reference opens here. `fetch`: whether a commit that isn't here is fetched (FetchPolicy; the window's default, "always"). */
  async resolveRepo(roomId: RoomId, id: string, preferSessionId: string | null, fetch: FetchPolicy = "always"): Promise<RepoResolution> {
    const a = this.item(roomId, id);
    if (a.kind !== "repo") throw new Error("That isn't a repo reference");
    return this.repos.resolve(a, { prefer: preferSessionId, groupKey: this.d.roomGroups().find((r) => r.roomId === roomId)?.groupKey ?? null, fetch });
  }

  /** A read-only, quarantined copy of a file artifact (for Quick Look and Reveal in Finder): a path this process made. */
  async viewFile(roomId: RoomId, id: string): Promise<string> {
    const a = this.item(roomId, id);
    if (a.kind !== "file") throw new Error("Only files open in Quick Look or Finder");
    const sniff = await this.sniffOf(roomId, a);
    if (!sniff) {
      this.fetcher?.prioritize(roomId, a.sha256);
      throw new Error(`${a.name} isn't on this Mac yet`);
    }
    const copy = await this.store(roomId).viewCopy(a.id, a.sha256, a.name, sniff);
    if (copy.warning) this.problem(roomId, `quarantine ${a.id}`, copy.warning);
    return copy.path;
  }

  /** The file name Save as… suggests. */
  saveName(roomId: RoomId, id: string): string {
    const a = this.item(roomId, id);
    if (a.kind === "note") return safeArtifactFileName(a.name, "md");
    if (a.kind !== "file") throw new Error("Only files and notes are saved as files");
    return safeArtifactFileName(a.name);
  }

  /** Save a file's bytes (or a note's text) to `dest`, chosen in the Save dialog, marked as downloaded. Returns a warning, or null. */
  async exportTo(roomId: RoomId, id: string, dest: string): Promise<string | null> {
    const a = this.item(roomId, id);
    if (a.kind === "note") fs.writeFileSync(dest, a.text);
    else if (a.kind === "file") {
      if (this.store(roomId).blobSize(a.sha256) !== a.size) throw new Error(`${a.name} isn't on this Mac yet`);
      fs.copyFileSync(this.store(roomId).blobPath(a.sha256), dest, fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(dest, 0o644);
    } else throw new Error("Only files and notes are saved as files");
    const warning = await quarantine(dest);
    if (warning) this.d.log("room artifacts: Save as", warning);
    this.problem(roomId, `save ${a.id}`, warning);
    return warning;
  }

  dismissNotice(roomId: RoomId, noticeId: string): null {
    const list = this.notices.get(roomId) ?? [];
    this.notices.set(roomId, list.filter((n) => n.id !== noticeId));
    this.changed(roomId);
    return null;
  }

  // ---- for agents and @assistant ------------------------------------------------------------------

  /** The room's live artifacts, oldest first. */
  records(roomId: RoomId): readonly ArtifactRecord[] {
    return artifactItems(this.need(roomId).room);
  }

  /**
   * Why agents may not read an artifact, or null: named like a secret file
   * now or ever (renaming doesn't make it readable), a repo reference to one,
   * or a file or a note holding a private key.
   */
  blockedReason(roomId: RoomId, a: ArtifactRecord): string | null {
    if (isSecretFileName(a.name)) return `Its name is a secret file's (${a.name}): agents never read it`;
    if (a.wasSecret) return "It was named like a secret file, or came from a credential store: agents never read it, whatever it's called now";
    if (a.kind === "repo" && isSecretFileName(path.posix.basename(a.path))) return `It points at a secret file (${path.posix.basename(a.path)}): agents never read it`;
    if (a.kind === "file" && this.store(roomId).knownSniff(a.sha256, a.name)?.privateKey) return "It holds a private key: agents never read it";
    if (a.kind === "note" && holdsPrivateKey(a.text)) return "It holds a private key: agents never read it";
    return null;
  }

  /** Fetch a file ahead of the rest and wait for it, at most `timeoutMs`. Resolves with whether it's here. */
  async ensureFile(roomId: RoomId, a: FileRecord, timeoutMs: number): Promise<boolean> {
    if (this.store(roomId).blobSize(a.sha256) === a.size) return true;
    if (!this.fetcher) return false;
    await this.fetcher.ensure(roomId, a.sha256, timeoutMs);
    return this.store(roomId).blobSize(a.sha256) === a.size;
  }

  /** Why a file isn't here, for an agent. */
  async missingReason(roomId: RoomId, a: FileRecord): Promise<string> {
    const l = await this.localOf(roomId, a);
    if (l.state === "downloading") return `it's still downloading from ${l.from} (${formatBytes(l.received)} of ${formatBytes(a.size)})`;
    if (l.state === "waiting" || l.state === "failed") return l.problem;
    return "it hasn't been fetched from a teammate yet";
  }

  blobPath(roomId: RoomId, sha: string): string {
    return this.store(roomId).blobPath(sha);
  }

  readText(roomId: RoomId, a: FileRecord, max: number): { text: string; truncated: boolean } {
    const buf = this.store(roomId).readBlob(a.sha256, 0, Math.min(a.size, max));
    return { text: new TextDecoder("utf-8").decode(buf), truncated: a.size > max };
  }

  /**
   * Copy a file artifact for an agent into `<root>/.mockingbird/artifacts/<id>/`
   * (a clone, read-only, quarantined, its folders owner-only), replacing an
   * earlier copy there, and remember it so it's deleted when the artifact goes
   * or becomes secret. `root` is the session's folder, which the agent writes:
   * a .mockingbird or artifacts there that is a symbolic link is refused, and
   * the copy's folder must stay inside the folder's real path.
   */
  async copyForAgent(roomId: RoomId, a: FileRecord, root: string, fileName: string): Promise<string> {
    if (!ARTIFACT_ID_RE.test(a.id)) throw new Error("not an artifact id");
    const parent = dirInside(root, AGENT_ARTIFACTS_DIR, 0o700)!;
    const dir = path.join(parent, a.id);
    const file = path.join(dir, fileName);
    if (path.dirname(file) !== dir) throw new Error("the artifact's name can't be a file name");
    // an earlier copy, whatever it now is: a link is removed, never followed
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { mode: 0o700 });
    if (!inside(fs.realpathSync(root), fs.realpathSync(dir))) throw new Error(`${dir} isn't inside ${root}`);
    this.copies = [...this.copies.filter((c) => !(c.dir === dir)), { roomId, id: a.id, dir }];
    writeFileAtomic(this.copiesFile, JSON.stringify(this.copies, null, 2));
    fs.copyFileSync(this.store(roomId).blobPath(a.sha256), file, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
    // marked before it's made read-only: setting an attribute needs write permission
    fs.chmodSync(file, 0o644);
    const warning = await quarantine(file);
    fs.chmodSync(file, 0o444);
    if (warning) this.d.log(`room artifacts: an agent's copy of ${a.name}`, warning);
    this.problem(roomId, `quarantine-agent ${a.id}`, warning);
    return file;
  }

  /** Log a failure the agents' tools or @assistant met (this install's log); returns the message logged. */
  report(context: string, err: unknown): string {
    return this.d.log(context, err);
  }

  nameOf(roomId: RoomId, id: MemberId): string {
    const room = this.team?.room(roomId);
    return (room?.members.find((m) => m.id === id) ?? room?.former?.find((m) => m.id === id))?.name ?? id.slice(0, 8);
  }

  /** The room a session of this install's is in (take-over respected), or null. */
  roomOfSession(sessionId: string): RoomId | null {
    const roomId = (this.d.roomOf ?? roomOfSession)(sessionId);
    return roomId && this.team?.room(roomId) ? roomId : null;
  }

  // ---- inside ---------------------------------------------------------------------------------------

  private onEvent(e: RoomEvent, room: RoomState): void {
    this.changed(room.id);
    this.fetcher?.refresh(room.id);
    if (e.type !== "artifact.add") this.gcSoon(room.id);
    this.scanNotices(room);
  }

  /** This install's edits that crossed a teammate's and were kept as a copy (a merge after a partition, say): told once. */
  private scanNotices(room: RoomState): void {
    const self = this.team?.self.id;
    for (const a of artifactItems(room)) {
      if (!a.conflictOf || a.addedBy !== self || this.noticed.has(a.id)) continue;
      this.noticed.add(a.id);
      const orig = artifactItems(room).find((x) => x.id === a.conflictOf);
      const winner = orig?.updatedBy ? this.nameOf(room.id, orig.updatedBy) : "a teammate";
      const list = this.notices.get(room.id) ?? [];
      list.push({ id: `crossed-${a.id}`, at: this.now(), text: `Your edit of '${orig?.name ?? "a note"}' crossed ${winner}'s; yours is kept as '${a.name}'`, artifact: a.id });
      this.notices.set(room.id, list.slice(-20));
    }
  }

  private files(roomId: RoomId): FileRecord[] {
    return artifactItems(this.team?.room(roomId)).filter((a): a is FileRecord => a.kind === "file");
  }

  private item(roomId: RoomId, id: string): ArtifactRecord {
    const a = artifactItems(this.need(roomId).room).find((x) => x.id === id);
    if (!a) throw new Error("That artifact isn't in the room any more");
    return a;
  }

  private store(roomId: RoomId): ArtifactStore {
    let s = this.stores.get(roomId);
    if (!s) this.stores.set(roomId, (s = new ArtifactStore(path.join(this.roomsDir, roomId))));
    return s;
  }

  private need(roomId: RoomId): { team: Team; room: RoomState } {
    const team = this.team;
    if (!team) throw new Error("Team rooms haven't started");
    const room = team.room(String(roomId));
    if (!room) throw new Error("You're not in that room");
    return { team, room };
  }

  private problem(roomId: RoomId, key: string, text: string | null): void {
    let m = this.problems.get(roomId);
    if (!m) this.problems.set(roomId, (m = new Map()));
    if (text) m.set(key, [text]);
    else m.delete(key);
    this.changed(roomId);
  }

  private changed(roomId: RoomId): void {
    this.emitQueued.add(roomId);
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const ids = [...this.emitQueued];
      this.emitQueued.clear();
      for (const id of ids) {
        try {
          this.d.emit(id);
        } catch (err) {
          this.d.log(`room artifacts: telling the window about room ${id}`, err);
        }
      }
    }, 50);
  }

  private gcSoon(roomId: RoomId): void {
    if (this.gcTimers.has(roomId)) return;
    const t = setTimeout(() => {
      this.gcTimers.delete(roomId);
      this.gc(roomId);
    }, GC_DELAY_MS);
    t.unref?.();
    this.gcTimers.set(roomId, t);
  }

  /** Delete what no live artifact uses: blobs, downloads, view copies, and agents' copies of what's gone or secret. */
  gc(roomId: RoomId): void {
    const room = this.team?.room(roomId);
    if (!room) return;
    const items = artifactItems(room);
    const problems: string[] = [];
    const store = this.store(roomId);
    if (fs.existsSync(store.dir)) problems.push(...store.gc(new Set(items.flatMap((a) => (a.kind === "file" ? [a.sha256] : []))), new Set(items.map((a) => a.id))));
    const byId = new Map(items.map((a) => [a.id, a]));
    problems.push(...this.dropCopies((c) => c.roomId === roomId && (!byId.has(c.id) || !!this.blockedReason(roomId, byId.get(c.id)!))));
    for (const p of problems) this.d.log("room artifacts: cleaning up", p);
    this.problem(roomId, "cleanup", problems.length ? `Some room files couldn't be cleaned up: ${problems.join("; ")}` : null);
  }

  /** Delete agents' copies matching `which`. Returns what couldn't be deleted (those stay listed, to try again). */
  private dropCopies(which: (c: AgentCopy) => boolean): string[] {
    const problems: string[] = [];
    const kept: AgentCopy[] = [];
    for (const c of this.copies) {
      if (!which(c)) {
        kept.push(c);
        continue;
      }
      // only ever a folder the tool made: <somewhere>/.mockingbird/artifacts/<id>
      if (!ARTIFACT_ID_RE.test(c.id) || !path.resolve(c.dir).endsWith(`${path.sep}${path.join(AGENT_ARTIFACTS_DIR, c.id)}`)) {
        problems.push(`${c.dir} isn't an agent's copy of an artifact; left alone`);
        continue;
      }
      try {
        // the folders above it are the agent's: a link there is refused (dirInside throws), never followed
        const root = path.resolve(c.dir, "..", "..", "..");
        if (dirInside(root, AGENT_ARTIFACTS_DIR)) fs.rmSync(c.dir, { recursive: true, force: true });
      } catch (err) {
        if (!isMissing(err)) {
          problems.push(`${c.dir} couldn't be deleted: ${(err as Error).message}`);
          kept.push(c);
        }
      }
    }
    if (kept.length !== this.copies.length) {
      this.copies = kept;
      try {
        writeFileAtomic(this.copiesFile, JSON.stringify(kept, null, 2));
      } catch (err) {
        problems.push(`${this.copiesFile} couldn't be saved: ${(err as Error).message}`);
      }
    }
    return problems;
  }
}
