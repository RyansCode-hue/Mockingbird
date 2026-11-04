import * as fs from "fs";
import * as path from "path";
import { dirInside, isMissing, readJsonOrSetAside, writeFileAtomic } from "../fileOps";
import { inside, quarantine, type ArtifactStore } from "./artifactStore";
import { AGENT_ARTIFACTS_DIR, ARTIFACT_ID_RE, type ArtifactRecord } from "../../shared/team/artifacts";

/**
 * A copy of an artifact handed to an agent, in its folder: deleted when the artifact goes, becomes secret, or its
 * shelf does (the room is left). `roomId` names the shelf: a room's id, or an area's ("area:<key>").
 */
export interface AgentCopy {
  roomId: string;
  id: string;
  dir: string;
}

type FileRecord = Extract<ArtifactRecord, { kind: "file" }>;

/**
 * The copies of artifacts agents were given (artifactTools.ts), listed in `file` so each is deleted when its artifact
 * goes or becomes secret. Agents never reach a store: they get a copy, after the secret check.
 */
export class AgentCopies {
  private copies: AgentCopy[];

  constructor(
    private readonly file: string,
    private readonly log: (context: string, err: unknown) => string,
    /** What the log calls them ("room artifacts"). */
    private readonly what: string,
    /** What a copy's shelf is: a room's, or an area's. */
    private readonly shelf: "room" | "area"
  ) {
    this.copies = this.load();
  }

  /**
   * The list. An entry that names a copy's folder but not its shelf can't be matched to an artifact again: its copy
   * is deleted now. An entry without a folder can't be cleaned up at all. Either way it's logged, never dropped
   * silently.
   */
  private load(): AgentCopy[] {
    const v = readJsonOrSetAside(this.file, [], `${this.what}' agent copies`);
    if (!Array.isArray(v)) {
      this.log(`${this.what}: the agents' copies list`, `${this.file} isn't a list; the copies it named aren't tracked any more`);
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
    if (lost.length) this.log(`${this.what}: the agents' copies list`, `${lost.length} entries in ${this.file} name no copy's folder and were dropped: ${lost.join("; ")}`);
    if (!orphans.length) {
      try {
        if (lost.length) writeFileAtomic(this.file, JSON.stringify(good, null, 2));
      } catch (err) {
        this.log(`${this.what}: saving ${this.file}`, err);
      }
      return good;
    }
    this.log(`${this.what}: the agents' copies list`, `${orphans.length} entries in ${this.file} name no ${this.shelf}; their copies are deleted now: ${orphans.map((c) => c.dir).join(", ")}`);
    this.copies = [...good, ...orphans];
    for (const p of this.drop((c) => c.roomId === "")) this.log(`${this.what}: cleaning up`, p);
    return this.copies;
  }

  /**
   * Copy a file artifact of `shelf`, whose bytes are `store`'s, for an agent into `<root>/.mockingbird/artifacts/<id>/`
   * (a clone, read-only, quarantined, its folders owner-only), replacing an earlier copy there, and remember it so it's
   * deleted when the artifact goes or becomes secret. `root` is the session's folder, which the agent writes: a
   * .mockingbird or artifacts there that is a symbolic link is refused, and the copy's folder must stay inside the
   * folder's real path. Returns the copy's path and a warning when quarantining failed.
   */
  async copy(shelf: string, store: ArtifactStore, a: FileRecord, root: string, fileName: string): Promise<{ file: string; warning: string | null }> {
    if (!ARTIFACT_ID_RE.test(a.id)) throw new Error("not an artifact id");
    const parent = dirInside(root, AGENT_ARTIFACTS_DIR, 0o700)!;
    const dir = path.join(parent, a.id);
    const file = path.join(dir, fileName);
    if (path.dirname(file) !== dir) throw new Error("the artifact's name can't be a file name");
    // an earlier copy, whatever it now is: a link is removed, never followed
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { mode: 0o700 });
    if (!inside(fs.realpathSync(root), fs.realpathSync(dir))) throw new Error(`${dir} isn't inside ${root}`);
    this.copies = [...this.copies.filter((c) => !(c.dir === dir)), { roomId: shelf, id: a.id, dir }];
    writeFileAtomic(this.file, JSON.stringify(this.copies, null, 2));
    fs.copyFileSync(store.blobPath(a.sha256), file, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
    // marked before it's made read-only: setting an attribute needs write permission
    fs.chmodSync(file, 0o644);
    const warning = await quarantine(file);
    fs.chmodSync(file, 0o444);
    return { file, warning };
  }

  /** Delete the copies matching `which`. Returns what couldn't be deleted (those stay listed, to try again). */
  drop(which: (c: AgentCopy) => boolean): string[] {
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
        writeFileAtomic(this.file, JSON.stringify(kept, null, 2));
      } catch (err) {
        problems.push(`${this.file} couldn't be saved: ${(err as Error).message}`);
      }
    }
    return problems;
  }

  /** Re-label shelf `from`'s copies as `to`'s (an area renamed). Returns a problem when the list couldn't be saved. */
  rename(from: string, to: string): string | null {
    if (!this.copies.some((c) => c.roomId === from)) return null;
    this.copies = this.copies.map((c) => (c.roomId === from ? { ...c, roomId: to } : c));
    try {
      writeFileAtomic(this.file, JSON.stringify(this.copies, null, 2));
      return null;
    } catch (err) {
      return `${this.file} couldn't be saved: ${(err as Error).message}`;
    }
  }
}
