import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import type {
  AgentKind,
  CollabMessage,
  CollabMode,
  CollabModel,
  CollabParticipant,
  CollabParticipantSpec,
  CollabRoom,
  NewSessionRequest,
  SessionInfo,
} from "../shared/types";
import { MB_DIR } from "./store";
import { quote, userShellWithInput } from "./shell";
import { paneEnv } from "./sessions";
import { mcpLaunch, type McpLaunch } from "./messaging";
import { makeTestCopy } from "./testCopy";

/** The models a room can seat; each runs through the CLI and plan the user already has. */
export const COLLAB_MODELS: CollabModel[] = [
  { key: "gpt6", label: "GPT-6 Astra", agent: "codex", model: "gpt-6-astra" },
  { key: "opus", label: "Claude Opus 5.5", agent: "claude", model: "claude-opus-5-5" },
  { key: "fable", label: "Claude Fable 5.1", agent: "claude", model: "claude-fable-5-1" },
];

/** Effort levels each CLI accepts (Claude's --effort, Codex's model_reasoning_effort). */
export const COLLAB_EFFORTS: Record<AgentKind, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

const DEFAULT_ROUNDS: Record<CollabMode, number> = { step: 1, auto: 3, consensus: 6 };
const PALETTE_SIZE = 6;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]{0,80}$/;

const active = (room: CollabRoom) => room.participants.filter((p) => !p.removed);

/** Who's in the room and who can read the code — repeated each turn, since it can change. */
function rosterLine(room: CollabRoom, p: CollabParticipant): string {
  const others = active(room).filter((x) => x.key !== p.key);
  const access = !room.repoPath
    ? "There's no repository for this discussion."
    : p.runsCommands
      ? `You can read the code and run commands — tests, builds, scripts — in a disposable copy of the repository at ${room.workspacePath ?? "(made when your turn starts)"}, ` +
        `made from ${room.repoPath} with the user's uncommitted work (you're in it). ${
          p.agent === "codex" ? "Use shell commands" : "Use Bash to run things, and your file tools to read and to write files there (test scripts, probes, trial changes)"
        }. Anything you change there is thrown away and never reaches the user's code, but don't implement the feature: run things to check facts and test ideas. ` +
        "Files git ignores (like node_modules) aren't copied — install dependencies first if a command needs them. The network is available; Docker isn't, so ask the user to start any containers you need. " +
        "MCP and app tools are switched off in this discussion."
      : p.readsCode
      ? `You can read the repository at ${room.repoPath} (you're in it) — ${
          p.agent === "codex" ? "read and search it with shell commands like cat, ls, rg and git log" : "read and search it with your file tools"
        }. Don't change anything: nothing is edited until the user approves a plan. MCP and app tools are switched off in this discussion.`
      : codeReaderFor(room, p.key)
      ? `There's a repository, but you can't read it yourself. When something depends on the code, call the ask_code_reader tool: ${codeReaderFor(room, p.key)!.label} looks it up and the answer comes back within your turn.`
      : "There's a repository, but nobody in the room can read it right now.";
  const role = (o: CollabParticipant) => (!room.repoPath ? "" : o.runsCommands ? " (reads the code, runs commands)" : o.readsCode ? " (reads the code)" : "");
  return `In the room: ${others.map((o) => o.label + role(o)).join(", ") || "only you"}. ${access}`;
}

/** One model turn. Throws when the CLI fails; the room records it and moves on. */
export type TurnRunner = (
  p: CollabParticipant,
  prompt: string,
  // askTool: give this model the ask_code_reader tool (it can't read the repo, someone else can)
  ctx: { cwd: string; signal: AbortSignal; tag: string; askTool: boolean }
) => Promise<{ text: string; conversationId: string }>;

const MAX_LOOKUPS_PER_TURN = 4;
const MAX_QUESTION = 4000;

/** The seat a non-reader's questions go to: the first model in speaking order that reads the code. */
function codeReaderFor(room: CollabRoom, askerKey: string): CollabParticipant | undefined {
  return room.repoPath ? active(room).find((x) => x.readsCode && x.key !== askerKey) : undefined;
}

const STANCE_RE = /\n?\s*STANCE:\s*(AGREE|CONTINUE)\b[^\n]*\s*$/i;

/** Split a reply into its text and the closing STANCE line every turn ends with. */
export function parseStance(reply: string): { text: string; stance?: "agree" | "continue" } {
  const m = STANCE_RE.exec(reply.trimEnd());
  if (!m) return { text: reply.trim() };
  return { text: reply.trimEnd().slice(0, m.index).trim(), stance: m[1].toUpperCase() === "AGREE" ? "agree" : "continue" };
}

function speakerName(room: CollabRoom, speaker: string): string {
  if (speaker === "you") return "User";
  return room.participants.find((p) => p.key === speaker)?.label ?? speaker;
}

function transcriptLines(room: CollabRoom, msgs: CollabMessage[]): string {
  return msgs
    .map((m) =>
      m.kind === "lookup"
        ? `[${speakerName(room, m.speaker)} answering ${speakerName(room, m.askedBy ?? "")}'s code question]\n${m.text}`
        : `[${speakerName(room, m.speaker)}]${m.stance ? ` (stance: ${m.stance})` : ""}\n${m.text}`
    )
    .join("\n\n");
}

/** What a model is told on its turn: everything on its first turn, then only what's new to it. */
export function buildPrompt(room: CollabRoom, p: CollabParticipant, extra?: string): string {
  const unseen = room.messages
    .slice(p.lastSeen)
    // a model's own words aren't repeated back — except lookups, which a reader
    // answered in its separate lookup thread; and a lookup this model asked for
    // was already answered inside its own turn
    .filter((m) => (m.speaker !== p.key || m.kind === "lookup") && m.speaker !== "system" && m.kind !== "error" && m.askedBy !== p.key);
  const parts: string[] = [];
  if (!p.conversationId) {
    parts.push(
      `You are ${p.label}, one of ${active(room).length} AI models in a discussion that Mockingbird is running for the user, who moderates. ` +
        "Turns go round-robin; you'll see what each of the others says. Models may join or leave along the way.",
      rosterLine(room, p),
      [
        "How to take part:",
        "- Build on, challenge or refine what the others said. Be concrete; disagree when you disagree.",
        "- Keep a turn under about 300 words unless detail is genuinely needed.",
        "- Speak only as yourself. Never write the other models' or the user's lines.",
        '- End every turn with one line: "STANCE: AGREE" if you would ship the leading proposal as it stands, or "STANCE: CONTINUE — <what is unresolved>".',
      ].join("\n"),
      `The topic:\n${room.brief}`
    );
    const sofar = unseen.filter((m) => m !== room.messages[0]); // the brief is already above
    if (sofar.length) parts.push(`The discussion so far:\n\n${transcriptLines(room, sofar)}`);
  } else {
    parts.push(rosterLine(room, p));
    parts.push(unseen.length ? `New since your last turn:\n\n${transcriptLines(room, unseen)}` : "Nobody has spoken since your last turn.");
  }
  parts.push(extra ?? "It's your turn.");
  return parts.join("\n\n");
}

const SYNTH_INSTRUCTION =
  "The user has asked you to write up the plan. Using the whole discussion, write the final plan as markdown: " +
  "the goal, the decisions made (and why), the steps to implement, the files likely involved, risks, and how to verify it. " +
  "Where the models disagreed and it wasn't settled, say so and give your recommendation. " +
  "This is a document, not a turn — don't add a STANCE line.";

/** Rooms persisted as one JSON file each; the runner advances them turn by turn. */
export class CollabRooms {
  private rooms = new Map<string, CollabRoom>();
  private aborts = new Map<string, AbortController>();
  private lookups = new Map<string, number>(); // `${room}.${seat}.${round}` → questions asked this turn

  constructor(
    private dir: string,
    private runTurn: TurnRunner,
    private onChange: (room: CollabRoom) => void,
    private startSession: (req: NewSessionRequest) => SessionInfo,
    private defaultBase: (repoPath: string) => string | null
  ) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const room = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as CollabRoom;
        // a turn in flight when the app quit is lost; the room waits for the user
        room.running = false;
        room.speaking = null;
        room.participants.forEach((p, i) => {
          p.effort ??= null;
          p.readsCode ??= true;
          p.runsCommands ??= false;
          p.color ??= i % PALETTE_SIZE;
        });
        room.workspacePath ??= null;
        this.rooms.set(room.id, room);
      } catch (err) {
        console.error(`collab: skipping unreadable room ${f}:`, err);
      }
    }
  }

  list(): CollabRoom[] {
    return [...this.rooms.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): CollabRoom {
    const room = this.rooms.get(id);
    if (!room) throw new Error("That room no longer exists");
    return room;
  }

  create(spec: { title: string; brief: string; repoPath: string | null; participants: CollabParticipantSpec[]; mode?: CollabMode }): CollabRoom {
    const brief = spec.brief.trim();
    if (!brief) throw new Error("Describe the idea or feature to discuss");
    if (spec.participants.length < 2) throw new Error("Pick at least two models");
    const mode = spec.mode ?? "auto";
    const room: CollabRoom = {
      id: randomUUID().slice(0, 8),
      title: spec.title.trim() || brief.split("\n")[0].slice(0, 60),
      brief,
      repoPath: spec.repoPath,
      participants: [],
      messages: [{ id: randomUUID().slice(0, 8), speaker: "you", text: brief, round: 0, at: Date.now() }],
      mode,
      maxRounds: DEFAULT_ROUNDS[mode],
      round: 0,
      running: false,
      speaking: null,
      plan: null,
      implementedIn: null,
      workspacePath: null,
      createdAt: Date.now(),
    };
    for (const s of spec.participants) room.participants.push(this.seat(room, s));
    this.rooms.set(room.id, room);
    this.save(room);
    return room;
  }

  /** A new participant from a spec, validated, with its own key and color. */
  private seat(room: CollabRoom, s: CollabParticipantSpec): CollabParticipant {
    if (s.agent !== "claude" && s.agent !== "codex") throw new Error(`Unknown agent "${s.agent}"`);
    const model = s.model.trim();
    if (!MODEL_ID_RE.test(model)) throw new Error(`"${s.model}" isn't a valid model id`);
    if (s.effort && !COLLAB_EFFORTS[s.agent].includes(s.effort)) {
      throw new Error(`${s.effort} isn't an effort level ${s.agent === "codex" ? "Codex" : "Claude"} accepts`);
    }
    const used = new Set(room.participants.filter((p) => !p.removed).map((p) => p.color));
    const color = [...Array(PALETTE_SIZE).keys()].find((c) => !used.has(c)) ?? room.participants.length % PALETTE_SIZE;
    const preset = COLLAB_MODELS.find((m) => m.agent === s.agent && m.model === model);
    let key = preset?.key ?? model.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    while (room.participants.some((p) => p.key === key)) key = `${key}-${randomUUID().slice(0, 4)}`;
    return {
      key,
      label: s.label.trim() || preset?.label || model,
      agent: s.agent,
      model,
      effort: s.effort || null,
      readsCode: !!s.readsCode || !!s.runsCommands,
      runsCommands: !!s.runsCommands,
      color,
      conversationId: null,
      lastSeen: 0,
    };
  }

  /**
   * Set the room's seats. Existing seats (by key) keep their conversation — effort
   * and code access apply from their next turn; seats left out leave the room;
   * new specs join and see the whole discussion on their first turn.
   */
  setParticipants(id: string, specs: CollabParticipantSpec[]): CollabRoom {
    const room = this.get(id);
    const kept = new Set(specs.filter((s) => s.key).map((s) => s.key));
    if (specs.length < 1) throw new Error("A room needs at least one model");
    const notes: string[] = [];
    for (const p of room.participants) {
      if (p.removed || kept.has(p.key)) continue;
      p.removed = true;
      notes.push(`${p.label} left the room.`);
    }
    for (const s of specs) {
      const p = s.key ? room.participants.find((x) => x.key === s.key) : undefined;
      if (!p) {
        const seat = this.seat(room, s);
        room.participants.push(seat);
        notes.push(`${seat.label} joined${!room.repoPath ? "" : seat.runsCommands ? " and can read the code and run commands" : seat.readsCode ? " and can read the code" : ""}.`);
        continue;
      }
      if (s.effort && !COLLAB_EFFORTS[p.agent].includes(s.effort)) throw new Error(`${s.effort} isn't an effort level for ${p.label}`);
      const reads = !!s.readsCode || !!s.runsCommands;
      if (p.readsCode !== reads && room.repoPath) notes.push(`${p.label} ${reads ? "can now read" : "can no longer read"} the code.`);
      if (!!p.runsCommands !== !!s.runsCommands && room.repoPath) notes.push(`${p.label} ${s.runsCommands ? "can now run" : "can no longer run"} commands.`);
      p.removed = false;
      p.effort = s.effort || null;
      p.readsCode = reads;
      p.runsCommands = !!s.runsCommands;
      if (s.label.trim()) p.label = s.label.trim();
    }
    // the speaking order follows the specs
    const order = specs.map((s) => s.key);
    room.participants.sort((a, b) => {
      const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });
    for (const n of notes) this.note(room, n);
    this.save(room);
    return room;
  }

  /** Point the room at a repository (or none). Conversations continue; readers read the new one from their next turn. */
  setRepo(id: string, repoPath: string | null): CollabRoom {
    const room = this.get(id);
    if (repoPath === room.repoPath) return room;
    if (repoPath && !fs.existsSync(repoPath)) throw new Error(`${repoPath} doesn't exist`);
    room.repoPath = repoPath;
    this.dropTestCopy(room); // it was made from the old repository
    this.note(room, repoPath ? `Repository set to ${path.basename(repoPath)}.` : "Repository removed — models no longer read code.");
    this.save(room);
    return room;
  }

  delete(id: string): void {
    this.stop(id);
    const room = this.rooms.get(id);
    if (room) this.dropTestCopy(room);
    this.rooms.delete(id);
    fs.rmSync(this.file(id), { force: true });
  }

  /** Throw the test copy away; the next command-running turn makes a fresh one from the repo as it is now. */
  resetTestCopy(id: string): CollabRoom {
    const room = this.get(id);
    if (room.running) throw new Error("Wait for the current turn to finish, or stop it");
    this.dropTestCopy(room);
    this.note(room, "Test copy reset — the next model that runs commands gets a fresh copy of the repository.");
    this.save(room);
    return room;
  }

  private dropTestCopy(room: CollabRoom): void {
    fs.rmSync(this.testCopyDir(room), { recursive: true, force: true });
    room.workspacePath = null;
  }

  private testCopyDir(room: CollabRoom): string {
    return path.join(this.dir, "work", room.id);
  }

  setMode(id: string, mode: CollabMode, maxRounds?: number): CollabRoom {
    const room = this.get(id);
    room.mode = mode;
    room.maxRounds = Math.max(1, Math.min(20, Math.round(maxRounds ?? DEFAULT_ROUNDS[mode])));
    this.save(room);
    return room;
  }

  /** The user speaks; it reaches each model on its next turn. Starts the room if it's idle. */
  send(id: string, text: string): CollabRoom {
    const room = this.get(id);
    const t = text.trim();
    if (!t) throw new Error("Message is empty");
    room.messages.push({ id: randomUUID().slice(0, 8), speaker: "you", text: t, round: room.round, at: Date.now() });
    this.save(room);
    if (!room.running) void this.run(id);
    return room;
  }

  stop(id: string): void {
    this.aborts.get(id)?.abort();
  }

  /** Advance the room by its mode: one round, N rounds, or until every model agrees (capped). */
  async run(id: string): Promise<void> {
    const room = this.get(id);
    if (room.running) return;
    const ac = new AbortController();
    this.aborts.set(id, ac);
    room.running = true;
    this.save(room);
    let rounds = 0;
    try {
      for (;;) {
        const roundNo = room.round + 1;
        let agreed = 0;
        let failed = 0;
        const seats = active(room);
        for (const p of seats) {
          if (ac.signal.aborted) break;
          if (p.removed) continue; // left the room mid-round
          const r = await this.turn(room, p, ac.signal, roundNo);
          if (r === "agree") agreed++;
          if (r === "error") failed++;
        }
        if (ac.signal.aborted) {
          this.note(room, "Stopped.");
          break;
        }
        room.round = roundNo;
        rounds++;
        if (failed === seats.length) {
          this.note(room, "Every model failed this round, so the room stopped. Check the errors above.");
          break;
        }
        if (room.mode === "consensus" && agreed === seats.length) {
          this.note(room, `All ${seats.length} models agree. Approve a proposal, or have one write up the plan.`);
          break;
        }
        if (room.mode === "step") break;
        if (rounds >= room.maxRounds) {
          if (room.mode === "consensus") this.note(room, `No agreement after ${rounds} rounds — paused for you.`);
          break;
        }
      }
    } finally {
      room.running = false;
      room.speaking = null;
      this.aborts.delete(id);
      this.save(room);
    }
  }

  /** One model's turn; returns its stance, or "error" when its CLI failed (recorded in the room). */
  private async turn(room: CollabRoom, p: CollabParticipant, signal: AbortSignal, roundNo: number, extra?: string, kind?: "plan") {
    room.speaking = p.key;
    this.save(room);
    const shown = room.messages.length;
    try {
      const cwd = await this.cwdFor(room, p);
      const prompt = buildPrompt(room, p, extra);
      const askTool = !!codeReaderFor(room, p.key) && !p.readsCode;
      const r = await this.runTurn(p, prompt, { cwd, signal, tag: `collab-${room.id}.${p.key}`, askTool });
      if (signal.aborted) return "stopped" as const;
      p.conversationId = r.conversationId;
      p.lastSeen = shown;
      const { text, stance } = kind === "plan" ? { text: r.text.trim(), stance: undefined } : parseStance(r.text);
      room.messages.push({ id: randomUUID().slice(0, 8), speaker: p.key, text, round: roundNo, at: Date.now(), stance, kind });
      return stance ?? ("continue" as const);
    } catch (err) {
      if (signal.aborted) return "stopped" as const;
      const msg = err instanceof Error ? err.message : String(err);
      room.messages.push({ id: randomUUID().slice(0, 8), speaker: p.key, text: `${p.label} couldn't take its turn: ${msg}`, round: roundNo, at: Date.now(), kind: "error" });
      return "error" as const;
    } finally {
      room.speaking = null;
      this.save(room);
    }
  }

  /** A request from a room model's MCP tool (tagged collab-<room>.<seat>). */
  async handleRoomRequest(roomId: string, seatKey: string, op: string, args: Record<string, unknown>): Promise<{ result: unknown } | { error: string }> {
    if (op !== "ask_code_reader") return { error: `Unknown tool: ${op}` };
    try {
      return { result: await this.askCodeReader(roomId, seatKey, String(args.question ?? "")) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * A model that can't read the code asks one that can. The reader answers in its
   * own lookup thread (so the discussion isn't cluttered and it keeps what it has
   * learned of the codebase), and the exchange is added to the transcript.
   */
  async askCodeReader(roomId: string, askerKey: string, question: string): Promise<string> {
    const room = this.get(roomId);
    const asker = active(room).find((p) => p.key === askerKey);
    if (!asker) throw new Error("You're no longer in this room.");
    const q = question.trim();
    if (!q) throw new Error("The question is empty.");
    if (q.length > MAX_QUESTION) throw new Error(`The question is ${q.length} characters; keep it under ${MAX_QUESTION}.`);
    const reader = codeReaderFor(room, askerKey);
    if (!reader) throw new Error("Nobody in this room can read the code right now.");
    const roundNo = room.round + 1;
    const countKey = `${room.id}.${askerKey}.${roundNo}`;
    const asked = this.lookups.get(countKey) ?? 0;
    if (asked >= MAX_LOOKUPS_PER_TURN) {
      throw new Error(`That's ${MAX_LOOKUPS_PER_TURN} questions this turn — finish your turn with what you have, or ask again next round.`);
    }
    this.lookups.set(countKey, asked + 1);

    // lookups read the real checkout, so they never run commands — that's what the test copy is for
    const seat: CollabParticipant = { ...reader, runsCommands: false, conversationId: reader.lookupConversationId ?? null };
    const prompt = reader.lookupConversationId
      ? `Question from ${asker.label}:\n${q}`
      : [
          `You are ${reader.label}, the code reader for a discussion Mockingbird is running about:\n${room.brief}`,
          `The other models can't read the repository at ${room.repoPath}; they send you questions about it. Answer from the code itself: ` +
            `${reader.agent === "codex" ? "search and read it with shell commands like rg, cat, ls and git log" : "search and read it with your file tools"}, ` +
            "give file paths (and line numbers where useful), quote short snippets when they help, and say plainly when something isn't there. " +
            "Your answer goes straight back to the asker mid-turn: be direct and complete, under about 250 words. Don't change anything.",
          `Question from ${asker.label}:\n${q}`,
        ].join("\n\n");
    const signal = this.aborts.get(room.id)?.signal ?? new AbortController().signal;
    const r = await this.runTurn(seat, prompt, { cwd: room.repoPath!, signal, tag: `collab-${room.id}.${reader.key}`, askTool: false });
    reader.lookupConversationId = r.conversationId;
    const answer = r.text.trim();
    room.messages.push({
      id: randomUUID().slice(0, 8),
      speaker: reader.key,
      askedBy: asker.key,
      kind: "lookup",
      text: `${asker.label} asked: ${q}\n\n${answer}`,
      round: roundNo,
      at: Date.now(),
    });
    this.save(room);
    return answer;
  }

  /** Ask one model to write the discussion up as a plan, for the user to approve. */
  async synthesize(id: string, key: string): Promise<CollabRoom> {
    const room = this.get(id);
    if (room.running) throw new Error("Wait for the current round to finish, or stop it");
    const p = active(room).find((x) => x.key === key);
    if (!p) throw new Error("That model isn't in this room");
    const ac = new AbortController();
    this.aborts.set(id, ac);
    room.running = true;
    try {
      const r = await this.turn(room, p, ac.signal, room.round, SYNTH_INSTRUCTION, "plan");
      if (r === "error") throw new Error(room.messages[room.messages.length - 1].text);
      const plan = room.messages[room.messages.length - 1];
      if (r !== "stopped") room.plan = { text: plan.text, by: p.key, approved: false, at: Date.now() };
    } finally {
      room.running = false;
      room.speaking = null;
      this.aborts.delete(id);
      this.save(room);
    }
    return room;
  }

  /** Approve a model's message (a proposal or a written-up plan) as the plan to implement. */
  approve(id: string, messageId: string): CollabRoom {
    const room = this.get(id);
    const m = room.messages.find((x) => x.id === messageId);
    if (!m || m.speaker === "you" || m.speaker === "system" || m.kind === "error") throw new Error("Only a model's proposal can be approved");
    room.plan = { text: m.text, by: m.speaker, approved: true, at: Date.now() };
    this.note(room, `Plan approved: ${speakerName(room, m.speaker)}'s ${m.kind === "plan" ? "write-up" : "proposal"}.`);
    this.save(room);
    return room;
  }

  /** Hand the approved plan to one model as a normal session on a new branch — the only place edits happen. */
  implement(id: string, key: string): SessionInfo {
    const room = this.get(id);
    if (!room.plan?.approved) throw new Error("Approve a plan first");
    if (!room.repoPath) throw new Error("This room has no repository to implement in");
    const m = active(room).find((x) => x.key === key);
    if (!m) throw new Error("That model isn't in this room");
    const slug = room.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || room.id;
    const info = this.startSession({
      repoPath: room.repoPath,
      useWorktree: true,
      branchName: `collab-${slug}`,
      baseBranch: this.defaultBase(room.repoPath) ?? undefined,
      agent: m.agent,
      model: m.model,
      ...(m.effort ? { effort: m.effort } : {}),
      taskGroup: "Collaborate",
      title: `Collab — ${room.title}`,
      initialPrompt:
        `Implement this plan. It was worked out by ${active(room).map((p) => p.label).join(", ")} ` +
        `in a Mockingbird Collaborate room and approved by the user.\n\n${room.plan.text}`,
    });
    room.implementedIn = info.id;
    this.note(room, `${m.label} is implementing the plan in a new session on branch collab-${slug}.`);
    this.save(room);
    return info;
  }

  private note(room: CollabRoom, text: string): void {
    room.messages.push({ id: randomUUID().slice(0, 8), speaker: "system", text, round: room.round, at: Date.now() });
  }

  /**
   * Models that run commands work in the room's test copy (made on first need);
   * those that only read work in the repo; the rest in the room's own empty folder.
   */
  private async cwdFor(room: CollabRoom, p: CollabParticipant): Promise<string> {
    if (room.repoPath && p.runsCommands) {
      const dest = this.testCopyDir(room);
      if (room.workspacePath && fs.existsSync(path.join(dest, ".git"))) return dest;
      const made = await makeTestCopy(room.repoPath, dest);
      room.workspacePath = dest;
      this.note(room, `Made a test copy of ${path.basename(room.repoPath)} (${made}) for the models that run commands. Changes there never reach your code.`);
      return dest;
    }
    if (room.repoPath && p.readsCode) return room.repoPath;
    const d = path.join(this.dir, room.id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private save(room: CollabRoom): void {
    fs.writeFileSync(this.file(room.id), JSON.stringify(room, null, 2));
    this.onChange(room);
  }
}

/**
 * Claude's OS sandbox for a seat that runs commands: Bash runs without asking,
 * can write only inside its cwd (the test copy), can't escape the sandbox, and
 * can reach the network (package installs, local services).
 */
const CLAUDE_COMMAND_SANDBOX = JSON.stringify({
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowLocalBinding: true, allowedDomains: ["*"] },
  },
});

/**
 * One Claude turn. A seat that runs commands works in the test copy: Bash in the
 * OS sandbox, and file edits auto-accepted only inside its cwd (acceptEdits
 * refuses paths outside it headless) — scripts are written with Write because
 * Bash refuses heredocs that look like obfuscation. Every other seat works on
 * the real checkout, so its edit tools and Bash are off; a seat without code
 * access can't read files either. --strict-mcp-config with no --mcp-config leaves no MCP
 * servers: their tools can act outside the folder (post messages, change other systems).
 */
export function claudeTurnCommand(bin: string, p: CollabParticipant, ask?: McpLaunch): string {
  return [
    quote(bin),
    "-p",
    "--model", quote(p.model),
    "--output-format", "json",
    "--strict-mcp-config",
    // the one MCP tool a room allows: asking the code reader
    ...(ask
      ? ["--mcp-config", quote(JSON.stringify({ mcpServers: { mockingbird: { type: "stdio", ...ask } } })), "--allowedTools", "mcp__mockingbird__ask_code_reader"]
      : []),
    ...(p.conversationId ? ["--resume", quote(p.conversationId)] : []),
    ...(p.effort ? ["--effort", quote(p.effort)] : []),
    ...(p.runsCommands
      ? ["--settings", quote(CLAUDE_COMMAND_SANDBOX), "--permission-mode", "acceptEdits", "--disallowedTools", "NotebookEdit"]
      : ["--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]),
    ...(p.readsCode || p.runsCommands ? [] : ["Read", "Grep", "Glob", "LS"]),
  ].join(" ");
}

/**
 * One Codex turn; its reply is written to `lastFile`. Headless Codex can't ask
 * for approval, so in a folder it doesn't trust it refuses even to read;
 * approval_policy=never lets it act within the sandbox, and the sandbox is what
 * keeps it from writing: read-only, or for a seat that runs commands
 * workspace-write with the network on — writes confined to its cwd (the test
 * copy) and temp folders. The sandbox goes in -c because `exec resume` has no -s. Apps, plugins and MCP
 * servers are switched off — their tools act outside the sandbox — and any MCP
 * call that slips through needs approval, which "never" refuses.
 */
export function codexTurnCommand(bin: string, p: CollabParticipant, lastFile: string, ask?: McpLaunch): string {
  // the one MCP tool a room allows: asking the code reader (pre-approved; a lookup can take minutes)
  const askFlags = ask
    ? [
        `mcp_servers.mockingbird.command=${JSON.stringify(ask.command)}`,
        `mcp_servers.mockingbird.args=${JSON.stringify(ask.args)}`,
        `mcp_servers.mockingbird.env={${Object.entries(ask.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}}`,
        'mcp_servers.mockingbird.default_tools_approval_mode="approve"',
        "mcp_servers.mockingbird.tool_timeout_sec=600",
      ].map((c) => `-c ${quote(c)} `).join("")
    : "";
  const sandbox = p.runsCommands
    ? `-c ${quote('sandbox_mode="workspace-write"')} -c ${quote("sandbox_workspace_write.network_access=true")} `
    : `-c ${quote('sandbox_mode="read-only"')} `;
  const flags =
    (p.effort ? `-c ${quote(`model_reasoning_effort="${p.effort}"`)} ` : "") +
    `--disable apps --disable plugins -c ${quote("mcp_servers={}")} ${askFlags}-c ${quote('approval_policy="never"')} ${sandbox}`;
  return p.conversationId
    ? `${quote(bin)} exec resume ${quote(p.conversationId)} ${flags}--json --skip-git-repo-check -o ${quote(lastFile)} -`
    : `${quote(bin)} exec ${flags}--json --skip-git-repo-check -m ${quote(p.model)} -o ${quote(lastFile)} -`;
}

/**
 * Real turns through the CLIs. The tag is exported as
 * MOCKINGBIRD_SESSION so these runs' hook events are never mistaken for a pane's.
 */
export function cliTurnRunner(binFor: (agent: "claude" | "codex") => string): TurnRunner {
  return async (p, prompt, { cwd, signal, tag, askTool }) => {
    const env = { ...paneEnv(), MOCKINGBIRD_SESSION: tag };
    const ask = askTool ? mcpLaunch(tag) : undefined;
    const bin = binFor(p.agent);
    // installs and test suites can take a while; a reading turn that runs this long is stuck
    const timeoutMs = p.runsCommands ? 30 * 60_000 : 10 * 60_000;
    if (!bin.includes("/")) throw new Error(`${p.agent} isn't installed`);
    if (p.agent === "claude") {
      const r = await userShellWithInput(claudeTurnCommand(bin, p, ask), prompt, { cwd, env, signal, timeoutMs });
      let out: any;
      try {
        out = JSON.parse(r.out);
      } catch {
        throw new Error(r.out.slice(0, 400) || `claude exited with code ${r.code}`);
      }
      if (r.code !== 0 || out.is_error) throw new Error(String(out.result ?? `claude exited with code ${r.code}`).slice(0, 400));
      return { text: String(out.result ?? ""), conversationId: String(out.session_id) };
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-collab-"));
    const last = path.join(tmp, "reply.txt");
    try {
      const r = await userShellWithInput(codexTurnCommand(bin, p, last, ask), prompt, { cwd, env, signal, timeoutMs });
      const thread = /"thread_id":"([^"]+)"/.exec(r.out)?.[1] ?? p.conversationId;
      let text = "";
      try {
        text = fs.readFileSync(last, "utf8");
      } catch {
        /* no reply written — reported just below with the CLI's output */
      }
      if (r.code !== 0 || !text.trim() || !thread) throw new Error((r.out.split("\n").filter((l) => /error/i.test(l)).pop() ?? r.out).slice(0, 400) || `codex exited with code ${r.code}`);
      return { text, conversationId: thread };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

export const COLLAB_DIR = path.join(MB_DIR, "collab");
