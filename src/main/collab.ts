import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import type {
  CollabMessage,
  CollabMode,
  CollabModel,
  CollabParticipant,
  CollabRoom,
  NewSessionRequest,
  SessionInfo,
} from "../shared/types";
import { MB_DIR } from "./store";
import { quote, userShellWithInput } from "./shell";
import { paneEnv } from "./sessions";

/** The models a room can seat; each runs through the CLI and plan the user already has. */
export const COLLAB_MODELS: CollabModel[] = [
  { key: "gpt6", label: "GPT-6 Astra", agent: "codex", model: "gpt-6-astra" },
  { key: "opus", label: "Claude Opus 5.5", agent: "claude", model: "claude-opus-5-5" },
  { key: "fable", label: "Claude Fable 5.1", agent: "claude", model: "claude-fable-5-1" },
];

const DEFAULT_ROUNDS: Record<CollabMode, number> = { step: 1, auto: 3, consensus: 6 };

/** One model turn. Throws when the CLI fails; the room records it and moves on. */
export type TurnRunner = (
  p: CollabParticipant,
  prompt: string,
  ctx: { cwd: string; signal: AbortSignal; tag: string }
) => Promise<{ text: string; conversationId: string }>;

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
    .map((m) => `[${speakerName(room, m.speaker)}]${m.stance ? ` (stance: ${m.stance})` : ""}\n${m.text}`)
    .join("\n\n");
}

/** What a model is told on its turn: everything on its first turn, then only what's new to it. */
export function buildPrompt(room: CollabRoom, p: CollabParticipant, extra?: string): string {
  const unseen = room.messages
    .slice(p.lastSeen)
    .filter((m) => m.speaker !== p.key && m.speaker !== "system" && m.kind !== "error");
  const parts: string[] = [];
  if (!p.conversationId) {
    const others = room.participants.filter((x) => x.key !== p.key).map((x) => x.label);
    parts.push(
      `You are ${p.label}, one of ${room.participants.length} AI models in a discussion that Mockingbird is running for the user, who moderates. ` +
        (others.length ? `The others are ${others.join(" and ")}. ` : "") +
        "Turns go round-robin; you'll see what each of them says.",
      room.repoPath
        ? `You are in the repository at ${room.repoPath}. Read and search it to ground what you say. Don't edit files or run commands — nothing is changed until the user approves a plan.`
        : "There's no repository for this discussion; work from the brief.",
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

  create(spec: { title: string; brief: string; repoPath: string | null; models: string[]; mode?: CollabMode }): CollabRoom {
    const brief = spec.brief.trim();
    if (!brief) throw new Error("Describe the idea or feature to discuss");
    const models = spec.models.map((k) => COLLAB_MODELS.find((m) => m.key === k)).filter((m): m is CollabModel => !!m);
    if (models.length < 2) throw new Error("Pick at least two models");
    const mode = spec.mode ?? "auto";
    const room: CollabRoom = {
      id: randomUUID().slice(0, 8),
      title: spec.title.trim() || brief.split("\n")[0].slice(0, 60),
      brief,
      repoPath: spec.repoPath,
      participants: models.map((m) => ({ ...m, conversationId: null, lastSeen: 0 })),
      messages: [{ id: randomUUID().slice(0, 8), speaker: "you", text: brief, round: 0, at: Date.now() }],
      mode,
      maxRounds: DEFAULT_ROUNDS[mode],
      round: 0,
      running: false,
      speaking: null,
      plan: null,
      implementedIn: null,
      createdAt: Date.now(),
    };
    this.rooms.set(room.id, room);
    this.save(room);
    return room;
  }

  delete(id: string): void {
    this.stop(id);
    this.rooms.delete(id);
    fs.rmSync(this.file(id), { force: true });
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
        for (const p of room.participants) {
          if (ac.signal.aborted) break;
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
        if (failed === room.participants.length) {
          this.note(room, "Every model failed this round, so the room stopped. Check the errors above.");
          break;
        }
        if (room.mode === "consensus" && agreed === room.participants.length) {
          this.note(room, `All ${room.participants.length} models agree. Approve a proposal, or have one write up the plan.`);
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
    const prompt = buildPrompt(room, p, extra);
    try {
      const r = await this.runTurn(p, prompt, { cwd: this.cwdFor(room), signal, tag: `collab-${room.id}` });
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

  /** Ask one model to write the discussion up as a plan, for the user to approve. */
  async synthesize(id: string, key: string): Promise<CollabRoom> {
    const room = this.get(id);
    if (room.running) throw new Error("Wait for the current round to finish, or stop it");
    const p = room.participants.find((x) => x.key === key);
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
    const m = COLLAB_MODELS.find((x) => x.key === key);
    if (!m) throw new Error("Unknown model");
    const slug = room.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || room.id;
    const info = this.startSession({
      repoPath: room.repoPath,
      useWorktree: true,
      branchName: `collab-${slug}`,
      baseBranch: this.defaultBase(room.repoPath) ?? undefined,
      agent: m.agent,
      model: m.model,
      taskGroup: "Collaborate",
      title: `Collab — ${room.title}`,
      initialPrompt:
        `Implement this plan. It was worked out by ${room.participants.map((p) => p.label).join(", ")} ` +
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

  private cwdFor(room: CollabRoom): string {
    if (room.repoPath) return room.repoPath;
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
 * Real turns through the CLIs, read-only. The tag is exported as
 * MOCKINGBIRD_SESSION so these runs' hook events are never mistaken for a pane's.
 */
export function cliTurnRunner(binFor: (agent: "claude" | "codex") => string): TurnRunner {
  return async (p, prompt, { cwd, signal, tag }) => {
    const env = { ...paneEnv(), MOCKINGBIRD_SESSION: tag };
    const bin = binFor(p.agent);
    if (!bin.includes("/")) throw new Error(`${p.agent} isn't installed`);
    if (p.agent === "claude") {
      const cmd = [
        quote(bin),
        "-p",
        "--model", quote(p.model),
        "--output-format", "json",
        ...(p.conversationId ? ["--resume", quote(p.conversationId)] : []),
        "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash",
      ].join(" ");
      const r = await userShellWithInput(cmd, prompt, { cwd, env, signal });
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
      const cmd = p.conversationId
        ? `${quote(bin)} exec resume ${quote(p.conversationId)} --json --skip-git-repo-check -o ${quote(last)} -`
        : `${quote(bin)} exec --json --skip-git-repo-check -s read-only -m ${quote(p.model)} -o ${quote(last)} -`;
      const r = await userShellWithInput(cmd, prompt, { cwd, env, signal });
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
