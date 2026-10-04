import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";

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
