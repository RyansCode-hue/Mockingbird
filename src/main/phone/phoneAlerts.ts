import { randomInt } from "crypto";
import {
  alertKind,
  alertLine,
  alertText,
  CODE_DIGITS,
  CODE_LETTERS,
  normalizeHandle,
  parseReply,
  permissionTool,
  phoneSettings,
  replyTextProblem,
  type AlertItem,
  type AlertKind,
  type PhoneStatus,
  type ReplyAction,
} from "../../shared/phoneAlerts";
import { ticketIdOf, topOfKey, type SessionInfo, type Settings } from "../../shared/types";
import { inQuietHours } from "../notifications";
import type { Away } from "./away";
import type { MessageSource } from "./chatDb";
import { ChatDbError } from "./chatDb";
import type { AlertSender } from "./sender";
import { SendError } from "./sender";
import type { AuditKind } from "../../shared/team/audit";

/**
 * Phone alerts: an iMessage to the user's own handle when a session starts
 * waiting on them (a permission prompt or a question) or finishes its turn,
 * while they're away from the Mac — and, opted into separately, replies
 * from that self-conversation that answer it (src/shared/phoneAlerts.ts).
 *
 * Limits: one alert per session per PER_SESSION_MS and one per prompt;
 * alerts that come close together go as one message (BATCH_MS), and
 * messages are at least GAP_MS apart. Quiet hours and muted sessions hold
 * them back as they do desktop notifications.
 *
 * A reply does one of three things to the session its code names, and
 * nothing else: allow its permission prompt once, deny it — only while it's
 * the prompt the alert was about — or put a short message in its prompt
 * while it's idle. Each is written to the remote activity log and shown in
 * the pane.
 */

const BATCH_MS = 15_000;
const PER_SESSION_MS = 10 * 60_000;
const GAP_MS = 60_000;
const POLL_MS = 10_000;
/** How long an alert's code is taken. */
const OPEN_MS = 3 * 3_600_000;
/** Devices' clocks differ: a reply this much older than its alert still counts as after it (rows say the order). */
const SKEW_MS = 60_000;

/** The keys that answer a permission prompt once, by agent. Never Claude's 2 or Codex's a: those allow for good. */
export const ANSWER_KEYS = {
  allow: { claude: "1", codex: "y" },
  // Esc declines in both, whatever the options are numbered
  deny: { claude: "\x1b", codex: "\x1b" },
} as const;

export interface PhoneSessions {
  list(): SessionInfo[];
  /** Keys into a session's terminal. */
  write(id: string, data: string): void;
  /** A message into an idle session's prompt, sanitised and submitted as agent messages are; returns what became of it. */
  deliver(id: string, text: string): string;
  /** A line in the session's pane: what was done from the phone. */
  note(id: string, text: string): void;
}

export interface PhoneAlertsDeps {
  settings: () => Settings;
  away: () => Away;
  sender: AlertSender;
  /** Where replies are read; null in a development build, which never reads Messages. */
  replies: MessageSource | null;
  sessions: PhoneSessions;
  audit: { record(kind: AuditKind, who: { session?: string; title?: string | null }, more?: { n?: number; bytes?: number; outcome?: string }): void };
  log: (context: string, err: unknown) => void;
  info: (line: string) => void;
  /** A desktop notification: alerts failing, said once per spell. */
  warn: (title: string, body: string) => void;
  onChanged?: (s: PhoneStatus) => void;
  dev?: boolean;
  now?: () => number;
  code?: () => string;
  timing?: Partial<{ batchMs: number; perSessionMs: number; gapMs: number; pollMs: number; openMs: number }>;
}

interface Pending {
  sessionId: string;
  kind: AlertKind;
  /** The prompt: when it began and what it said. */
  waitingSince: number | null;
  reason: string | null;
}

export interface OpenAlert extends Pending {
  code: string;
  title: string;
  sentAt: number;
  /** The newest message in chat.db as it was sent: replies are rows after it. */
  top: number;
}

const titleOf = (s: SessionInfo) => s.ticketTitle ?? s.title;
const whereOf = (s: SessionInfo): string | null => (s.ticketId ? `#${ticketIdOf(s.ticketId)}` : s.taskGroup ? topOfKey(s.taskGroup) : null);
const promptKey = (p: { sessionId: string; waitingSince: number | null; kind: AlertKind }) => `${p.sessionId}:${p.kind}:${p.waitingSince ?? ""}`;

export const randomCode = (): string => CODE_LETTERS[randomInt(CODE_LETTERS.length)] + CODE_DIGITS[randomInt(CODE_DIGITS.length)];

export class PhoneAlerts {
  private pending = new Map<string, Pending>();
  private lastAlerted = new Map<string, number>();
  private alertedPrompts = new Map<string, number>();
  private open = new Map<string, OpenAlert>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private lastSendAt = 0;
  private last: PhoneStatus["last"] = null;
  private repliesState: PhoneStatus["replies"] = { state: "unchecked", detail: "" };
  private cursor: number | null = null;
  private failing = false;
  private recentReplies = new Map<string, number>();
  private readonly now: () => number;
  private readonly t: { batchMs: number; perSessionMs: number; gapMs: number; pollMs: number; openMs: number };

  constructor(private d: PhoneAlertsDeps) {
    this.now = d.now ?? Date.now;
    this.t = { batchMs: BATCH_MS, perSessionMs: PER_SESSION_MS, gapMs: GAP_MS, pollMs: POLL_MS, openMs: OPEN_MS, ...d.timing };
  }

  private get cfg() {
    return phoneSettings(this.d.settings().phoneAlerts);
  }

  private get handle(): string | null {
    return normalizeHandle(this.cfg.handle);
  }

  private get repliesOn(): boolean {
    return this.cfg.enabled && this.cfg.replies && !!this.d.replies;
  }

  status(): PhoneStatus {
    this.expire();
    const replies = !this.cfg.replies ? { state: "off" as const, detail: "" } : !this.d.replies ? { state: "dev" as const, detail: "A development build never reads Messages: replies work in the installed app." } : this.repliesState;
    return { away: this.d.away(), last: this.last, replies, open: this.open.size, dev: !!this.d.dev };
  }

  private changed(): void {
    this.d.onChanged?.(this.status());
  }

  // ---- alerts ------------------------------------------------------------------------------

  /** A session went waiting or idle (hooks.ts's status callback). */
  sessionStatus(info: SessionInfo, status: "waiting" | "idle"): void {
    const p = this.cfg;
    if (!p.enabled || !this.handle) return;
    if (status === "idle" && !p.finished) return;
    if (info.shell || info.debrief || info.muted) return;
    if (!this.d.away().away) return;
    if (inQuietHours(this.d.settings().quietHours, new Date(this.now()))) return;
    this.enqueue(info, status);
  }

  /** Away changed: on leaving, sessions already waiting are alerted (once per prompt); on coming back, nothing more is sent. */
  awayChanged(away: Away): void {
    if (!away.away) {
      if (this.pending.size) this.d.info(`phone alerts: back at the Mac; ${this.pending.size} pending alert(s) not sent`);
      this.pending.clear();
      this.clearFlush();
    } else {
      for (const s of this.d.sessions.list()) if (s.status === "waiting") this.sessionStatus(s, "waiting");
    }
    this.changed();
  }

  private enqueue(info: SessionInfo, status: "waiting" | "idle"): void {
    const now = this.now();
    const item: Pending = { sessionId: info.id, kind: alertKind(status, info.waitingReason), waitingSince: status === "waiting" ? info.waitingSince : null, reason: status === "waiting" ? info.waitingReason : null };
    if (this.alertedPrompts.has(promptKey(item))) return;
    const last = this.lastAlerted.get(info.id);
    if (last !== undefined && now - last < this.t.perSessionMs) {
      this.d.info(`phone alerts: not alerting ${info.id} again — it was alerted ${Math.round((now - last) / 60_000)} min ago`);
      return;
    }
    this.pending.set(info.id, item);
    if (!this.flushTimer) {
      const at = Math.max(now + this.t.batchMs, this.lastSendAt + this.t.gapMs);
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, at - now);
      this.flushTimer.unref?.();
    }
  }

  private clearFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /** Send what's pending as one message. Sessions that changed since are left out. */
  async flush(): Promise<void> {
    this.clearFlush();
    const handle = this.handle;
    const items = [...this.pending.values()];
    this.pending.clear();
    if (!items.length || !handle || !this.cfg.enabled) return;
    if (!this.d.away().away) return this.d.info(`phone alerts: back at the Mac; ${items.length} alert(s) not sent`);
    if (inQuietHours(this.d.settings().quietHours, new Date(this.now()))) return this.d.info(`phone alerts: quiet hours; ${items.length} alert(s) not sent`);
    const live = new Map(this.d.sessions.list().map((s) => [s.id, s]));
    const still = items.filter((i) => {
      const s = live.get(i.sessionId);
      if (!s) return false;
      return i.kind === "finished" ? s.status === "idle" : s.status === "waiting" && s.waitingSince === i.waitingSince;
    });
    if (!still.length) return;
    let top = 0;
    let coded = this.repliesOn;
    if (coded) {
      try {
        top = await this.d.replies!.top();
        this.repliesState = { state: "ok", detail: "" };
      } catch (err) {
        coded = false;
        this.repliesFailed(err);
      }
    }
    const sentAt = this.now();
    const alerts: OpenAlert[] = still.map((i) => {
      const s = live.get(i.sessionId)!;
      const takesReply = coded && i.kind !== "question";
      return { ...i, code: takesReply ? this.newCode() : "", title: titleOf(s), sentAt, top };
    });
    const text = alertText(
      alerts.map((a): AlertItem => {
        const s = live.get(a.sessionId)!;
        return { kind: a.kind, title: a.title, where: whereOf(s), tool: permissionTool(a.reason), code: a.code || null };
      })
    );
    const first = alerts[0];
    const who = { session: first.sessionId, title: first.title };
    this.lastSendAt = sentAt;
    try {
      await this.d.sender.send(handle, text);
    } catch (err) {
      const detail = err instanceof SendError || err instanceof Error ? err.message : String(err);
      this.last = { at: sentAt, ok: false, detail, test: false };
      this.d.log("phone alerts: sending", err);
      this.d.audit.record("phone.alert", who, { n: alerts.length, bytes: Buffer.byteLength(text), outcome: `not sent: ${alertLine(detail, 160)}` });
      if (!this.failing) this.d.warn("Phone alert not sent", detail);
      this.failing = true;
      this.changed();
      return;
    }
    this.failing = false;
    this.last = { at: sentAt, ok: true, detail: alerts.length === 1 ? `About “${first.title}”` : `About ${alerts.length} sessions`, test: false };
    for (const a of alerts) {
      this.lastAlerted.set(a.sessionId, sentAt);
      this.alertedPrompts.set(promptKey(a), sentAt);
      if (a.code) this.open.set(a.code, a);
    }
    this.d.audit.record("phone.alert", who, { n: alerts.length, bytes: Buffer.byteLength(text), outcome: "sent" });
    if (this.open.size) {
      if (this.cursor === null || top < this.cursor) this.cursor = top;
      this.schedulePoll();
    }
    this.changed();
  }

  private newCode(): string {
    for (let i = 0; i < 200; i++) {
      const c = (this.d.code ?? randomCode)();
      if (!this.open.has(c)) return c;
    }
    throw new Error("phone alerts: no reply code left free");
  }

  /** The "Send test alert" button: one message now, whatever away and quiet hours say. */
  async test(): Promise<{ detail: string }> {
    const handle = this.handle;
    if (!handle) throw new Error("Enter your iMessage handle first: your Apple ID email, or your number with its country code");
    const at = this.now();
    try {
      await this.d.sender.send(handle, "Mockingbird: a test alert. When a session waits on you while you're away from your Mac, it'll say so here.");
    } catch (err) {
      const detail = (err as Error).message;
      this.last = { at, ok: false, detail, test: true };
      this.d.log("phone alerts: test alert", err);
      this.changed();
      throw err;
    }
    this.failing = false;
    this.last = { at, ok: true, detail: "Test alert sent", test: true };
    this.changed();
    return { detail: "Sent — check your phone" };
  }

  // ---- replies -----------------------------------------------------------------------------

  /** Settings changed: phone alerts off, or replies off, stop reading and forget open codes. */
  settingsChanged(): void {
    if (!this.cfg.enabled) {
      this.pending.clear();
      this.clearFlush();
    }
    if (!this.repliesOn) {
      this.stopPolling();
      this.open.clear();
      this.cursor = null;
      this.repliesState = { state: "unchecked", detail: "" };
    } else if (this.repliesState.state === "unchecked") {
      void this.checkReplies();
    }
    this.changed();
  }

  /** Whether Messages can be read: asks for the newest row id, which reads no message. */
  async checkReplies(): Promise<PhoneStatus["replies"]> {
    if (!this.repliesOn) return this.status().replies;
    try {
      await this.d.replies!.top();
      this.repliesState = { state: "ok", detail: "" };
    } catch (err) {
      this.repliesFailed(err);
    }
    this.changed();
    return this.repliesState;
  }

  private repliesFailed(err: unknown): void {
    const e = err as Error;
    const state = err instanceof ChatDbError && (err.problem === "no-access" || err.problem === "missing") ? "no-access" : "error";
    if (this.repliesState.detail !== e.message) this.d.log("phone alerts: reading replies", err);
    this.repliesState = { state, detail: e.message };
  }

  private schedulePoll(): void {
    if (this.pollTimer || !this.repliesOn || !this.open.size) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll().finally(() => this.schedulePoll());
    }, this.t.pollMs);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private expire(): void {
    const now = this.now();
    for (const [code, a] of this.open) if (now - a.sentAt > this.t.openMs) this.open.delete(code);
    for (const [k, at] of this.alertedPrompts) if (now - at > this.t.openMs) this.alertedPrompts.delete(k);
  }

  /** Read the self-conversation once and act on what answers an open alert. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.expire();
    const handle = this.handle;
    if (!this.repliesOn || !handle || !this.open.size || this.cursor === null) return this.stopPolling();
    this.polling = true;
    try {
      const { messages, through } = await this.d.replies!.selfMessages(handle, this.cursor);
      this.cursor = Math.max(this.cursor, through);
      if (this.repliesState.state !== "ok") this.repliesState = { state: "ok", detail: "" };
      for (const m of messages) {
        const r = parseReply(m.text);
        if (r) await this.reply(r, m);
      }
    } catch (err) {
      this.repliesFailed(err);
    } finally {
      this.polling = false;
    }
    if (!this.open.size) this.stopPolling();
    this.changed();
  }

  private async reply(r: ReplyAction, m: { rowid: number; at: number; text: string }): Promise<void> {
    const a = this.open.get(r.code);
    if (!a) return this.d.info(`phone alerts: a reply named code ${r.code}, which no open alert has — ignored`);
    if (m.rowid <= a.top || m.at < a.sentAt - SKEW_MS) return this.d.info(`phone alerts: a message naming ${r.code} is older than its alert — ignored`);
    // a self-conversation can hold a message twice (as sent and as received)
    const dupe = `${r.code}\n${m.text.trim()}`;
    const seen = this.recentReplies.get(dupe);
    if (seen !== undefined && Math.abs(m.at - seen) < 30_000) return;
    this.recentReplies.set(dupe, m.at);
    for (const [k, at] of this.recentReplies) if (this.now() - at > 5 * 60_000) this.recentReplies.delete(k);

    const s = this.d.sessions.list().find((x) => x.id === a.sessionId);
    const outcome = this.act(a, r, s);
    const title = s ? titleOf(s) : a.title;
    this.d.audit.record("phone.reply", { session: a.sessionId, title }, { outcome: outcome.words, ...(r.action === "text" ? { bytes: Buffer.byteLength(r.text) } : {}) });
    if (outcome.close) this.open.delete(a.code);
    if (outcome.ok) this.d.sessions.note(a.sessionId, `Answered from your phone: ${outcome.words}`);
    this.d.info(`phone alerts: reply ${r.code} (${r.action}) for ${a.sessionId}: ${outcome.words}`);
    const back = outcome.ok ?`Mockingbird: done — ${outcome.words} in “${alertLine(title, 50)}”.` : `Mockingbird: not done — ${outcome.words}. (${a.code})`;
    try {
      await this.d.sender.send(this.handle!, back);
    } catch (err) {
      this.d.log("phone alerts: confirming a reply", err);
    }
  }

  /**
   * What a reply does to its session; only ever that session, and only these
   * three things. `close`: the alert's code is spent (it worked, or can't any
   * more); a refusal the user can correct leaves it open.
   */
  private act(a: OpenAlert, r: ReplyAction, s: SessionInfo | undefined): { ok: boolean; close: boolean; words: string } {
    const refused = (words: string, close: boolean) => ({ ok: false, close, words: `refused: ${words}` });
    if (!s || s.status === "dead") return refused("the session isn't running any more", true);
    if (r.action === "text") {
      const problem = replyTextProblem(r.text);
      if (problem) return refused(problem, false);
      if (s.shell || s.debrief) return refused("that session doesn't take messages", true);
      if (s.status !== "idle") return refused(s.status === "waiting" ? "it's waiting on a prompt — reply 1 or 2 to it" : "it's working — send it once it finishes", false);
      let how: string;
      try {
        how = this.d.sessions.deliver(s.id, r.text.trim());
      } catch (err) {
        this.d.log(`phone alerts: a reply's message for ${s.id}`, err);
        return refused(`it couldn't be delivered: ${(err as Error).message}`, true);
      }
      return { ok: true, close: true, words: `message sent (${how})` };
    }
    if (a.kind !== "permission") return refused("it isn't asking for permission", false);
    const same = s.status === "waiting" && s.waitingSince === a.waitingSince && s.waitingReason === a.reason;
    if (!same) return refused("that prompt was answered or changed since the alert", true);
    const agent = s.agent === "codex" ? "codex" : "claude";
    this.d.sessions.write(s.id, ANSWER_KEYS[r.action][agent]);
    return { ok: true, close: true, words: r.action === "allow" ? "allow once" : "deny" };
  }

  stop(): void {
    this.clearFlush();
    this.stopPolling();
  }
}
