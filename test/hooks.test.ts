import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile, execFileSync } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installHooks, hookStatus, hooksInstalled, watchEvents, ensureHookScript } from "../src/main/hooks";
import { scratchDir } from "./helpers";

const claudeSettings = path.join(os.homedir(), ".claude", "settings.json");
const codexHooks = path.join(os.homedir(), ".codex", "hooks.json");
const fakeCodex = path.join(os.homedir(), "bin", "codex");
const mb = path.join(os.homedir(), ".mockingbird");
const eventsDir = path.join(mb, "events");
const legacyEvents = path.join(mb, "events.jsonl");
const script = path.join(mb, "hook.sh");

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  fs.rmSync(path.dirname(claudeSettings), { recursive: true, force: true });
  fs.rmSync(path.dirname(codexHooks), { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** watchEvents with a stand-in session manager that records every routed event. */
function watch(onPrompt?: (id: string, prompt: string) => void) {
  const seen: any[] = [];
  const sessions = {
    statusFromHook: (ev: any) => {
      seen.push(ev);
      return { id: ev.paneId ?? "s1", title: "t" } as any;
    },
  };
  stops.push(watchEvents(sessions as any, () => {}, (info, prompt) => onPrompt?.(info.id, prompt)));
  return seen;
}

const until = async (done: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};
const settle = () => new Promise((r) => setTimeout(r, 1200));

/** An event file as the hook script leaves it: written aside, renamed into place. */
let seq = 0;
function drop(raw: string): void {
  const name = `${String(++seq).padStart(6, "0")}.json`;
  fs.writeFileSync(path.join(eventsDir, `.${name}`), raw);
  fs.renameSync(path.join(eventsDir, `.${name}`), path.join(eventsDir, name));
}
const event = (event: string, payload: object, pane = "p1") => JSON.stringify({ event, ts: 1, pane, payload: { cwd: "/w", session_id: "c1", ...payload } });

/** Run the installed hook script the way an agent does: payload on stdin, pane in the environment. */
function runHook(name: string, pane: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(script, [name], { env: { ...process.env, MOCKINGBIRD_SESSION: pane } }, (err) => (err ? reject(err) : resolve()));
    child.stdin!.end(JSON.stringify(payload));
  });
}

describe("installHooks", () => {
  it("adds its hooks next to the user's own, keeping every other setting", () => {
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    const mine = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, model: "opus" };
    fs.writeFileSync(claudeSettings, JSON.stringify(mine));
    installHooks(null);
    const s = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    expect(s.model).toBe("opus");
    expect(s.hooks.Stop).toHaveLength(2);
    expect(JSON.stringify(s.hooks.Stop[0])).toContain("say done");
    for (const ev of ["Stop", "Notification", "UserPromptSubmit", "PreToolUse"]) expect(JSON.stringify(s.hooks[ev])).toContain("hook.sh");
  });
  it("is idempotent", () => {
    installHooks(null);
    installHooks(null);
    expect(JSON.parse(fs.readFileSync(claudeSettings, "utf8")).hooks.Stop).toHaveLength(1);
  });
  it("refuses to overwrite a settings file it can't parse", () => {
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, "{ broken");
    expect(() => installHooks(null)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(claudeSettings, "utf8")).toBe("{ broken");
  });
  it("treats an empty settings file as no settings", () => {
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.writeFileSync(claudeSettings, "\n");
    installHooks(null);
    expect(hookStatus(null).claude).toBe(true);
  });
  it("refuses a settings file that isn't a settings object, leaving it as it is", () => {
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    for (const odd of ["[]", "null", '{"hooks":"none"}']) {
      fs.writeFileSync(claudeSettings, odd);
      expect(() => installHooks(null)).toThrow(/will not overwrite it/);
      expect(fs.readFileSync(claudeSettings, "utf8")).toBe(odd);
    }
  });
  it("changes nothing when Codex's hooks file can't be parsed — not even Claude's settings", () => {
    fs.mkdirSync(path.dirname(fakeCodex), { recursive: true });
    fs.writeFileSync(fakeCodex, "#!/bin/sh\n");
    fs.mkdirSync(path.dirname(codexHooks), { recursive: true });
    fs.writeFileSync(codexHooks, "{ broken");
    expect(() => installHooks(fakeCodex)).toThrow(/hooks\.json is not valid JSON/);
    expect(fs.existsSync(claudeSettings)).toBe(false);
    expect(fs.readFileSync(codexHooks, "utf8")).toBe("{ broken");
    expect(fs.readdirSync(path.dirname(codexHooks))).toEqual(["hooks.json"]); // not moved aside either
  });
  it("writes Codex hooks only when the Codex CLI is installed — ~/.codex alone isn't enough", () => {
    fs.mkdirSync(path.dirname(codexHooks), { recursive: true }); // what the ChatGPT desktop app leaves behind
    installHooks(null);
    expect(fs.existsSync(codexHooks)).toBe(false);
    expect(hookStatus(null)).toEqual({ claude: true, codex: null });
    expect(hooksInstalled(null)).toBe(true);

    fs.mkdirSync(path.dirname(fakeCodex), { recursive: true });
    fs.writeFileSync(fakeCodex, "#!/bin/sh\n");
    expect(hooksInstalled(fakeCodex)).toBe(false); // Codex present, its hooks not yet wired
    installHooks(fakeCodex);
    const c = JSON.parse(fs.readFileSync(codexHooks, "utf8"));
    for (const ev of ["Stop", "PermissionRequest", "UserPromptSubmit", "PreToolUse", "PostToolUse"]) expect(JSON.stringify(c.hooks[ev])).toContain("hook.sh");
    expect(hookStatus(fakeCodex)).toEqual({ claude: true, codex: true });
  });
  it("wires Codex when its CLI is installed but has never run (no ~/.codex yet)", () => {
    fs.mkdirSync(path.dirname(fakeCodex), { recursive: true });
    fs.writeFileSync(fakeCodex, "#!/bin/sh\n");
    expect(fs.existsSync(path.dirname(codexHooks))).toBe(false);
    installHooks(fakeCodex);
    expect(hookStatus(fakeCodex)).toEqual({ claude: true, codex: true });
  });
  it("keeps a symlinked settings file a symlink, with its permissions", () => {
    const dotfiles = fs.mkdtempSync(path.join(os.homedir(), "dotfiles-"));
    const real = path.join(dotfiles, "claude-settings.json");
    fs.writeFileSync(real, JSON.stringify({ model: "opus" }), { mode: 0o600 });
    fs.chmodSync(real, 0o600);
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
    fs.symlinkSync(real, claudeSettings);
    installHooks(null);
    expect(fs.lstatSync(claudeSettings).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf8"))).toMatchObject({ model: "opus", hooks: { Stop: expect.any(Array) } });
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dotfiles)).toEqual(["claude-settings.json"]); // no temp file left behind
  });
});

describe("hook script", () => {
  it("leaves each event in a file of its own, naming the pane it came from", () => {
    installHooks(null);
    fs.rmSync(eventsDir, { recursive: true, force: true });
    execFileSync(script, ["Stop"], { input: JSON.stringify({ session_id: "c9", cwd: "/w" }), env: { ...process.env, MOCKINGBIRD_SESSION: "pane42" } });
    execFileSync(script, ["Stop"], { input: JSON.stringify({ session_id: "c9", cwd: "/w" }), env: { ...process.env, MOCKINGBIRD_SESSION: "" } });
    const names = fs.readdirSync(eventsDir);
    expect(names).toHaveLength(2);
    expect(names.every((n) => /^\d+-\w+\.json$/.test(n))).toBe(true); // nothing left half-written under a dot-name
    const events = names.map((n) => JSON.parse(fs.readFileSync(path.join(eventsDir, n), "utf8")));
    expect(events.find((e) => e.pane === "pane42")).toMatchObject({ event: "Stop", payload: { session_id: "c9", cwd: "/w" } });
    expect(events.some((e) => e.pane === "")).toBe(true);
  });

  it("loses no event when hooks with large payloads run at the same time", async () => {
    installHooks(null);
    const seen = watch();
    const content = "x".repeat(20_000); // a Write's whole file rides in PreToolUse
    const trials = 10;
    for (let t = 0; t < trials; t++) {
      await Promise.all([
        runHook("PreToolUse", `a${t}`, { cwd: "/w", tool_name: "Write", tool_input: { content } }),
        runHook("PreToolUse", `b${t}`, { cwd: "/w", tool_name: "Write", tool_input: { content } }),
        runHook("Stop", `c${t}`, { cwd: "/w" }),
      ]);
    }
    await until(() => seen.length >= trials * 3);
    expect(seen).toHaveLength(trials * 3);
    expect(seen.filter((e) => e.status === "idle").map((e) => e.paneId).sort()).toEqual([...Array(trials).keys()].map((t) => `c${t}`).sort());
    expect(fs.readdirSync(eventsDir)).toEqual([]); // each event is read once, then removed
  });

  it("handles every event either agent sends: exits 0 at once, prints nothing outside a room, and leaves the event", () => {
    installHooks(null);
    fs.rmSync(eventsDir, { recursive: true, force: true });
    const cwd = scratchDir("plain");
    const all = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "PermissionRequest", "Stop"];
    for (const ev of all) {
      const started = Date.now();
      const out = execFileSync(script, [ev], { cwd, input: JSON.stringify({ session_id: "c9", cwd, hook_event_name: ev, source: "startup", tool_name: "Bash" }), env: { ...process.env, MOCKINGBIRD_SESSION: "p9" }, timeout: 5000 });
      expect([ev, out.toString()]).toEqual([ev, ""]); // execFileSync throws on a non-zero exit
      expect(Date.now() - started).toBeLessThan(2000);
    }
    const left = fs.readdirSync(eventsDir).map((n) => JSON.parse(fs.readFileSync(path.join(eventsDir, n), "utf8")).event);
    expect(left.sort()).toEqual([...all].sort());
  });

  it("is rewritten when an older build's differs, in one step", () => {
    installHooks(null);
    fs.writeFileSync(script, "#!/bin/bash\necho old >> events.jsonl\n");
    const fd = fs.openSync(script, "r"); // a hook running the old script
    ensureHookScript();
    expect(fs.readFileSync(script, "utf8")).toContain("mktemp");
    const buf = Buffer.alloc(64);
    expect(buf.toString("utf8", 0, fs.readSync(fd, buf, 0, 64, 0))).toContain("echo old"); // reads on undisturbed
    fs.closeSync(fd);
  });
});

describe("watchEvents", () => {
  it("turns hook events into session statuses, routed by pane and conversation", async () => {
    const prompts: string[] = [];
    const seen = watch((id, prompt) => prompts.push(`${id}: ${prompt}`));
    drop(event("UserPromptSubmit", { transcript_path: "/h/.claude/projects/x/c1.jsonl", prompt: "Add the dropdown" }));
    drop(event("Notification", { message: "Claude needs your permission to use Bash" }));
    drop(event("PreToolUse", {}));
    drop(event("Notification", { message: "Claude is waiting for your input" }));
    drop(event("PermissionRequest", { tool_name: "Bash", transcript_path: "/h/.codex/sessions/r.jsonl" }));
    drop(event("Stop", {}, ""));
    drop("not json");
    drop(JSON.stringify({ event: "Stop", payload: {} }));
    await settle();
    expect(seen.map((ev) => [ev.status, ev.reason, ev.paneId, ev.conversationId, ev.agent])).toEqual([
      ["working", undefined, "p1", "c1", "claude"],
      ["waiting", "Claude needs your permission to use Bash", "p1", "c1", "claude"],
      ["working", undefined, "p1", "c1", "claude"],
      ["idle", undefined, "p1", "c1", "claude"], // the idle reminder isn't "blocked on you"
      ["waiting", "Codex needs your permission to use Bash", "p1", "c1", "codex"],
      ["idle", undefined, undefined, "c1", "claude"], // no pane (agent run outside Mockingbird): cwd + conversation decide
    ]);
    // a submitted prompt starts a turn: its files are recorded first (undo a turn)
    expect(prompts).toEqual(["p1: Add the dropdown"]);
  });

  it("marks an agent that has just started, resumed or cleared idle at its prompt — without a 'Finished' alert, and not for a compaction", async () => {
    const alerts: string[] = [];
    const seen: any[] = [];
    const sessions = { statusFromHook: (ev: any) => (seen.push(ev), { id: ev.paneId, title: "t" }) };
    stops.push(watchEvents(sessions as any, (info, status) => alerts.push(`${info.id} ${status}`)));
    drop(event("SessionStart", { source: "startup" }, "a"));
    drop(event("SessionStart", { source: "resume", transcript_path: "/h/.codex/sessions/r.jsonl" }, "b"));
    drop(event("SessionStart", { source: "clear" }, "c"));
    drop(event("SessionStart", { source: "compact" }, "d"));
    drop(event("SessionStart", {}, "e"));
    await settle();
    expect(seen.map((ev) => [ev.paneId, ev.status, ev.started, ev.agent])).toEqual([
      ["a", "idle", true, "claude"],
      ["b", "idle", true, "codex"],
      ["c", "idle", true, "claude"],
      ["e", "idle", true, "claude"],
    ]);
    expect(alerts).toEqual([]);
  });

  it("reads Codex's own hook payloads: a permission request turns the pane amber", async () => {
    // the shapes Codex 0.156 sent in a watched run (values shortened): a read-only
    // sandbox asked before writing a file
    const codexEvent = (name: string, extra: object) =>
      JSON.stringify({
        event: name,
        ts: 1,
        pane: "p2",
        payload: {
          cwd: "/w2",
          hook_event_name: name,
          model: "gpt-6",
          permission_mode: "default",
          session_id: "01a108dc",
          turn_id: "01a108dc-2661",
          transcript_path: "/Users/u/.codex/sessions/2026/10/04/rollout-2026-10-04T17-40-07-01a108dc.jsonl",
          ...extra,
        },
      });
    const prompts: string[] = [];
    const seen = watch((_id, prompt) => prompts.push(prompt));
    drop(codexEvent("UserPromptSubmit", { prompt: "Create the file" }));
    drop(codexEvent("PreToolUse", { tool_name: "Bash", tool_input: { command: "printf hello > f" } }));
    drop(codexEvent("PermissionRequest", { tool_name: "Bash", tool_input: { command: "printf hello > f" } }));
    await settle();
    expect(seen.map((ev) => [ev.status, ev.reason, ev.agent])).toEqual([
      ["working", undefined, "codex"],
      ["working", undefined, "codex"],
      ["waiting", "Codex needs your permission to use Bash", "codex"],
    ]);
    expect(prompts).toEqual(["Create the file"]);
  });

  it("ignores events written before it started", async () => {
    fs.mkdirSync(eventsDir, { recursive: true });
    drop(event("Stop", {}, "stale"));
    const seen = watch();
    drop(event("Stop", {}, "fresh"));
    await settle();
    expect(seen.map((ev) => ev.paneId)).toEqual(["fresh"]);
  });

  it("keeps routing events after a handler fails, and says which one failed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    const sessions = {
      statusFromHook: (ev: any) => {
        seen.push(ev.paneId);
        return { id: ev.paneId, title: "t" } as any;
      },
    };
    const onStatus = (info: any) => {
      if (info.id === "bad") throw new Error("disk full");
    };
    stops.push(watchEvents(sessions as any, onStatus));
    drop(event("Stop", {}, "bad"));
    drop(event("Stop", {}, "good"));
    await settle();
    expect(seen).toEqual(["bad", "good"]);
    expect(errors.mock.calls.some((c) => /Stop for pane bad failed/.test(String(c[0])))).toBe(true);
  });

  it("still reads the shared file older hook scripts append to, waiting for a line to be complete", async () => {
    const seen = watch();
    const line = event("Notification", { message: "Claude needs your permission to use Bash — ok ✓" }, "old") + "\n";
    const bytes = Buffer.from(line);
    const cut = bytes.indexOf(Buffer.from("✓")) + 1; // inside a multibyte character
    fs.appendFileSync(legacyEvents, bytes.subarray(0, cut));
    await settle();
    expect(seen).toEqual([]);
    fs.appendFileSync(legacyEvents, Buffer.concat([bytes.subarray(cut), Buffer.from(event("Stop", {}, "old") + "\n")]));
    await settle();
    expect(seen.map((ev) => [ev.status, ev.reason])).toEqual([
      ["waiting", "Claude needs your permission to use Bash — ok ✓"],
      ["idle", undefined],
    ]);
  });
});
