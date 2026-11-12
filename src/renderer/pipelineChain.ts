import type { SessionInfo, SessionStatus } from "../shared/types";
import { wiresInOrder, type Gate, type Wire, type WireRounds, type WireType } from "../shared/wires";
import { shortWhy } from "./wiresModel";

/**
 * The pipeline strip's chain (docs/landscape.md, Focus; docs/landscape-wires.md, W6): the path of handoff and feedback
 * wires through one workspace. Upstream is one chain and downstream the first branch; the other branches at each step
 * are its `also`, the strip's +n chip. Workspaces wired to it by a shared worktree or a context link are `attached`,
 * at the strip's right end. Handoffs are walked before feedback, each in the order it was made (wiresInOrder).
 */

/** A step's workspace as the strip names it. */
export interface StepEnd {
  title: string;
  /** Its agent ("claude", "codex"), or "terminal". */
  agent: string;
  status: SessionStatus;
  /** open: on the landscape; ghost: closed, drawn where it was; planned: not started; closed: closed with no place (the Closed sessions list). */
  where: "open" | "ghost" | "planned" | "closed";
}

/** A wire the walk took, with its gate as it is now. */
export interface Hop {
  wire: string;
  type: WireType;
  gate: Gate;
  rounds?: WireRounds;
}

export interface Step {
  id: string;
  /** Null: no session of this Mac's has the id. */
  end: StepEnd | null;
  /** Upstream, the wire from it towards this workspace; downstream, the wire into it from the step before. Null for this one. */
  hop: Hop | null;
  /** A wire carrying work from it back to a step already in the chain (a feedback loop): its round chip. */
  back: (Hop & { to: string }) | null;
  /** The other workspaces the walk could have taken here: wired from the same step before it (downstream), or into the same step after it (upstream). */
  also: Step[];
}

export interface Attached {
  id: string;
  end: StepEnd | null;
  wire: string;
  type: "worktree" | "context";
  /** A context link into this workspace: it reads the other's context, rather than the other reading its. */
  reads: boolean;
}

export interface Chain {
  /** Farthest first, the last one leading into this one. */
  up: Step[];
  here: Step;
  /** Nearest first. */
  down: Step[];
  attached: Attached[];
}

type Entry = [string, Wire];

/**
 * Workspace `here`'s chain, or null when it has no wires (no strip). `end` names each step's workspace; `gate` is each
 * wire's gate now. A loop (a feedback wire, or a cycle of handoffs a damaged book could hold) never walks a workspace
 * twice: the wire closing it is the step's `back`.
 */
export function chainOf(here: string, links: Readonly<Record<string, Wire>>, end: (id: string) => StepEnd | null, gate: (id: string, w: Wire) => Gate): Chain | null {
  const all = wiresInOrder(links);
  if (!all.some(([, w]) => w.from === here || w.to === here)) return null;
  /** The wires carrying work that `pick` takes: handoffs first, then feedback. */
  const carrying = (pick: (w: Wire) => boolean): Entry[] => [...all.filter(([, w]) => w.type === "handoff" && pick(w)), ...all.filter(([, w]) => w.type === "feedback" && pick(w))];
  const hop = ([id, w]: Entry): Hop => ({ wire: id, type: w.type, gate: gate(id, w), ...(w.rounds ? { rounds: w.rounds } : {}) });
  const step = (id: string, via: Entry | null): Step => ({ id, end: end(id), hop: via ? hop(via) : null, back: null, also: [] });
  /** From `at`, along the wires `next` gives, to workspaces not in `seen`; each one taken is added to `seen`. */
  const walk = (at: string, seen: Set<string>, next: (at: string) => Entry[], far: (w: Wire) => string): Step[] => {
    const out: Step[] = [];
    for (;;) {
      const [first, ...rest] = next(at).filter(([, w]) => !seen.has(far(w)));
      if (!first) return out;
      const s = step(far(first[1]), first);
      // a handoff and a feedback wire can join the same two workspaces: each other workspace once, by its first wire
      const also = new Map<string, Entry>();
      for (const r of rest) if (far(r[1]) !== s.id && !also.has(far(r[1]))) also.set(far(r[1]), r);
      s.also = [...also].map(([id, r]) => step(id, r));
      out.push(s);
      seen.add(s.id);
      at = s.id;
    }
  };
  // everything handing work on to this one, so downstream never walks back up a feedback wire into it
  const seen = new Set([here]);
  for (const todo = [here]; todo.length; ) {
    const at = todo.pop()!;
    for (const [, w] of all) {
      if (w.type !== "handoff" || w.to !== at || seen.has(w.from)) continue;
      seen.add(w.from);
      todo.push(w.from);
    }
  }
  const down = walk(here, seen, (at) => carrying((w) => w.from === at), (w) => w.to);
  const inChain = new Set([here, ...down.map((s) => s.id)]);
  const up = walk(here, inChain, (at) => carrying((w) => w.to === at), (w) => w.from).reverse();
  const chain: Chain = {
    up,
    here: step(here, null),
    down,
    attached: [...all.filter(([, w]) => w.type === "worktree"), ...all.filter(([, w]) => w.type === "context")]
      .filter(([, w]) => w.from === here || w.to === here)
      .map(([id, w]) => {
        const other = w.from === here ? w.to : w.from;
        return { id: other, end: end(other), wire: id, type: w.type as Attached["type"], reads: w.type === "context" && w.to === here };
      }),
  };
  const steps = [...up, chain.here, ...down];
  const at = new Map(steps.map((s, i) => [s.id, i]));
  for (const [i, s] of steps.entries()) {
    const back = carrying((w) => w.from === s.id && (at.get(w.to) ?? i) < i)[0];
    if (back) s.back = { ...hop(back), to: back[1].to };
  }
  return chain;
}

/** How a step's card reads: its line under the title, and the tone it's drawn in. */
export interface StepNote {
  text: string;
  tone: "here" | "done" | "ready" | "blocked" | "dim" | "plain";
  /** Why it's blocked, or what it waits for, for its tooltip. */
  why?: string;
}

const STATUS: Record<SessionStatus, string> = { working: "working", waiting: "waiting on you", idle: "idle", dead: "exited" };

/**
 * What the strip says under a step's title: what its wires say (a loop's round first), else its agent and status. A
 * wire's state stands alone; a status, and a handoff gone, follow the agent's name. A blocked wire says what the drawn
 * wire's label does (wiresModel's shortWhy), but for "waits for approve", the strip's own words.
 */
export function stepNote(s: Step, side: "up" | "here" | "down"): StepNote {
  const e = s.end;
  if (!e) return { text: "gone", tone: "blocked", why: "No session of this Mac's has this id any more." };
  const status = e.where === "ghost" ? "closed" : e.where === "planned" ? "not started" : e.where === "closed" ? "closed · not on the landscape" : STATUS[e.status];
  const say = (text: string, tone: StepNote["tone"], why?: string): StepNote => ({ text, tone, ...(why ? { why } : {}) });
  if (side === "here") return say(`${e.agent} · ${status} · you're here`, "here");
  const b = s.back;
  if (b) {
    const r = b.rounds;
    const round = r ? ` · ↺ ${Math.min(r.used + (b.gate.state === "ready" ? 1 : 0), r.limit)} of ${r.limit}` : "";
    if (b.gate.state === "ready") return say(`${b.type === "feedback" ? "changes" : "work"} ready${round}`, "ready", b.gate.why);
    if (b.gate.state === "blocked") return say(shortWhy(b.gate, b), "blocked", b.gate.why);
  }
  const g = s.hop?.gate;
  if (g?.state === "sent" && side === "up") return say(`${e.agent} · handed on`, "done");
  if (g?.state === "ready") return say("ready to send", "ready", g.why);
  if (g?.state === "sending") return say("sending", "plain");
  if (g?.state === "blocked") return say(g.why === "needs approve" ? "waits for approve" : shortWhy(g, s.hop!), "blocked", g.why);
  const round = b?.rounds?.used ? ` · ↺ ${b.rounds.used} of ${b.rounds.limit}` : "";
  return say(`${e.agent} · ${status}${round}`, e.where === "open" ? "plain" : "dim");
}

/** The sessions the strip can name: those on the landscape, the closed ones with a ghost (or a stack's closed tab), and the closed ones with no place. */
export interface StripSessions {
  open: readonly SessionInfo[];
  ghosts: readonly SessionInfo[];
  closed: readonly SessionInfo[];
}

/** Each step's workspace, named from this window's sessions: on the landscape before a ghost before closed with no place. */
export function stepEnds(s: StripSessions): (id: string) => StepEnd | null {
  const by = new Map<string, StepEnd>();
  for (const where of ["closed", "ghosts", "open"] as const)
    for (const x of s[where]) by.set(x.id, { title: x.ticketTitle ?? x.title, agent: x.shell ? "terminal" : (x.agent ?? "claude"), status: x.status, where: where === "ghosts" ? (x.planned ? "planned" : "ghost") : where });
  return (id) => by.get(id) ?? null;
}
