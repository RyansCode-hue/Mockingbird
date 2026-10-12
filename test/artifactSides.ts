import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "./helpers";
import { loopbackRoom, type LoopbackMember } from "../src/main/team/loopback";
import { TeamArtifacts } from "../src/main/team/artifacts";
import type { FetchTiming } from "../src/main/team/artifactFetch";
import type { ArtifactRecord, ArtifactSummary } from "../src/shared/team/artifacts";
import type { SessionInfo } from "../src/shared/types";
import type { RoomState } from "../src/shared/team/types";

/** Room artifacts on each loopback member's "Mac": the service over its transport, its own rooms folder and copies list. */
export interface Side {
  m: LoopbackMember;
  arts: TeamArtifacts;
  logs: string[];
  emitted: string[];
  sessions: SessionInfo[];
  repos: string[];
  /** Which room each session is in (the live panes' answer). */
  rooms: Map<string, string>;
}

/** Retries and asks fast enough for tests; small chunks so a 1 MB file takes many. */
export const TIMING = { retryMs: [30, 60], haveGapMs: 20, chunkBytes: 64 * 1024 };

export interface SideOptions {
  eagerBytes?: number;
  timing?: Partial<FetchTiming>;
}

export function sideFor(m: LoopbackMember, dir: string, o: SideOptions = {}): Side {
  const side = { m, logs: [], emitted: [], sessions: [], repos: [], rooms: new Map() } as unknown as Side;
  side.arts = new TeamArtifacts({
    sessions: () => side.sessions,
    knownRepos: () => side.repos,
    roomGroups: () => m.team.status().rooms.map((r) => ({ roomId: r.id, groupKey: r.groupKey })),
    secretFiles: () => [],
    emit: (id) => side.emitted.push(id),
    log: (context, err) => {
      const msg = `${context}: ${err instanceof Error ? err.message : String(err)}`;
      side.logs.push(msg);
      return msg;
    },
    roomOf: (id) => side.rooms.get(id) ?? null,
    roomsDir: m.store.dir,
    copiesFile: path.join(dir, m.name, "artifact-copies.json"),
    neverAdd: [m.store.dir],
    fetchTiming: { ...TIMING, ...(o.timing ?? {}) },
    eagerBytes: o.eagerBytes,
  });
  side.arts.start(m.team);
  return side;
}

export async function sides(names: string[], o: SideOptions = {}) {
  const dir = tempDir("artifacts");
  const r = await loopbackRoom(names, { dir });
  return { ...r, dir, sides: r.members.map((m) => sideFor(m, dir, o)) };
}

export const items = (room: RoomState | undefined): ArtifactRecord[] => room?.ext.artifacts?.items ?? [];

export function randomFile(dir: string, name: string, size: number): string {
  const f = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f, crypto.randomBytes(size));
  return f;
}

export const fileRec = (s: Side, roomId: string, id: string) => items(s.m.team.room(roomId)).find((a) => a.id === id) as Extract<ArtifactRecord, { kind: "file" }>;

/** The verified file on this member's Mac, or null. */
export function blobOf(s: Side, roomId: string, id: string): Buffer | null {
  const rec = fileRec(s, roomId, id);
  if (!rec) return null;
  try {
    return fs.readFileSync(s.arts.blobPath(roomId, rec.sha256));
  } catch {
    return null;
  }
}

export const summaryOf = async (s: Side, roomId: string, id: string): Promise<ArtifactSummary> => (await s.arts.list(roomId)).items.find((i) => i.id === id)!;

/** Wait until an async condition holds (polling), or fail naming `what`. */
export async function eventually(cond: () => Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
