import * as path from "path";
import type { LandscapeStore } from "./landscape";
import type { Reply } from "./messaging";
import type { OfferHow } from "./wireDelivery";
import type { WireService } from "./wires";
import { conversationsOf } from "./meters";
import { latestMessageOf, transcriptDigest, transcriptLines } from "./handoff";
import {
  asData,
  DEFAULT_TEMPLATE,
  expandTemplate,
  readLabel,
  readWireDiff,
  readWireFiles,
  REDACTED,
  redactionsIn,
  redactSecrets,
  wiredNotice,
  wireInstructions,
  wireMessage,
  type Expansion,
  type LabelledEnd,
  type WireLine,
} from "./wirePrompt";
import { MAX_SUMMARY, WIRE_TOOL } from "./wireToolSchemas";
import { own } from "../shared/landscape";
import { oneLine, plainLine, quoted } from "../shared/team/agentText";
import { terminalLines } from "../shared/terminalText";
import { ticketIdOf, type AgentKind, type AgentMessage, type SessionInfo } from "../shared/types";
import {
  carriesWork,
  finishPlan,
  gateOf,
  verdictDue,
  verdictRefusal,
  WIRE_VERDICTS,
  wireRefusal,
  type FinishOutcome,
  type GateContext,
  type LatestMessage,
  type SourceNote,
  type Wire,
  type WireBook,
  type WireEnd,
  type WireVerdict,
} from "../shared/wires";

/** How much of a conversation read_context gives by default, and at most. */
const CONTEXT_CHARS = 40_000;
const CONTEXT_MAX = 100_000;
/** How many of a terminal's last lines read_terminal gives by default, and at most, and how much text that may be. */
const TERMINAL_LINES = 100;
const TERMINAL_LINES_MAX = 1000;
const TERMINAL_BYTES = 32 * 1024;

/** Pendings one finish made, saved: the notification hears of them here (delivery wrote them, and sent any its gate sends). */
export interface PendingsMade {
  /** The session whose step finished. */
  from: string;
  fromTitle: string;
  /** "agent": its finish_step; "you": Finish step in the window. */
  by: "agent" | "you";
  pendings: { wire: string; pending: string; to: string; toTitle: string }[];
}

/** A step's finish worked out and filled in, nothing written yet (WireTools.planFinish); delivery's offer writes it. */
export interface FinishFill {
  /** The source's note as the finish leaves it: its summary (redacted), and the verdict when one readies anything. */
  note: { summary: NonNullable<SourceNote["summary"]>; verdict?: WireVerdict };
  /** How many values redaction took out of the summary: flagged at each gate whose template carries {summary}. */
  redacted: number;
  /** The unsent pendings the verdict takes back, by the book as it was read. */
  withdraws: { wire: string; pending: string }[];
  /** Each wire that readies: its body filled in, and what it was filled from (its template and files, filledFrom). */
  fills: { wire: string; from: string; body: Expansion }[];
  /** Set when the source has no handoff or feedback wire out: only its summary is kept, and the finish says so. */
  noWireOut: { unread: string } | null;
}

export interface WireToolsOptions {
  store: Pick<LandscapeStore, "wires" | "editWires">;
  /** The rules' view of the sessions now. */
  rules: Pick<WireService, "context">;
  sessions: {
    list(): SessionInfo[];
    resumable(): SessionInfo[];
    /** Whether Mockingbird's notice under `key` still waits in its queue (SessionManager.noticeWaiting). */
    noticeWaiting(id: string, key: string): boolean;
    /** Mockingbird's notice, replacing the one under `key` still waiting (SessionManager.deliverNotice). */
    deliverNotice(id: string, key: string, message: string, submit: boolean): string;
    /** A live pane's output so far. */
    buffer(id: string): string;
    /** A closed one's saved output; throws when it can't be read. */
    closedOutput(id: string): string;
  };
  /** A conversation's transcript files, found now (handoff.ts' conversationFiles), and whose agent wrote them. */
  conversationFiles(s: SessionInfo, conv: string): { agent: AgentKind; files: { path: string; agent: AgentKind }[]; refused: string | null };
  /** This Mac's known secret files (knownSecretFiles): {files} and {diff} leave them out, as they do every secret-named file. */
  secretFiles?: () => readonly string[];
  /** Whether a message to this session is submitted, or left in its prompt (its group's message mode). */
  submitOnDelivery(target: SessionInfo): boolean;
  /** The message log: every read along a wire, who read whom and how much, never what. */
  onMessage?: (m: AgentMessage) => void;
  onPendings?: (e: PendingsMade) => void;
  /**
   * The one writer of what waits at gates and how it went (WireDelivery.offer): a finish's fill written in one change,
   * then sent where its gate is automatic. `prompt` is the source's prompt as its finish began (promptOf).
   */
  offer(me: SessionInfo, f: FinishFill, how: OfferHow, prompt: string | null): FinishOutcome;
  /** Which prompt session `id` is on (WireDelivery.promptOf), for once per prompt; null when it isn't running. */
  promptOf(id: string): string | null;
  log: (context: string, err: unknown) => void;
  now?: () => number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `args` naming only `allowed`, or why not: a tool's schema says so, and main holds to it whatever a caller sends. */
function onlyArgs(tool: string, args: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  return extra.length ? `${tool} takes ${allowed.join(" and ")}, nothing else (not ${extra.map((k) => JSON.stringify(plainLine(k, 40))).join(", ")}).` : null;
}

/** A whole number in [min, max], or `fallback` when `v` isn't one. */
const wholeIn = (v: unknown, fallback: number, min: number, max: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback);

const nOf = (n: number) => n.toLocaleString("en-US");

/** The key a session's notice of its new wires waits under in its queue (SessionManager.deliverNotice). */
export const WIRES_NOTICE = "wires";

/**
 * Why a context link or shared worktree can't be read along now, in its gate's words, or null: a read goes by what the
 * wire shows, so one the window shows blocked (across a room's line, an end closed and off the landscape, a book that
 * can't be saved) answers nothing.
 */
function blockedWhy(id: string, w: Wire, ctx: GateContext): string | null {
  const g = gateOf(id, w, ctx);
  return g.state === "blocked" ? (g.why ?? "This wire is blocked now.") : null;
}

/**
 * The agents' wire tools (finish_step, read_context, read_terminal), the window's Finish step, and what an agent is
 * told about its wires (docs/landscape-wires.md, W2). The caller is always the session messaging's token names: no
 * argument says who's calling, so `from` in read_context is only ever the workspace to read. Every answer tells "none"
 * from "couldn't": a read is refused, saying why, when the book or the transcript can't be read.
 *
 * Nothing here writes a pending or sends one: a finish is planned and filled in here, and delivery's offer writes it
 * and runs each gate (wireDelivery.ts), sending with the text messageFor builds.
 */
export class WireTools {
  constructor(private readonly o: WireToolsOptions) {}

  private now = (): number => (this.o.now ?? Date.now)();
  private secretFiles = (): readonly string[] => this.o.secretFiles?.() ?? [];

  /** One of the wire tools, for the session the caller's token names. */
  async call(me: SessionInfo, op: string, args: Record<string, unknown>): Promise<Reply> {
    try {
      if (op === WIRE_TOOL.finishStep) return finishReply(await this.finish(me, args, "agent"));
      if (op === WIRE_TOOL.readContext) return await this.readContext(me, args);
      if (op === WIRE_TOOL.readTerminal) return await this.readTerminal(me, args);
    } catch (err) {
      this.o.log(`wires: ${op} for ${me.id} failed`, err);
      return { error: `${op} failed: ${errorText(err)}` };
    }
    return { error: `Unknown tool: ${op}` };
  }

  // ---- finishing a step -----------------------------------------------------------------

  /**
   * Finish session `me`'s step with a summary (and a verdict where one's due), by its agent (finish_step) or a person
   * (Finish step). Each handoff and feedback wire out that the plan readies gets its own pending, its template filled
   * in now, in one pass; the summary goes on the session's note for context readers and for wires a person sends.
   * Answers once it's saved, never waiting on a gate. With no wire out, it's refused and the summary is kept.
   */
  async finish(me: SessionInfo, raw: Record<string, unknown>, by: PendingsMade["by"]): Promise<FinishOutcome> {
    // the prompt this finish answers, read before anything is awaited: one that comes in meanwhile isn't this finish's
    const prompt = this.o.promptOf(me.id);
    const fill = await this.planFinish(me, raw);
    return "refused" in fill ? fill : this.applyFinish(me, fill, by, prompt);
  }

  /**
   * finish's first half, which writes nothing: the call checked, the summary redacted, what each wire out does by the
   * book as it's read, and each body that readies filled in with what it was filled from.
   */
  async planFinish(me: SessionInfo, raw: Record<string, unknown>): Promise<FinishFill | { refused: string }> {
    const extra = onlyArgs(WIRE_TOOL.finishStep, raw, ["summary", "verdict"]);
    if (extra) return { refused: extra };
    if (typeof raw.summary !== "string" || !raw.summary.trim()) return { refused: "summary is empty: say what this step did." };
    const summary = raw.summary.trim();
    if (summary.length > MAX_SUMMARY) return { refused: `summary is ${summary.length} characters; the limit is ${MAX_SUMMARY}.` };
    const verdict = raw.verdict ?? undefined;
    if (verdict !== undefined && !WIRE_VERDICTS.includes(verdict as WireVerdict)) return { refused: `verdict is "approve" or "changes", not ${JSON.stringify(plainLine(String(verdict), 40))}.` };
    const v = verdict as WireVerdict | undefined;

    const state = this.o.store.wires();
    if (!state.book) return { refused: `Nothing was finished: ${state.refused ?? "wires can't be read right now."}` };
    const ctx = this.o.rules.context(state.book);
    const mine = ctx.end(me.id);
    if (mine?.takenOver) return { refused: mine.takenOver };
    const redacted = redactSecrets(summary);
    const conv = me.conversation?.id ?? conversationsOf(me).at(-1);
    const note = { summary: { text: redacted.text, at: this.now(), ...(conv ? { conversation: conv } : {}) }, ...(v ? { verdict: v } : {}) };
    const base = { note, redacted: redacted.count };

    if (!Object.values(state.book.links).some((w) => w.from === me.id && carriesWork(w.type))) {
      const unread = state.problems.length ? ` Some of the wires in landscape.json can't be read by this Mockingbird, and may be this workspace's: ${state.problems.map((p) => p.message).join(" ")}` : "";
      // nothing readies, so there's no verdict to keep: only the summary, for context readers
      return { ...base, note: { summary: note.summary }, withdraws: [], fills: [], noWireOut: { unread } };
    }
    const why = verdictRefusal(me.id, v, state.book.links);
    if (why) return { refused: why };

    // each wire that readies, filled in now; the diff is the source's folder's, read once for all of them
    const plan = finishPlan(me.id, v, ctx);
    let diff: Promise<Expansion> | null = null;
    const ticket = me.ticketId ? oneLine(`#${ticketIdOf(me.ticketId)}${me.ticketTitle ? ` — ${me.ticketTitle}` : ""}`) : "";
    const fills: FinishFill["fills"] = [];
    for (const step of plan) {
      if (step.does !== "readies") continue;
      const w = state.book.links[step.wire];
      const body = await expandTemplate(w.template ?? DEFAULT_TEMPLATE, {
        summary: redacted.text,
        ticket,
        diff: () => (diff ??= readWireDiff(me.cwd, this.secretFiles())),
        files: () => readWireFiles(me.cwd, w.files, this.secretFiles()),
      });
      fills.push({ wire: step.wire, from: filledFrom(w), body });
    }
    const withdraws = plan.flatMap((s) => (s.withdraws ? [{ wire: s.wire, pending: s.withdraws }] : []));
    return { ...base, withdraws, fills, noWireOut: null };
  }

  /**
   * finish's second half: `f` written by delivery's offer, in one change against the book as it is then, and each
   * new pending's gate run; then the notification hears what was made. `prompt`: the source's, as the finish began.
   */
  applyFinish(me: SessionInfo, f: FinishFill, by: PendingsMade["by"], prompt: string | null = null): FinishOutcome {
    const outcome = this.o.offer(me, f, { origin: by === "you" ? "person" : "agent" }, prompt);
    if ("refused" in outcome) return outcome;
    // only what still waits for the user: one its gate sent, or has on its way, needs nobody
    const book = this.o.store.wires().book;
    const pendings = outcome.steps.flatMap((s) => {
      if (!s.pending) return [];
      const d = book ? own(book.links, s.wire)?.delivery : undefined;
      if (d?.id === s.pending.id && d.state !== "held" && d.state !== "failed") return [];
      return [{ wire: s.wire, pending: s.pending.id, to: s.to, toTitle: s.toTitle }];
    });
    if (pendings.length) {
      try {
        this.o.onPendings?.({ from: me.id, fromTitle: me.ticketTitle ?? me.title, by, pendings });
      } catch (err) {
        this.o.log(`wires: ${me.id} finished its step, and telling of its ${pendings.length} pending(s) failed`, err);
      }
    }
    return outcome;
  }

  /** Session `s`'s latest message, whole, cut to what a summary may hold: what a person's Finish step starts from. */
  async latestMessage(s: SessionInfo): Promise<LatestMessage> {
    if (s.shell) return { text: null, at: null, why: "a terminal has no conversation" };
    const conv = s.conversation?.id ?? conversationsOf(s).at(-1);
    if (!conv) return { text: null, at: null, why: "Mockingbird hasn't seen a conversation in it yet" };
    const found = this.o.conversationFiles(s, conv);
    const m = await latestMessageOf(found.files, conv);
    if (!m.text) return { ...m, ...(found.refused && !m.why ? { why: found.refused } : {}) };
    return m.text.length > MAX_SUMMARY ? { text: m.text.slice(0, MAX_SUMMARY), at: m.at, cut: true } : m;
  }

  // ---- reading along a wire -----------------------------------------------------------------

  /**
   * read_context: workspace `from`'s summary and the end of its conversation, for a caller a context link runs to from
   * it, and refused for any other. Tool calls and their output are in unless the link says otherwise; all of it is
   * redacted, fenced as data, and logged without its content.
   */
  async readContext(me: SessionInfo, args: Record<string, unknown>): Promise<Reply> {
    const extra = onlyArgs(WIRE_TOOL.readContext, args, ["from", "max_chars"]);
    if (extra) return { error: extra };
    const from = typeof args.from === "string" ? args.from.trim() : "";
    if (!from) return { error: "from is the id of the workspace to read: list_links shows the context links into this one." };
    const max = wholeIn(args.max_chars, CONTEXT_CHARS, 1000, CONTEXT_MAX);
    const refuse = (why: string): Reply => {
      this.logRead(me, WIRE_TOOL.readContext, from, from, `refused: ${why}`, true);
      return { error: why };
    };

    const state = this.o.store.wires();
    if (!state.book) return refuse(state.refused ?? "Wires can't be read right now.");
    const found = Object.entries(state.book.links).find(([, w]) => w.type === "context" && w.from === from && w.to === me.id);
    if (!found) return refuse(`There's no context link from ${quoted(from)} to this workspace: the user draws those. list_links shows this workspace's wires.${unreadable(state.problems)}`);
    const [id, w] = found;
    const ctx = this.o.rules.context(state.book);
    const why = blockedWhy(id, w, ctx);
    if (why) return refuse(why);
    const src = this.session(from)!;
    const end = ctx.end(from)!;

    let redactions = 0;
    const redact = (t: string) => {
      const r = redactSecrets(t);
      redactions += r.count;
      return r.text;
    };
    const tools = w.toolOutput === false ? "none" : "all";
    const conv = src.conversation?.id ?? conversationsOf(src).at(-1) ?? null;
    const note = own(state.book.notes, from);
    const earlier = !!note?.summary?.conversation && !!conv && note.summary.conversation !== conv;
    const summary = note?.summary
      ? `Its summary, from finishing its step${earlier ? " in an earlier conversation than the one it runs now (it has started a new one since, as /clear does)" : ""}, ${ago(this.now() - note.summary.at)}:\n${redact(note.summary.text)}`
      : "It hasn't finished a step with a summary yet.";
    let conversation: string;
    if (!conv) conversation = "Mockingbird hasn't seen a conversation in it yet.";
    else {
      const files = this.o.conversationFiles(src, conv);
      if (!files.files.length) {
        if (files.refused) return refuse(`Its conversation couldn't be read: ${files.refused}.`);
        conversation = "Its conversation's transcript isn't written yet.";
      } else {
        let lines: string[];
        try {
          lines = (await Promise.all(files.files.map((f) => transcriptLines(f.path)))).flat();
        } catch (err) {
          this.o.log(`wires: read_context couldn't read ${from}'s transcript for ${me.id}`, err);
          return refuse(`Its conversation couldn't be read: ${errorText(err)}`);
        }
        const digest = transcriptDigest(lines, files.agent, conv, max, { tools, entry: redact });
        conversation = digest
          ? `Its conversation (USER is its user, AGENT its agent${tools === "all" ? ", TOOL a tool it ran, OUTPUT what that gave back" : ""}):\n${digest}`
          : "Its conversation has nothing in it yet.";
      }
    }
    const label = readLabel(
      "Context from",
      labelled(src, end),
      "read through a context link the user drew from it to this workspace",
      "another agent and its tools",
      tools === "all" ? "Its tool calls and their output are included." : "Its tool calls and their output are left out, as the link is set."
    );
    const text = asData(label, "context", `${summary}\n\n${conversation}`) + redactionNote(redactions);
    this.logRead(me, WIRE_TOOL.readContext, from, end.title, `${nOf(text.length)} characters, tool output ${tools === "all" ? "included" : "left out"}${redactions ? `, ${redactions} value(s) redacted` : ""}`);
    return { result: text };
  }

  /**
   * read_terminal: a terminal's last lines, for the agent a shared worktree wire runs from to it, and refused for any
   * other. A closed terminal gives what it showed when it closed, and says so.
   */
  async readTerminal(me: SessionInfo, args: Record<string, unknown>): Promise<Reply> {
    const extra = onlyArgs(WIRE_TOOL.readTerminal, args, ["terminal", "lines"]);
    if (extra) return { error: extra };
    const id = typeof args.terminal === "string" ? args.terminal.trim() : "";
    if (!id) return { error: "terminal is the id of the terminal to read: list_links shows the ones shared with this workspace." };
    const want = wholeIn(args.lines, TERMINAL_LINES, 1, TERMINAL_LINES_MAX);
    const refuse = (why: string): Reply => {
      this.logRead(me, WIRE_TOOL.readTerminal, id, id, `refused: ${why}`, true);
      return { error: why };
    };

    const state = this.o.store.wires();
    if (!state.book) return refuse(state.refused ?? "Wires can't be read right now.");
    const found = Object.entries(state.book.links).find(([, w]) => w.type === "worktree" && w.from === me.id && w.to === id);
    if (!found) return refuse(`There's no shared worktree wire from this workspace to ${quoted(id)}: the user draws those. list_links shows this workspace's wires.${unreadable(state.problems)}`);
    const ctx = this.o.rules.context(state.book);
    const why = blockedWhy(found[0], found[1], ctx);
    if (why) return refuse(why);
    const term = this.session(id)!;
    const end = ctx.end(id)!;
    const running = this.o.sessions.list().some((s) => s.id === id);
    let raw: string;
    try {
      raw = running ? this.o.sessions.buffer(id) : this.o.sessions.closedOutput(id);
    } catch (err) {
      this.o.log(`wires: read_terminal couldn't read ${id}'s output for ${me.id}`, err);
      return refuse(`Its output couldn't be read: ${errorText(err)}`);
    }
    // redacted whole before it's cut: a key whose BEGIN line the cut leaves out is still a key
    const all = redactSecrets(terminalLines(raw).join("\n")).text.split("\n");
    while (all.length && !all[all.length - 1]) all.pop();
    let tail = all.slice(-want).join("\n");
    const asked = tail ? tail.split("\n").length : 0;
    if (Buffer.byteLength(tail) > TERMINAL_BYTES) {
      const last = Buffer.from(tail).subarray(-TERMINAL_BYTES).toString("utf8");
      tail = last.slice(last.indexOf("\n") + 1); // the line the cut went through
    }
    const lines = tail ? tail.split("\n").length : 0;
    const r = { text: tail, count: redactionsIn(tail) };
    const shown = !r.text ? "nothing: it hasn't shown any output" : `its last ${nOf(lines)} line${lines === 1 ? "" : "s"}${lines < asked ? `: the last ${nOf(asked)} were more than 32 KB` : ""}`;
    const label = readLabel(
      "Output of",
      labelled(term, end),
      `a terminal shared with this workspace through a shared worktree wire${running ? "" : "; it's closed, so this is what it showed when it closed"}`,
      "the commands run there",
      `This is ${shown}.`
    );
    const text = asData(label, "terminal", r.text) + redactionNote(r.count);
    this.logRead(me, WIRE_TOOL.readTerminal, id, end.title, `${nOf(text.length)} characters${r.count ? `, ${r.count} value(s) redacted` : ""}`);
    return { result: text };
  }

  // ---- telling agents about their wires ------------------------------------------------------

  /** The wires each session's notice still waiting in its queue tells of (wired). */
  private noticed = new Map<string, WireLine[]>();

  /**
   * A wire was made: the agent at its acting end (a handoff's or feedback's source, a context link's reader, a shared
   * terminal's agent) is told through its queue when it's working, so it hears as its turn ends. Wires made while that
   * notice still waits are folded into it: one prompt, however many wires. One that's idle has finished already, and
   * the wire's Send now is there for that; one stopped hears at launch.
   */
  wired(id: string, w: Wire): void {
    const acting = w.type === "context" ? w.to : w.from;
    const s = this.o.sessions.list().find((x) => x.id === acting);
    if (!s || s.shell || s.debrief || (s.status !== "working" && s.status !== "waiting")) return;
    const state = this.o.store.wires();
    if (!state.book) {
      this.o.log(`wires: ${s.id} couldn't be told of wire ${id}`, state.refused ?? "the wires can't be read");
      return;
    }
    const ctx = this.o.rules.context(state.book);
    if (wireRefusal(w.from, w.to, w.type, { ...ctx, self: id })) return; // blocked by the rules: nothing it can use yet
    const otherId = acting === w.from ? w.to : w.from;
    const line: WireLine = { type: w.type, direction: acting === w.from ? "out" : "in", other: { id: otherId, title: ctx.end(otherId)?.title ?? otherId } };
    const lines = this.o.sessions.noticeWaiting(s.id, WIRES_NOTICE) ? [...(this.noticed.get(s.id) ?? []), line] : [line];
    try {
      this.o.sessions.deliverNotice(s.id, WIRES_NOTICE, wiredNotice(lines, verdictDue(acting, state.book.links)), this.o.submitOnDelivery(s));
      this.noticed.set(s.id, lines);
    } catch (err) {
      this.o.log(`wires: ${s.id} couldn't be told of wire ${id}`, err);
    }
  }

  /** Why the last launch started without word of its wires: said once per reason, as every launch asks. */
  private launchRefused: string | null = null;
  /** Sessions that launched before team rooms started, when every wire was refused: told of their wires once rooms have. */
  private unheard = new Set<string>();

  /** What session `id`'s agent is told about its wires as it launches (sessions.launchInstructions), or null. */
  launchInstructions(id: string): string | null {
    const state = this.o.store.wires();
    if (!state.book) {
      const why = state.refused ?? "the wires can't be read";
      if (why !== this.launchRefused) this.o.log(`wires: ${id} starts without word of its wires, and so does any launch until they can be read`, why);
      this.launchRefused = why;
      return null;
    }
    this.launchRefused = null;
    const ctx = this.o.rules.context(state.book);
    if (ctx.roomsUnknown) this.unheard.add(id);
    return wireInstructions(linesOf(id, state.book, ctx), verdictDue(id, state.book.links));
  }

  /**
   * Team rooms have started, or were found unable to: each agent still running that launched before then was told
   * nothing of its wires, as every wire was refused until rooms were known. It's told now, once, through its queue.
   */
  roomsStarted(): void {
    const ids = [...this.unheard];
    this.unheard.clear();
    if (!ids.length) return;
    const state = this.o.store.wires();
    if (!state.book) return void this.o.log(`wires: ${ids.join(", ")} launched before team rooms started, and can't be told of their wires now`, state.refused ?? "the wires can't be read");
    const ctx = this.o.rules.context(state.book);
    for (const id of ids) {
      const s = this.o.sessions.list().find((x) => x.id === id);
      if (!s || s.shell || s.debrief || s.status === "dead") continue;
      const lines = linesOf(id, state.book, ctx);
      const text = wireInstructions(lines, verdictDue(id, state.book.links));
      if (!text) continue;
      try {
        this.o.sessions.deliverNotice(id, WIRES_NOTICE, `[${text}]`, this.o.submitOnDelivery(s));
        this.noticed.set(id, lines);
      } catch (err) {
        this.o.log(`wires: ${id} launched before team rooms started, and couldn't be told of its wires once they had`, err);
      }
    }
  }

  /**
   * What W3 sends for wire `wireId`: `body` (the pending as the gate showed it, edited or not) with Mockingbird's label
   * and a fence made for this send, and, when the receiver has wires out, how it finishes its step. A feedback wire's
   * round is its `used` count, so it's called once the round is counted. Refused when the wire can't carry it now.
   */
  messageFor(wireId: string, body: string, o: { automatic: boolean }): { text: string } | { refused: string } {
    const state = this.o.store.wires();
    if (!state.book) return { refused: state.refused ?? "Wires can't be read right now." };
    const w = own(state.book.links, wireId);
    if (!w) return { refused: `There's no wire ${JSON.stringify(wireId)}.` };
    if (!carriesWork(w.type)) return { refused: `A ${w.type} wire carries nothing to send.` };
    const ctx = this.o.rules.context(state.book);
    const why = wireRefusal(w.from, w.to, w.type, { ...ctx, self: wireId });
    if (why) return { refused: why };
    // the receiver's wires out that it can use now: one the rules refuse (across a room's line, say) isn't named
    const out = Object.entries(state.book.links).flatMap(([k, x]) => (x.from === w.to && carriesWork(x.type) && !wireRefusal(x.from, x.to, x.type, { ...ctx, self: k }) ? [x] : []));
    return {
      text: wireMessage({
        type: w.type,
        from: labelled(this.session(w.from)!, ctx.end(w.from)!),
        body,
        automatic: o.automatic,
        ...(w.rounds ? { round: { n: w.rounds.used, of: w.rounds.limit } } : {}),
        next: out.length ? { to: out.map((x) => ctx.end(x.to)?.title ?? x.to), verdictDue: verdictDue(w.to, state.book.links) } : null,
      }),
    };
  }

  // ---- helpers ----------------------------------------------------------------------------

  /** A session of this Mac's, running or closed. */
  private session(id: string): SessionInfo | null {
    return this.o.sessions.list().find((s) => s.id === id) ?? this.o.sessions.resumable().find((s) => s.id === id) ?? null;
  }

  /** A read along a wire, or a refused one, in the message log: who read whom, how much and how it went, never what. */
  private logRead(me: SessionInfo, tool: string, of: string, ofTitle: string, outcome: string, refused = false): void {
    try {
      this.o.onMessage?.({ at: this.now(), from: me.id, fromTitle: me.ticketTitle ?? me.title, to: of, toTitle: ofTitle, text: `(${tool})`, outcome, ...(refused ? { refused } : {}) });
    } catch (err) {
      this.o.log(`wires: logging ${me.id}'s ${tool} of ${of}`, err);
    }
  }
}

/** What a pending was filled in from: a wire whose template or files change meanwhile isn't readied with it. */
export const filledFrom = (w: Wire): string => JSON.stringify([w.template ?? DEFAULT_TEMPLATE, w.files ?? null]);
export const usesSummary = (w: Wire): boolean => (w.template ?? DEFAULT_TEMPLATE).includes("{summary}");

/** Session `id`'s wires, either way, that the rules allow now: what it's told of them. */
function linesOf(id: string, book: WireBook, ctx: GateContext): WireLine[] {
  return Object.entries(book.links).flatMap(([k, w]): WireLine[] => {
    if (w.from !== id && w.to !== id) return [];
    if (wireRefusal(w.from, w.to, w.type, { ...ctx, self: k })) return []; // blocked by the rules now: nothing it can use
    const otherId = w.from === id ? w.to : w.from;
    return [{ type: w.type, direction: w.from === id ? "out" : "in", other: { id: otherId, title: ctx.end(otherId)?.title ?? otherId } }];
  });
}

/** The other end's name for the caller: its title, or its id alone across a room's line. */
export function titleAcross(ctx: GateContext, me: string, other: string): string {
  const a = ctx.end(me);
  const b = ctx.end(other);
  return !b || ctx.roomsUnknown || (a && a.room !== b.room) ? other : b.title;
}

function labelled(s: SessionInfo, e: WireEnd): LabelledEnd {
  return { id: s.id, title: e.title, agent: s.shell ? null : (s.agent ?? "claude"), repo: s.repoPath ? path.basename(s.repoPath) : null, branch: s.branch };
}

const unreadable = (problems: readonly { message: string }[]): string =>
  problems.length ? ` Some of the wires in landscape.json can't be read by this Mockingbird, and one of them may be it: ${problems.map((p) => p.message).join(" ")}` : "";

const redactionNote = (n: number): string => (n ? `\n[${n} secret-looking value${n === 1 ? " was" : "s were"} replaced with ${REDACTED}. Redaction is a net, not a guarantee.]` : "");

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? "" : "s"} ago` : `${Math.round(h / 24)} days ago`;
}

/** finish_step's answer to the agent: what happened along each wire, in Mockingbird's words. */
function finishReply(o: FinishOutcome): Reply {
  if ("refused" in o) return { error: o.refused };
  const lines = o.steps.map((s) => {
    const to = `the ${s.type} wire to ${quoted(s.toTitle)}`;
    if (s.does === "readies") {
      const gate = s.gate === "automatic" ? "Its gate is set to send it by itself, unless something holds it." : "It waits at the wire's gate for the user to send.";
      return `- ${to}: readied. ${gate}${s.pending?.flags.length ? ` The user is shown: ${s.pending.flags.join(" ")}` : ""}`;
    }
    if (s.does === "keeps") return `- ${to}: it goes when the user sends it, with your summary.`;
    if (s.does === "holds") return `- ${to}: held until your step finishes with "approve".${s.withdraws ? " What was waiting there was taken back." : ""}`;
    if (s.does === "passes") return `- ${to}: nothing goes back on "approve".${s.withdraws ? " The changes waiting there were taken back." : ""}`;
    return `- ${to}: not readied. ${s.why}`;
  });
  const redacted = o.redacted ? ` (${o.redacted} secret-looking value${o.redacted === 1 ? "" : "s"} in it replaced with ${REDACTED})` : "";
  return { result: [`Step finished: Mockingbird keeps your summary${redacted}. Along this workspace's wires:`, ...lines, "Nothing is sent until a gate opens."].join("\n") };
}
