import { AGENT_KINDS, AGENT_NAME, type AgentKind, type CollabMessage, type CollabModel, type CollabParticipant, type CollabParticipantSpec, type CollabRoom } from "../shared/types";

/** The models a room can seat (read from the CLIs), the seats a new room starts with, and each CLI's effort levels. */
export type Catalog = { presets: CollabModel[]; defaults?: CollabModel[]; efforts: Record<AgentKind, string[]> };

/** The catalog as dropdown choices, grouped by CLI, plus "Other model id…". */
export function presetOptions(catalog: Catalog, custom: string): { value: string; label: string; group?: string }[] {
  return [
    ...catalog.presets.map((m) => ({ value: m.key, label: m.label, group: AGENT_NAME[m.agent] })),
    { value: custom, label: "Other model id…", group: "Other" },
  ];
}
/** The value the model picker uses for "Other model…". */
export const CUSTOM_MODEL = "__custom";

/** The CLIs a typed-in model id can run on. */
export const AGENT_OPTIONS: { value: AgentKind; label: string }[] = AGENT_KINDS.map((a) => ({ value: a, label: AGENT_NAME[a] }));

/** An example model id for the CLI, as a typed-in model's placeholder. */
export const modelPlaceholder = (agent: AgentKind) => (agent === "codex" ? "gpt-6-astra-mini" : "claude-sonnet-5");

/** A CLI's effort levels as dropdown choices, after its default (""). */
export function effortOptions(catalog: Catalog, agent: AgentKind, defaultLabel: string): { value: string; label: string }[] {
  return [{ value: "", label: defaultLabel }, ...catalog.efforts[agent].map((e) => ({ value: e, label: e }))];
}

/** An "always allow" kind as the user reads it: "Bash: npm test" → "npm test", "Read: src" → "Read in src". */
export const kindLabel = (kind: string) => kind.replace(/^Bash: /, "").replace(/^(\w+): /, "$1 in ");

/** The seats a new room starts with: the catalog's defaults, else every preset; none until the catalog has loaded. */
export function seedSeats(catalog: Catalog): CollabParticipantSpec[] {
  return (catalog.defaults ?? catalog.presets).map((m) => ({ label: m.label, agent: m.agent, model: m.model, effort: null, readsCode: true }));
}

/** The first catalog model (new-room defaults first) that isn't seated yet; null when all are, or the catalog is empty. */
export function unusedModel(catalog: Catalog, seated: { agent: AgentKind; model: string }[]): CollabModel | null {
  return [...(catalog.defaults ?? []), ...catalog.presets].find((m) => !seated.some((s) => s.agent === m.agent && s.model === m.model)) ?? null;
}
const isModel = (m: CollabMessage) => m.speaker !== "you" && m.speaker !== "system";

/** Messages long enough to fold in the thread (the newest one never folds). */
export function isLong(text: string): boolean {
  return text.length > 900 || text.split("\n").length > 14;
}

/** The first meaningful line of a message, without markdown markers — a rounds-grid cell's summary. */
export function summaryOf(text: string, max = 160): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/^\s*(#+|[-*>]|\d+[.)])\s*/, "").replace(/\*+|`|(^|\s)_+|_+(?=\s|$)/g, "$1").trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export type ThreadItem = { type: "divider"; round: number } | { type: "message"; message: CollabMessage };

/** The transcript with a "Round N" divider before the first model message of each round. */
export function threadItems(messages: CollabMessage[]): ThreadItem[] {
  const out: ThreadItem[] = [];
  let shown = 0;
  for (const m of messages) {
    if (isModel(m) && m.round > 0 && m.round !== shown) {
      out.push({ type: "divider", round: m.round });
      shown = m.round;
    }
    out.push({ type: "message", message: m });
  }
  return out;
}

/** How many of the room's models agreed in the latest round anyone took a stance in. */
export function agreement(room: CollabRoom): { round: number; agree: number; of: number } | null {
  const seated = room.participants.filter((p) => !p.removed);
  const stances = room.messages.filter((m) => isModel(m) && m.stance);
  if (!stances.length || !seated.length) return null;
  const round = Math.max(...stances.map((m) => m.round));
  const agree = seated.filter((p) => stances.some((m) => m.round === round && m.speaker === p.key && m.stance === "agree")).length;
  return { round, agree, of: seated.length };
}

export interface RoundRow {
  round: number;
  /** The user's messages sent before this round started. */
  before: CollabMessage[];
  /** Each model's messages in this round (its turn, lookups it answered, a plan, an error). */
  cells: Record<string, CollabMessage[]>;
}

/**
 * The discussion as a grid: a column per model (seated ones, then any that left
 * but spoke), a row per round. A user message carries the number of rounds done
 * when it was sent, so it sits before the next round.
 */
export function roundsGrid(room: CollabRoom): { columns: CollabParticipant[]; rows: RoundRow[]; after: CollabMessage[] } {
  const spoke = new Set(room.messages.filter(isModel).map((m) => m.speaker));
  const columns = [...room.participants.filter((p) => !p.removed), ...room.participants.filter((p) => p.removed && spoke.has(p.key))];
  const modelRounds = room.messages.filter(isModel).map((m) => m.round);
  const last = Math.max(room.round + (room.running ? 1 : 0), ...modelRounds, 0);
  const rows: RoundRow[] = Array.from({ length: last }, (_, i) => ({ round: i + 1, before: [], cells: {} }));
  const after: CollabMessage[] = [];
  for (const m of room.messages) {
    if (m.speaker === "system") continue;
    if (m.speaker === "you") {
      const row = rows[m.round]; // sent after m.round rounds → before round m.round + 1
      (row ? row.before : after).push(m);
      continue;
    }
    const row = rows[Math.max(m.round, 1) - 1];
    if (row) (row.cells[m.speaker] ??= []).push(m);
  }
  return { columns, rows, after };
}

/** "0:42" — how long a permission request has waited. */
export function waited(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Two letters for a room in the collapsed rail. */
export function initials(title: string): string {
  const words = title.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !/^(a|an|the|to|of|and|for|how|on|in)$/i.test(w));
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

/** What a model may do with the room's repository — each level includes the ones before it. */
export type Access = "none" | "read" | "run" | "docker";
export const ACCESS_LEVELS: { id: Access; label: string; note: string }[] = [
  { id: "none", label: "none", note: "No code — asks a model that reads it" },
  { id: "read", label: "read", note: "Reads the repository" },
  { id: "run", label: "run", note: "Reads, and runs tests and builds in a disposable test copy" },
  { id: "docker", label: "docker", note: "Runs commands and uses Docker, which reaches past the sandbox" },
];

const RANK: Record<Access, number> = { none: 0, read: 1, run: 2, docker: 3 };
const BY_RANK: Access[] = ["none", "read", "run", "docker"];

/** Is this permission on? Each level includes the ones before it. */
export const hasAccess = (current: Access, level: Access) => RANK[current] >= RANK[level];

/**
 * Click one permission on or off, keeping the rules: Docker needs run, run
 * needs read. On turns on what it needs; off turns off what needs it.
 */
export function toggleAccess(current: Access, level: Exclude<Access, "none">): Access {
  return hasAccess(current, level) ? BY_RANK[RANK[level] - 1] : level;
}

export function accessOf(p: { readsCode: boolean; runsCommands?: boolean; usesDocker?: boolean }): Access {
  return p.usesDocker ? "docker" : p.runsCommands ? "run" : p.readsCode ? "read" : "none";
}

export function accessFlags(a: Access): { readsCode: boolean; runsCommands: boolean; usesDocker: boolean } {
  return { readsCode: a !== "none", runsCommands: a === "run" || a === "docker", usesDocker: a === "docker" };
}

/** The room's seated models as the specs setParticipants takes (keys kept, so conversations carry on). */
export function specsOf(participants: CollabParticipant[]): CollabParticipantSpec[] {
  return participants
    .filter((p) => !p.removed)
    .map((p) => ({ key: p.key, label: p.label, agent: p.agent, model: p.model, effort: p.effort, ...accessFlags(accessOf(p)) }));
}

/** The list with the item at `from` moved to index `to` (unchanged when either is out of range). */
export function moveAt<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Move one seat to another's place in the speaking order. */
export function moveSeat<T extends { key?: string }>(specs: T[], fromKey: string, toKey: string): T[] {
  return moveAt(
    specs,
    specs.findIndex((s) => s.key === fromKey),
    specs.findIndex((s) => s.key === toKey)
  );
}
