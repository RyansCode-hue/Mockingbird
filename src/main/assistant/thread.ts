import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ActionDetail, AssistantCard, AssistantStep, AssistantTurn } from "../../shared/assistant";
import { isMissing, writeFileAtomic } from "../fileOps";
import { tilde } from "./rules";

/**
 * The Assistant's thread kept across quits (docs/assistant.md → The thread): its turns and the cards they put up, in
 * `~/.mockingbird/assistant-turns.json`, written whole and atomically whenever they change. What a quit cut short loads
 * as stopped (revive): a running or queued turn ends in error, a card waiting on Do it is expired and a running one
 * failed, and no Undo is offered, as what an Undo puts back is held in memory only. A file that can't be read is
 * renamed aside (`<file>.corrupt-<time>`), logged and named in the tab, and the thread starts empty.
 */

/** Where the thread is kept. */
export const threadFile = (): string => path.join(os.homedir(), ".mockingbird", "assistant-turns.json");

/** The thread as it's saved: turns oldest first, and the cards as CardBook.view lists them (open, then settled). */
export interface SavedThread {
  turns: AssistantTurn[];
  cards: AssistantCard[];
}

/** A turn or a step a quit cut short. */
export const QUIT_STOPPED = "Stopped when Mockingbird quit";
/** A card a quit left waiting on Do it. */
export const QUIT_EXPIRED = "Expired: Mockingbird quit before it was answered";
/** A card whose Do it was running at the quit. */
export const QUIT_CARD_RAN = "Mockingbird quit while it ran: check whether it finished";

const FILE_VERSION = 1;
/** The most the file holds: past it the oldest turns, then the oldest settled cards, are left out of it. */
export const THREAD_MAX_BYTES = 512 * 1024;

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const TIERS: ReadonlySet<string> = new Set(["read", "direct", "confirm"]);
const TURN_STATES: ReadonlySet<string> = new Set(["queued", "thinking", "done", "error"]);
const STEP_STATES: ReadonlySet<string> = new Set(["running", "done", "failed", "proposed", "undone"]);
const CARD_STATES: ReadonlySet<string> = new Set(["open", "running", "done", "failed", "cancelled", "expired"]);

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optional = (v: unknown, is: (x: unknown) => boolean): boolean => v === undefined || is(v);
const isText = (v: unknown): v is string => typeof v === "string";
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);
const settledCard = (c: AssistantCard): boolean => c.state !== "open" && c.state !== "running";

function parseStep(raw: unknown, at: string): AssistantStep | string {
  if (!isObject(raw) || !isId(raw.id)) return `${at} has a step with no usable id`;
  const where = `${at}'s step ${raw.id}`;
  if (!isText(raw.tool) || !isText(raw.label)) return `${where} has no tool or label`;
  if (!isText(raw.tier) || !TIERS.has(raw.tier)) return `${where} has no tier`;
  if (!isText(raw.state) || !STEP_STATES.has(raw.state)) return `${where} has no state`;
  if (!optional(raw.error, isText) || !optional(raw.undoUntil, isTime) || !optional(raw.cardId, isId)) return `${where} has a field that isn't one`;
  return {
    id: raw.id,
    tool: raw.tool,
    tier: raw.tier as AssistantStep["tier"],
    label: raw.label,
    state: raw.state as AssistantStep["state"],
    ...(raw.error !== undefined ? { error: raw.error as string } : {}),
    ...(raw.undoUntil !== undefined ? { undoUntil: raw.undoUntil as number } : {}),
    ...(raw.cardId !== undefined ? { cardId: raw.cardId as string } : {}),
  };
}

function parseTurn(raw: unknown): AssistantTurn | string {
  if (!isObject(raw) || !isId(raw.id)) return "a turn has no usable id";
  const at = `turn ${raw.id}`;
  if (!isTime(raw.at) || !isText(raw.text)) return `${at} has no time or question`;
  if (!isText(raw.state) || !TURN_STATES.has(raw.state)) return `${at} has no state`;
  if (!optional(raw.reply, isText)) return `${at}'s reply isn't text`;
  if (!Array.isArray(raw.steps)) return `${at} has no list of steps`;
  const steps: AssistantStep[] = [];
  for (const s of raw.steps) {
    const step = parseStep(s, at);
    if (typeof step === "string") return step;
    steps.push(step);
  }
  return { id: raw.id, at: raw.at, text: raw.text, state: raw.state as AssistantTurn["state"], ...(raw.reply !== undefined ? { reply: raw.reply as string } : {}), steps };
}

function parseAction(raw: unknown): ActionDetail | null {
  if (!isObject(raw) || !isText(raw.line) || !isTexts(raw.warnings) || !optional(raw.body, isText) || !optional(raw.danger, (v) => typeof v === "boolean")) return null;
  return { line: raw.line, warnings: [...raw.warnings], ...(raw.body !== undefined ? { body: raw.body as string } : {}), ...(raw.danger ? { danger: true } : {}) };
}

function parseCard(raw: unknown): AssistantCard | string {
  if (!isObject(raw) || !isId(raw.id)) return "a card has no usable id";
  const at = `card ${raw.id}`;
  if (!isId(raw.turnId) || !isText(raw.tool) || !isText(raw.title) || !isText(raw.detail) || !isTexts(raw.warnings)) return `${at} is missing what it's about`;
  if (!isText(raw.state) || !CARD_STATES.has(raw.state)) return `${at} has no state`;
  if (!isTime(raw.expiresAt)) return `${at} has no expiry`;
  if (!optional(raw.danger, (v) => typeof v === "boolean") || !optional(raw.body, isText) || !optional(raw.result, isText)) return `${at} has a field that isn't one`;
  if (raw.blocked !== undefined && raw.blocked !== null && !isText(raw.blocked)) return `${at}'s block isn't a reason`;
  let actions: ActionDetail[] | undefined;
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions)) return `${at}'s actions aren't a list`;
    actions = [];
    for (const a of raw.actions) {
      const action = parseAction(a);
      if (!action) return `${at} has an action that isn't one`;
      actions.push(action);
    }
  }
  return {
    id: raw.id,
    turnId: raw.turnId,
    tool: raw.tool,
    title: raw.title,
    detail: raw.detail,
    warnings: [...raw.warnings],
    ...(raw.danger ? { danger: true } : {}),
    ...(raw.body !== undefined ? { body: raw.body as string } : {}),
    ...(actions ? { actions } : {}),
    blocked: (raw.blocked as string | null | undefined) ?? null,
    state: raw.state as AssistantCard["state"],
    ...(raw.result !== undefined ? { result: raw.result as string } : {}),
    expiresAt: raw.expiresAt,
  };
}

/** `data` as the thread the file holds, or why it isn't one: any part that isn't what was saved makes the whole unread. */
export function parseThread(data: unknown): SavedThread | string {
  if (!isObject(data) || !Array.isArray(data.turns) || !Array.isArray(data.cards)) return "it doesn't hold a thread's turns and cards";
  const turns: AssistantTurn[] = [];
  for (const raw of data.turns) {
    const t = parseTurn(raw);
    if (typeof t === "string") return t;
    if (turns.some((x) => x.id === t.id)) return `turn ${t.id} is in it twice`;
    turns.push(t);
  }
  const cards: AssistantCard[] = [];
  for (const raw of data.cards) {
    const c = parseCard(raw);
    if (typeof c === "string") return c;
    if (cards.some((x) => x.id === c.id)) return `card ${c.id} is in it twice`;
    cards.push(c);
  }
  return { turns, cards };
}

/**
 * A saved thread as it loads after a quit: whatever was underway is stopped. A running or queued turn ends in error,
 * its running steps failed; a card waiting on Do it is expired, one running failed (its step with it, as settling it
 * does); a step left proposed whose card wasn't kept gets an expired card in its place; and no step keeps an Undo.
 */
export function revive(saved: SavedThread): SavedThread {
  const turns = structuredClone(saved.turns);
  const cards = structuredClone(saved.cards);
  const stepOf = (cardId: string): AssistantStep | undefined => turns.flatMap((t) => t.steps).find((s) => s.cardId === cardId);
  for (const c of cards) {
    if (c.state === "open") {
      c.state = "expired";
      c.result = QUIT_EXPIRED;
    } else if (c.state === "running") {
      c.state = "failed";
      c.result = QUIT_CARD_RAN;
      const step = stepOf(c.id);
      if (step) {
        step.state = "failed";
        step.error = QUIT_CARD_RAN;
      }
    }
    c.blocked = null;
  }
  for (const t of turns) {
    if (t.state === "queued" || t.state === "thinking") {
      t.state = "error";
      t.reply = QUIT_STOPPED;
    }
    for (const s of t.steps) {
      delete s.undoUntil;
      if (s.state === "running") {
        s.state = "failed";
        s.error = QUIT_STOPPED;
      }
      if (s.state === "proposed" && s.cardId && !cards.some((c) => c.id === s.cardId)) {
        cards.push({ id: s.cardId, turnId: t.id, tool: s.tool, title: s.label, detail: "", warnings: [], blocked: null, state: "expired", result: QUIT_EXPIRED, expiresAt: t.at });
      }
    }
  }
  return { turns, cards };
}

/**
 * The thread as the file is written: whole, within `max` bytes. Past it the oldest turns are left out, then the oldest
 * settled cards (then any); `left` counts what was.
 */
export function threadText(t: SavedThread, max = THREAD_MAX_BYTES): { text: string; left: { turns: number; cards: number } } {
  let turns = t.turns;
  let cards = t.cards;
  const text = () => `${JSON.stringify({ version: FILE_VERSION, turns, cards })}\n`;
  let out = text();
  while (Buffer.byteLength(out) > max && turns.length) {
    turns = turns.slice(1);
    out = text();
  }
  while (Buffer.byteLength(out) > max && cards.length) {
    const i = Math.max(0, cards.findIndex(settledCard));
    cards = cards.filter((_, j) => j !== i);
    out = text();
  }
  return { text: out, left: { turns: t.turns.length - turns.length, cards: t.cards.length - cards.length } };
}

/**
 * The thread's file: read once at start-up (load), written whenever the thread changes (save). A save never throws:
 * a failure is logged once and named in the tab (problem) until a save works. A file that can't be read is moved aside
 * and named in the tab until Clear (dismiss); one that can't even be moved aside is never saved over.
 */
export class ThreadFile {
  /** What the file holds as last written: an unchanged thread isn't written again. */
  private written = "";
  private trouble: string | null = null;
  private stuck = false;
  private saveTrouble: string | null = null;
  private lastLeft = "";

  constructor(private readonly o: { file: string; log: (context: string, err: unknown) => void; now?: () => number; maxBytes?: number }) {}

  /** Why the file couldn't be read (and where it went), or that the thread couldn't be saved; null when neither. */
  problem(): string | null {
    return [this.trouble, this.saveTrouble].filter(Boolean).join(" ") || null;
  }

  /** A fresh thread: why the earlier one couldn't be read is said no more (unless nothing can be saved over it). */
  dismiss(): void {
    if (!this.stuck) this.trouble = null;
  }

  /** The thread the file holds, revived; empty when there's no file, or it couldn't be read (moved aside). */
  load(): SavedThread {
    const empty: SavedThread = { turns: [], cards: [] };
    let text: string;
    try {
      text = fs.readFileSync(this.o.file, "utf8");
    } catch (err) {
      if (isMissing(err)) return empty;
      this.setAside(`it couldn't be read (${message(err)})`);
      return empty;
    }
    if (!text.trim()) return empty;
    const max = this.o.maxBytes ?? THREAD_MAX_BYTES;
    if (Buffer.byteLength(text) > max * 2) {
      this.setAside(`it's larger than a thread is saved at (${Math.round(Buffer.byteLength(text) / 1024)} KB)`);
      return empty;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      this.setAside(`it isn't valid JSON (${message(err)})`);
      return empty;
    }
    if (isObject(data) && typeof data.version === "number" && data.version > FILE_VERSION) {
      this.setAside(`a newer Mockingbird wrote it (version ${data.version})`);
      return empty;
    }
    const saved = parseThread(data);
    if (typeof saved === "string") {
      this.setAside(saved);
      return empty;
    }
    this.written = text;
    return revive(saved);
  }

  save(t: SavedThread): void {
    if (this.stuck) return;
    const { text, left } = threadText(t, this.o.maxBytes ?? THREAD_MAX_BYTES);
    if (text === this.written) return;
    const leftNow = left.turns || left.cards ? `${left.turns} turns and ${left.cards} cards` : "";
    if (leftNow && leftNow !== this.lastLeft) this.o.log("assistant thread", new Error(`the thread is over ${Math.round((this.o.maxBytes ?? THREAD_MAX_BYTES) / 1024)} KB: its oldest ${leftNow} aren't saved`));
    this.lastLeft = leftNow;
    try {
      writeFileAtomic(this.o.file, text, 0o600);
    } catch (err) {
      const why = `The thread couldn't be saved to ${tilde(this.o.file)} (${message(err)}): what's new in it holds only until Mockingbird quits.`;
      if (why !== this.saveTrouble) this.o.log(`assistant thread: saving ${this.o.file}`, err);
      this.saveTrouble = why;
      return;
    }
    this.written = text;
    this.saveTrouble = null;
  }

  /** The file as it is, renamed aside, so a fresh thread is saved in its place. */
  private setAside(why: string): void {
    const aside = `${this.o.file}.corrupt-${(this.o.now ?? Date.now)()}`;
    try {
      fs.renameSync(this.o.file, aside);
    } catch (err) {
      this.stuck = true;
      this.trouble = `Your earlier thread (${tilde(this.o.file)}) couldn't be read: ${why}. It couldn't be moved aside either (${message(err)}), so nothing is saved over it: this thread holds only until Mockingbird quits.`;
      this.o.log("assistant thread", new Error(this.trouble));
      return;
    }
    this.trouble = `Your earlier thread couldn't be read: ${why}. It's kept as ${tilde(aside)}.`;
    this.o.log("assistant thread", new Error(this.trouble));
  }
}
