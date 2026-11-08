import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { git, makeRepo, tempDir } from "./helpers";

const emitters: ((d: string) => void)[] = [];
vi.mock("node-pty", () => ({
  spawn: () => {
    let onData: (d: string) => void = () => {};
    const proc = { onData: (cb: any) => ((onData = cb), { dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {}, pid: 1 };
    emitters.push((d) => onData(d));
    return proc;
  },
}));

describe("scrollback that survives restarts", () => {
  it("keeps what a pane showed and replays it, above a divider, when the pane is relaunched", async () => {
    const { SessionManager, restartDivider } = await import("../src/main/sessions");
    const saved: any[] = [];
    const store = { settings: { claudeBin: "/bin/echo" }, state: { sessions: saved }, upsertSession(i: any) { const k = saved.findIndex((x) => x.id === i.id); if (k >= 0) saved[k] = i; else saved.push(i); }, removeSession(id: string) { const k = saved.findIndex((x) => x.id === id); if (k >= 0) saved.splice(k, 1); }, save() {} };
    const m = new SessionManager(store as any);
    m.scrollbackDir = path.join(tempDir("sb"), "scrollback");
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "a" });
    emitters.at(-1)!("\x1b[1mhello\x1b[0m from the first run\r\n");
    m.kill(s.id, false); // kept to resume
    const file = path.join(m.scrollbackDir, `${s.id}.log`);
    expect(fs.readFileSync(file, "utf8")).toBe("\x1b[1mhello\x1b[0m from the first run\r\n");

    const again = await m.relaunch(s.id);
    expect(again?.id).toBe(s.id);
    const buf = m.buffer(s.id);
    expect(buf.startsWith("\x1b[1mhello\x1b[0m from the first run\r\n")).toBe(true);
    expect(buf).toContain("restarted");
    expect(buf).not.toContain("\x1b[?1049l"); // never left in the alternate screen, so the cursor stays put
    emitters.at(-1)!("second run\r\n");
    expect(m.buffer(s.id).endsWith("second run\r\n")).toBe(true);
    // output that ended inside the alternate screen leaves it before the divider
    expect(restartDivider(new Date(), "a\x1b[?1049hfull-screen app").startsWith("\x1b[?1049l\r\n")).toBe(true);
    expect(restartDivider(new Date(), "\x1b[?1049hx\x1b[?1049l back").startsWith("\r\n")).toBe(true);

    // closed for good: its scrollback goes too
    m.kill(s.id, true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("writes only panes whose output changed since they were last saved", async () => {
    const { SessionManager } = await import("../src/main/sessions");
    const store = { settings: { claudeBin: "/bin/echo" }, state: { sessions: [] as any[] }, upsertSession() {}, removeSession() {}, save() {} };
    const m = new SessionManager(store as any);
    m.scrollbackDir = path.join(tempDir("sb"), "scrollback");
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "a" });
    const file = path.join(m.scrollbackDir, `${s.id}.log`);
    m.saveScrollback();
    expect(fs.existsSync(file)).toBe(false); // nothing shown yet
    emitters.at(-1)!("one\r\n");
    m.saveScrollback();
    expect(fs.readFileSync(file, "utf8")).toBe("one\r\n");
    fs.writeFileSync(file, "untouched");
    m.saveScrollback(); // no new output: not rewritten
    expect(fs.readFileSync(file, "utf8")).toBe("untouched");
    m.saveScrollback(true); // quitting: everything
    expect(fs.readFileSync(file, "utf8")).toBe("one\r\n");
  });
});

describe("a closed session's ghost", () => {
  it("reads the end of its saved output, cut at a line's start; refused for a running session or one not this Mac's", async () => {
    const { SessionManager, tailOf } = await import("../src/main/sessions");
    const saved: any[] = [];
    const store = { settings: { claudeBin: "/bin/echo" }, state: { sessions: saved }, upsertSession(i: any) { const k = saved.findIndex((x) => x.id === i.id); if (k >= 0) saved[k] = i; else saved.push(i); }, removeSession(id: string) { const k = saved.findIndex((x) => x.id === id); if (k >= 0) saved.splice(k, 1); }, save() {} };
    const m = new SessionManager(store as any);
    m.scrollbackDir = path.join(tempDir("ghost"), "scrollback");
    const s = await m.create({ repoPath: null, useWorktree: false, agent: "claude", title: "a" });
    emitters.at(-1)!("first line\r\nsecond line\r\n⏺ the last thing it did\r\n");
    expect(() => m.closedOutput(s.id)).toThrow(/is running/);
    m.kill(s.id, false);
    expect(m.closedOutput(s.id)).toBe("first line\r\nsecond line\r\n⏺ the last thing it did\r\n");
    // only its end, from where a line starts
    expect(m.closedOutput(s.id, 30)).toBe("⏺ the last thing it did\r\n");
    expect(tailOf("abc\ndef", 5)).toBe("def");
    expect(tailOf("abcdef", 3)).toBe("def");
    // nothing saved: it says so with "", not an error
    fs.rmSync(path.join(m.scrollbackDir, `${s.id}.log`));
    expect(m.closedOutput(s.id)).toBe("");
    expect(() => m.closedOutput("nobody")).toThrow(/isn't one of this Mac's closed sessions/);
    // forgotten: no longer a closed session of this Mac's
    m.kill(s.id, true);
    expect(() => m.closedOutput(s.id)).toThrow(/isn't one of this Mac's closed sessions/);
  });

  it("whose folder is gone is listed, reopening only a removed worktree whose branch is still there", async () => {
    const { SessionManager } = await import("../src/main/sessions");
    const here = tempDir("ghost-folders");
    const repo = makeRepo();
    git(repo, "branch", "5101-kept");
    const wt = (b: string) => path.join(here, "worktrees", b);
    const saved: any[] = [
      { id: "kept", cwd: here, title: "kept", status: "dead" },
      { id: "branchKept", cwd: wt("5101-kept"), repoPath: repo, branch: "5101-kept", title: "a", status: "dead" },
      { id: "branchGone", cwd: wt("5102-gone"), repoPath: repo, branch: "5102-gone", title: "b", status: "dead" },
      { id: "folder", cwd: path.join(here, "moved"), repoPath: null, branch: null, title: "c", status: "dead" },
      { id: "volume", cwd: "/Volumes/MB-test-unplugged/code/x", repoPath: null, branch: null, title: "d", status: "dead" },
    ];
    const store = { settings: { claudeBin: "/bin/echo" }, state: { sessions: saved }, upsertSession() {}, removeSession() {}, save() {} };
    const m = new SessionManager(store as any);
    expect(await m.missingFolders()).toEqual([
      { id: "branchKept", reopens: true, short: "Its worktree was removed · its branch is kept", why: "Its worktree was removed: reopening makes it again from its branch, 5101-kept" },
      { id: "branchGone", reopens: false, short: "Its worktree was removed", why: "Its worktree was removed, and its branch with it, so it can't run where it ran: start fresh instead" },
      { id: "folder", reopens: false, short: "Its folder is gone", why: `Its folder, ${path.join(here, "moved")}, isn't there any more: start fresh instead` },
      { id: "volume", reopens: false, short: "Its volume isn't connected", why: "Its folder is on MB-test-unplugged, which isn't connected: connect it to reopen it" },
    ]);
  });
});
