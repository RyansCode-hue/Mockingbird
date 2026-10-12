import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { git, makeRepo, tempDir } from "./helpers";
import { items, sides, type Side } from "./artifactSides";
import { until } from "../src/main/team/loopback";
import { Messaging } from "../src/main/messaging";
import { excludePlanDir, removeRoomCopy, writeRoomCopy } from "../src/main/team/claims";
import { writeGeneratedInside } from "../src/main/fileOps";
import type { SessionInfo } from "../src/shared/types";

/**
 * Mockingbird's files inside worktrees and sessions' folders, which agents
 * write: a symbolic link there never takes a write (or a delete) outside.
 */

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, ticketTitle: null, repoPath: null, branch: "main", taskGroup: "5110", status: "idle", agent: "claude", cwd: "/nowhere", kind: "work", waitingReason: null, waitingSince: null, extraDirs: [], createdAt: 0, ticketId: null, ...over }) as SessionInfo;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const COPY = { claims: '{"mockingbird":"house-claims/1","rooms":[]}\n', context: "You're in a room.\n" };

/** A file standing for the user's own (~/.zshrc), outside any worktree, and what it holds. */
function outsideFile(): { file: string; dir: string; text: string } {
  const dir = tempDir("home-files");
  const file = path.join(dir, ".zshrc");
  fs.writeFileSync(file, "export PATH=/usr/bin\n");
  return { file, dir, text: "export PATH=/usr/bin\n" };
}

/** Everything under `dir`, relative, sorted. */
const tree = (dir: string): string[] => (fs.readdirSync(dir, { recursive: true }) as string[]).sort();

function messagingFor(s: Side) {
  const m = new Messaging({ list: () => s.sessions, deliverAgentMessage: () => "delivered" } as any, () => true, () => {});
  return (from: string, op: string, args: Record<string, unknown> = {}) => (m as any).handle({ op, from, args }) as Promise<{ result?: string; error?: string }>;
}

describe("the room's copy in a worktree", () => {
  it("refuses an agent-context.md that is a link, leaving its target alone", () => {
    const repo = makeRepo();
    const home = outsideFile();
    fs.mkdirSync(path.join(repo, ".mockingbird"));
    fs.symlinkSync(home.file, path.join(repo, ".mockingbird", "agent-context.md"));
    expect(() => writeRoomCopy(repo, COPY)).toThrow(/agent-context\.md is a symbolic link/);
    expect(fs.readFileSync(home.file, "utf8")).toBe(home.text);
    expect(fs.lstatSync(path.join(repo, ".mockingbird", "agent-context.md")).isSymbolicLink()).toBe(true);
  });

  it("refuses a .mockingbird that is a link to another folder, writing and deleting nothing there", () => {
    const repo = makeRepo();
    const home = outsideFile();
    fs.writeFileSync(path.join(home.dir, "plan.md"), "mine\n");
    fs.writeFileSync(path.join(home.dir, "claims.json"), "mine\n");
    fs.symlinkSync(home.dir, path.join(repo, ".mockingbird"));
    expect(() => writeRoomCopy(repo, COPY)).toThrow(/\.mockingbird is a symbolic link/);
    expect(() => removeRoomCopy(repo)).toThrow(/\.mockingbird is a symbolic link/);
    expect(tree(home.dir)).toEqual([".zshrc", "claims.json", "plan.md"]);
    expect(fs.readFileSync(path.join(home.dir, "claims.json"), "utf8")).toBe("mine\n");
  });

  it("writes and removes a real copy read-only, replacing a legacy plan.md link without following it", () => {
    const repo = makeRepo();
    const home = outsideFile();
    fs.mkdirSync(path.join(repo, ".mockingbird"));
    fs.symlinkSync(home.file, path.join(repo, ".mockingbird", "plan.md"));
    expect(writeRoomCopy(repo, COPY)).toBe(true);
    expect(fs.readFileSync(path.join(repo, ".mockingbird", "agent-context.md"), "utf8")).toBe(COPY.context);
    expect(fs.statSync(path.join(repo, ".mockingbird", "claims.json")).mode & 0o777).toBe(0o444);
    expect(fs.existsSync(path.join(repo, ".mockingbird", "plan.md"))).toBe(false);
    expect(fs.readFileSync(home.file, "utf8")).toBe(home.text);
    expect(writeRoomCopy(repo, COPY)).toBe(false);
    removeRoomCopy(repo);
    expect(fs.existsSync(path.join(repo, ".mockingbird"))).toBe(false);
  });

  it("never reads through a link it then refuses (a FIFO there can't stall the app)", () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".mockingbird"));
    execFileSync("mkfifo", [path.join(repo, ".mockingbird", "claims.json")]);
    expect(() => writeGeneratedInside(repo, ".mockingbird/claims.json", "{}", 0o444)).toThrow(/isn't a regular file/);
  });

  it("refuses a repository that committed .mockingbird as a link, and an exclude file that is one", async () => {
    const home = outsideFile();
    const repo = makeRepo();
    fs.symlinkSync(home.dir, path.join(repo, ".mockingbird"));
    git(repo, "add", ".mockingbird");
    git(repo, "commit", "-qm", "a link");
    expect(git(repo, "ls-files", "--", ".mockingbird/artifacts")).toBe("");
    await expect(excludePlanDir(repo)).rejects.toThrow(/tracks files under \.mockingbird\//);
    const other = makeRepo();
    fs.rmSync(path.join(other, ".git", "info", "exclude"), { force: true });
    fs.symlinkSync(home.file, path.join(other, ".git", "info", "exclude"));
    await expect(excludePlanDir(other)).rejects.toThrow(/symbolic link/);
    expect(fs.readFileSync(home.file, "utf8")).toBe(home.text);
  });
});

describe("agents' copies of room artifacts", () => {
  async function setup() {
    const { roomId, sides: [ryan, nick], dir } = await sides(["Ryan", "Nick"]);
    const shot = await ryan.arts.addBytes(roomId, "login screen", new Uint8Array(PNG));
    const id = shot.added[0].id;
    await until(() => items(nick.m.team.room(roomId)).length === 1, "Nick to know of it");
    const call = messagingFor(nick);
    const open = (name: string, cwd: string) => {
      nick.sessions.push(session(name, { cwd, repoPath: cwd }));
      nick.rooms.set(name, roomId);
      return call(name, "read_room_artifact", { id });
    };
    return { roomId, ryan, nick, dir, id, open };
  }

  it("aren't written through a .mockingbird that is a link", async () => {
    const { nick, dir, open } = await setup();
    const home = outsideFile();
    const repo = makeRepo({ "README.md": "hi\n" }, "wt", path.join(dir, "nick-code"));
    fs.symlinkSync(home.dir, path.join(repo, ".mockingbird"));
    expect((await open("s1", repo)).error).toMatch(/\.mockingbird is a symbolic link/);
    expect(tree(home.dir)).toEqual([".zshrc"]);
    // nor in a folder that isn't a repository
    const plain = tempDir("plain");
    fs.symlinkSync(home.dir, path.join(plain, ".mockingbird"));
    expect((await open("s2", plain)).error).toMatch(/symbolic link/);
    expect(tree(home.dir)).toEqual([".zshrc"]);
  });

  it("aren't written where the repository committed .mockingbird as a link", async () => {
    const { dir, open } = await setup();
    const home = outsideFile();
    const repo = makeRepo({ "README.md": "hi\n" }, "wt", path.join(dir, "nick-code"));
    fs.symlinkSync(home.dir, path.join(repo, ".mockingbird"));
    git(repo, "add", ".mockingbird");
    git(repo, "commit", "-qm", "a link");
    expect((await open("s1", repo)).error).toMatch(/tracks files under \.mockingbird\/ \(\.mockingbird…\)/);
    expect(tree(home.dir)).toEqual([".zshrc"]);
  });

  it("are owner-only and quarantined, and deleting one never follows a link put in its place", async () => {
    const { roomId, ryan, nick, dir, id, open } = await setup();
    const repo = makeRepo({ "README.md": "hi\n" }, "wt", path.join(dir, "nick-code"));
    const r = await open("s1", repo);
    const copy = path.join(repo, ".mockingbird", "artifacts", id, "login screen.png");
    expect(r.result).toContain(`copied to ${JSON.stringify(copy)}`);
    for (const d of [".mockingbird", ".mockingbird/artifacts", `.mockingbird/artifacts/${id}`]) expect(fs.statSync(path.join(repo, d)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o444);
    expect(execFileSync("xattr", ["-p", "com.apple.quarantine", copy], { encoding: "utf8" })).toMatch(/^0081;[0-9a-f]+;Mockingbird;/);
    // the agent swaps .mockingbird for a link to a folder shaped the same
    const home = outsideFile();
    fs.mkdirSync(path.join(home.dir, "artifacts", id), { recursive: true });
    fs.writeFileSync(path.join(home.dir, "artifacts", id, "keep.txt"), "mine\n");
    fs.rmSync(path.join(repo, ".mockingbird"), { recursive: true, force: true });
    fs.symlinkSync(home.dir, path.join(repo, ".mockingbird"));
    ryan.arts.remove(roomId, id);
    await until(() => nick.logs.some((l) => /cleaning up: .*symbolic link/.test(l)), "the cleanup to refuse the link");
    expect(fs.readFileSync(path.join(home.dir, "artifacts", id, "keep.txt"), "utf8")).toBe("mine\n");
    expect((await nick.arts.list(roomId)).problems.join("\n")).toMatch(/couldn't be cleaned up: .*symbolic link/);
  });
});
