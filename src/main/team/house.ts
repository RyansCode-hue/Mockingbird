import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isMissing } from "../fileOps";
import {
  HOUSE_CONFIG_DIR,
  HOUSE_PROJECT_RE,
  HOUSE_TOKEN_HOW,
  isTicketNumber,
  type HouseClaim,
  type HouseHistoryEntry,
  type HouseTicket,
  type HouseTicketDetail,
} from "../../shared/team/house";

/**
 * The Radley House's external API, for one builder: their env file, and the
 * requests their Mockingbird makes with their token. Main process only — the
 * token never leaves it: not to the window, an agent, the room log, a log
 * line or an error (every message is scrubbed of it).
 *
 * Requests go to `$HOUSE_API_URL/api/projects/$HOUSE_PROJECT_ID/external/…`
 * with the token in X-Build-Token, never follow a redirect (a redirect would
 * carry the header to wherever it points), and time out.
 *
 * What the House answers is read defensively (ticketOf, detailOf): the
 * fields its external API answers with (number, status, priority, tags,
 * assignee + branch, blocked_by, waiting_on, history entries of
 * { at, actor, event, note?, to_status? }) first, then other likely names,
 * and anything missing reads as empty rather than failing the board — driftOf
 * says on the board when a list answer lacks a field Mockingbird reads.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE = 5 * 1024 * 1024;

export interface HouseEnv {
  /** https origin (and path prefix, if any), no trailing slash. */
  apiUrl: string;
  projectId: string;
  token: string;
  file: string;
}

/** The env file is missing or doesn't hold what's needed: the board says so, with what to do. */
export class HouseSetupError extends Error {
  constructor(
    readonly state: "missing" | "bad",
    readonly file: string,
    message: string
  ) {
    super(message);
  }
}

/** A House request that failed, with the House's own message (never the token). */
export class HouseError extends Error {}

/** The env file for `project` under `home`. */
export function houseEnvPath(project: string, home = os.homedir()): string {
  if (!HOUSE_PROJECT_RE.test(project)) throw new Error(`${JSON.stringify(project)} isn't a House project name (letters, digits, ".", "_" and "-")`);
  return path.join(home, HOUSE_CONFIG_DIR, `${project}.env`);
}

/** KEY=value lines (`export ` allowed, quotes taken off, `#` comments); nothing is expanded. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A builder's coordinates and token for `project`, from their env file
 * (HOUSE_API_URL, HOUSE_PROJECT_ID, HOUSE_BUILD_TOKEN — or EXTERNAL_BUILD_TOKEN,
 * as the House's own CLI names it). Throws HouseSetupError naming what's
 * wrong and what to do; its message never holds the token.
 * `allowHttpLoopback` lets tests point at a fake House on this Mac.
 */
export function readHouseEnv(project: string, o: { home?: string; allowHttpLoopback?: boolean } = {}): HouseEnv {
  const file = houseEnvPath(project, o.home);
  const shown = file.startsWith(os.homedir() + path.sep) ? `~/${path.relative(os.homedir(), file)}` : file;
  let text: string;
  let mode: number;
  try {
    mode = fs.statSync(file).mode;
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isMissing(err)) throw new HouseSetupError("missing", shown, `There's no ${shown} on this Mac. ${HOUSE_TOKEN_HOW} Save it there (mode 600) as HOUSE_API_URL, HOUSE_PROJECT_ID and HOUSE_BUILD_TOKEN.`);
    throw new HouseSetupError("bad", shown, `${shown} couldn't be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  const bad = (why: string) => new HouseSetupError("bad", shown, `${shown} ${why}`);
  if (mode & 0o077) throw bad(`can be read by other users on this Mac; Mockingbird won't use a token kept like that. Run: chmod 600 ${shown}`);
  const env = parseEnvText(text);
  const given = (k: string) => (env[k] && env[k] !== "REPLACE_ME" ? env[k] : "");
  const url = given("HOUSE_API_URL");
  const projectId = given("HOUSE_PROJECT_ID");
  const token = given("HOUSE_BUILD_TOKEN") || given("EXTERNAL_BUILD_TOKEN");
  const missing = [!url && "HOUSE_API_URL", !projectId && "HOUSE_PROJECT_ID", !token && "HOUSE_BUILD_TOKEN"].filter(Boolean);
  if (missing.length) throw bad(`doesn't set ${missing.join(", ")}. ${missing.includes("HOUSE_BUILD_TOKEN") ? HOUSE_TOKEN_HOW : ""}`.trim());
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw bad("has a HOUSE_API_URL that isn't a URL");
  }
  const loopbackHttp = o.allowHttpLoopback && u.protocol === "http:" && LOOPBACK.has(u.hostname);
  if (u.protocol !== "https:" && !loopbackHttp) throw bad(`has a HOUSE_API_URL that isn't https (${u.protocol}//${u.host}); Mockingbird sends the token only over https`);
  if (u.username || u.password || u.search || u.hash) throw bad("has a HOUSE_API_URL with a user, query or fragment in it; give just the House's address");
  if (!/^[A-Za-z0-9-]{1,100}$/.test(projectId)) throw bad("has a HOUSE_PROJECT_ID that isn't a project id (letters, digits and dashes)");
  if (/[\s\0-\x1f]/.test(token) || token.length > 4096) throw bad("has a HOUSE_BUILD_TOKEN with spaces or control characters in it");
  return { apiUrl: `${u.origin}${u.pathname.replace(/\/+$/, "")}`, projectId, token, file: shown };
}

/** `text` with every copy of the token taken out (as is, and URL-encoded). */
export function scrub(text: string, token: string | null | undefined): string {
  if (!token) return text;
  let out = text.split(token).join("[build token]");
  const enc = encodeURIComponent(token);
  if (enc !== token) out = out.split(enc).join("[build token]");
  return out;
}

type Fetch = typeof fetch;

export interface HouseClientOptions {
  timeoutMs?: number;
  fetch?: Fetch;
}

/** One builder's requests to the House's external API for one project. */
export class HouseClient {
  private readonly timeoutMs: number;
  private readonly doFetch: Fetch;

  constructor(
    readonly env: HouseEnv,
    o: HouseClientOptions = {}
  ) {
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = o.fetch ?? fetch;
  }

  /** The project's external API, under which every path goes. */
  get base(): string {
    return `${this.env.apiUrl}/api/projects/${encodeURIComponent(this.env.projectId)}/external`;
  }

  /** The backlog in the House's order, high priority first, closed tickets included (optionally one tag's). */
  async list(tag?: string): Promise<HouseTicket[]> {
    return (await this.listChecked(tag)).tickets;
  }

  /** The backlog, and what of the fields Mockingbird reads its answer no longer has (driftOf). */
  async listChecked(tag?: string): Promise<{ tickets: HouseTicket[]; drift: string | null }> {
    const raw = listOf(await this.call("GET", `work-items${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`));
    return {
      tickets: raw.map(ticketOf).filter((t): t is HouseTicket => !!t),
      drift: driftOf(raw),
    };
  }

  /** One ticket, with its history. */
  async ticket(n: number): Promise<HouseTicketDetail> {
    const t = detailOf(await this.call("GET", `work-items/${num(n)}`));
    if (!t) throw new HouseError(`The House's answer for #${n} isn't a ticket`);
    return t;
  }

  /** A new ticket; the House assigns its number. */
  async create(body: { title: string; detail?: string; acceptance?: string; kind?: string; priority?: string }): Promise<HouseTicketDetail> {
    const t = detailOf(await this.call("POST", "work-items", { kind: "engineering", priority: "medium", ...body }));
    if (!t) throw new HouseError("The House created the ticket but its answer doesn't say which number it got");
    return t;
  }

  async claim(n: number, branch: string | null): Promise<HouseTicketDetail | null> {
    return detailOf(await this.call("POST", `work-items/${num(n)}/claim`, branch ? { branch } : {}));
  }

  async release(n: number): Promise<HouseTicketDetail | null> {
    return detailOf(await this.call("POST", `work-items/${num(n)}/release`));
  }

  /** A history event: `{ event: "progress" | "question", note, status?, reference? }`. */
  async event(n: number, body: { event: string; note: string; status?: string; reference?: string }): Promise<HouseTicketDetail | null> {
    return detailOf(await this.call("POST", `work-items/${num(n)}/events`, body));
  }

  /** Change fields (omitted ones stay); `{ note }` alone is a comment. */
  async patch(n: number, body: Record<string, unknown>): Promise<HouseTicketDetail | null> {
    return detailOf(await this.call("PATCH", `work-items/${num(n)}`, body));
  }

  /** The current frozen spec — the project's requirements document, not a ticket list — as the House gives it. */
  spec(): Promise<unknown> {
    return this.call("GET", "spec");
  }

  /** A request; resolves with the parsed JSON (null for an empty answer). */
  async call(method: "GET" | "POST" | "PATCH", rel: string, body?: unknown): Promise<unknown> {
    const url = `${this.base}/${rel}`;
    const where = new URL(url).host;
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method,
        headers: { "X-Build-Token": this.env.token, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new HouseError(`The House (${where}) didn't answer within ${this.timeoutMs / 1000} s`);
      const cause = e.cause?.code ?? e.cause?.message ?? e.message;
      throw new HouseError(this.clean(`Couldn't reach the House at ${where}: ${cause}`));
    }
    const text = await this.body(res);
    let parsed: unknown = null;
    let json = true;
    try {
      parsed = text.trim() ? JSON.parse(text) : null;
    } catch {
      json = false;
    }
    if (!res.ok) {
      const said = flat(messageOf(parsed) ?? (json ? null : text.trim().slice(0, 300)) ?? res.statusText);
      // 403 is also the House refusing an action (closing a ticket, someone else's claim): the token hint only when it's about the token
      const aboutToken = res.status === 401 || (res.status === 403 && (!said || /token/i.test(said)));
      const hint = aboutToken ? ` — your build token is stale or isn't for this project. ${HOUSE_TOKEN_HOW}` : "";
      throw new HouseError(this.clean(`The House answered ${res.status}${said ? `: ${said}` : ""}${hint}`));
    }
    if (!json) throw new HouseError(this.clean(`The House's answer to ${method} ${rel.split("?")[0]} isn't JSON: ${flat(text.trim().slice(0, 200))}`));
    return parsed;
  }

  /**
   * The answer's text, read as it arrives and refused once it passes
   * MAX_RESPONSE bytes: a chunked answer has no length to check up front.
   */
  private async body(res: Response): Promise<string> {
    const length = Number(res.headers.get("content-length") ?? 0);
    const tooLong = () => new HouseError(`The House's answer is longer than ${MAX_RESPONSE} bytes; Mockingbird reads at most that much`);
    if (length > MAX_RESPONSE) throw tooLong();
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (err) {
        throw new HouseError(this.clean(`The House's answer couldn't be read: ${(err as Error).message}`));
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE) {
        // the answer is refused either way; a stream that won't stop cleanly changes nothing
        reader.cancel().catch(() => undefined);
        throw tooLong();
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private clean(s: string): string {
    return scrub(s, this.env.token);
  }
}

/**
 * The House's own words in an error, on one line with no angle brackets: an
 * error reaches agents as a tool's answer, where it must read as data.
 */
const flat = (s: string): string => s.replace(/\s+/g, " ").replace(/</g, "‹").replace(/>/g, "›").trim();

function num(n: number): number {
  if (!isTicketNumber(n)) throw new HouseError(`${JSON.stringify(n)} isn't a ticket number`);
  return n;
}

// ---- reading what the House answers --------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const first = (o: Record<string, unknown> | null | undefined, keys: string[]): unknown => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
};
const intOf = (v: unknown): number | null => {
  const n = typeof v === "string" && /^#?\d+$/.test(v.trim()) ? Number(v.trim().replace(/^#/, "")) : v;
  return isTicketNumber(n) ? (n as number) : null;
};

/** The House's error text: `error`, `message` or `detail` (a string, or FastAPI-style [{ msg }]). */
function messageOf(v: unknown): string | null {
  if (!isObj(v)) return null;
  for (const k of ["error", "message", "detail"]) {
    const x = v[k];
    if (typeof x === "string" && x.trim()) return x.trim().slice(0, 500);
    if (isObj(x)) {
      const inner = messageOf(x);
      if (inner) return inner;
    }
    if (Array.isArray(x)) {
      const parts = x.map((e) => (isObj(e) ? str(e.msg ?? e.message) : str(e))).filter(Boolean);
      if (parts.length) return parts.join("; ").slice(0, 500);
    }
  }
  return null;
}

/** A person as the House names one: a string, or { name | display_name | email }. */
function personOf(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (isObj(v)) return str(first(v, ["name", "display_name", "full_name", "label", "email", "username"])).trim() || null;
  return null;
}

/** A list answer: an array, or one under items / work_items / results / data. */
function listOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isObj(raw)) for (const k of ["items", "work_items", "workItems", "results", "data", "tickets"]) if (Array.isArray(raw[k])) return raw[k] as unknown[];
  return [];
}

/** A single-item answer may come wrapped (`{ work_item: {…} }`). */
function unwrap(raw: unknown): Record<string, unknown> | null {
  if (!isObj(raw)) return null;
  for (const k of ["work_item", "workItem", "item", "ticket", "data"]) if (isObj(raw[k]) && intOf((raw[k] as Record<string, unknown>).number) !== null) return raw[k] as Record<string, unknown>;
  return raw;
}

const CLAIMANT_KEYS = ["assignee", "claimed_by", "claimant", "claimed_by_name"];

/**
 * Who has the ticket: the House's assignee and branch, or a `claim` object,
 * or other claimant fields. A claimant field that's present but empty means
 * unclaimed, whatever branch the ticket still names.
 */
function claimOf(o: Record<string, unknown>): HouseClaim | null {
  const c = isObj(o.claim) ? o.claim : isObj(o.claimed) ? o.claimed : null;
  const by = personOf(first(c, ["by", "builder", "claimed_by", "claimant", "name"]) ?? first(o, CLAIMANT_KEYS));
  const branch = str(first(c, ["branch", "branch_name"]) ?? first(o, ["claim_branch", "claimed_branch", "branch"])).trim() || null;
  const at = str(first(c, ["at", "claimed_at", "since"]) ?? first(o, ["claimed_at"])).trim() || null;
  if (c === null && !by && CLAIMANT_KEYS.some((k) => k in o)) return null;
  if (c === null && !by && !branch && !at && o.claimed !== true) return null;
  return { by, branch, at };
}

/**
 * What a list answer lacks of the fields Mockingbird reads, said for the
 * board; null when every work item has them. Missing fields read as empty
 * (a ticket with no claimant field as unclaimed), so a House that renamed
 * one would otherwise look like a board where nobody has claimed anything.
 */
export function driftOf(items: unknown[]): string | null {
  const objs = items.filter(isObj).map((o) => unwrap(o) ?? o);
  const lacking = (has: (o: Record<string, unknown>) => boolean) => objs.filter((o) => !has(o)).length;
  const problems: string[] = [];
  const unnumbered = items.length - objs.filter((o) => intOf(o.number ?? o.n ?? o.ticket_number) !== null).length;
  if (unnumbered) problems.push(`${unnumbered} of its ${items.length} work items have no ticket number, so they're left off the board`);
  const fields: [string, (o: Record<string, unknown>) => boolean][] = [
    ["status", (o) => "status" in o],
    ["title", (o) => "title" in o],
    ["assignee (or another claim field)", (o) => isObj(o.claim) || "claimed" in o || CLAIMANT_KEYS.some((k) => k in o)],
  ];
  const missing = fields.filter(([, has]) => objs.length > 0 && lacking(has) === objs.length).map(([name]) => name);
  if (missing.length) problems.push(`its work items no longer have ${missing.join(", ")}, so ${missing.some((m) => m.startsWith("assignee")) ? "every ticket shows as unclaimed and claims aren't enforced" : "those read as unknown"}`);
  return problems.length ? `The House's answer doesn't have the fields Mockingbird reads: ${problems.join("; ")}. Its API may have changed — tell whoever looks after Mockingbird.` : null;
}

/** Ticket numbers it waits on: numbers, "#123", or objects with a number. */
function numbersOf(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out = v.map((x) => (isObj(x) ? intOf(first(x, ["number", "n"])) : intOf(x))).filter((x): x is number => x !== null);
  return [...new Set(out)];
}

/** What waiting_on names: a string, or an object naming whom or what. Null, {} or an object of empty values: not waiting. */
function waitingOf(v: unknown): HouseTicket["waiting"] {
  if (typeof v === "string") return v.trim() ? { on: v.trim() } : null;
  if (!isObj(v)) return null;
  const named = personOf(first(v, ["label", "name", "who", "party", "on", "kind", "type", "reason", "note", "detail", "summary"]));
  if (named) return { on: named };
  return Object.values(v).some((x) => x !== null && x !== undefined && x !== "" && x !== false) ? { on: null } : null;
}

/** A ticket from a list or a single answer; null when it has no number. */
export function ticketOf(raw: unknown): HouseTicket | null {
  const o = unwrap(raw);
  const n = o ? intOf(o.number ?? o.n ?? o.ticket_number) : null;
  if (!o || n === null) return null;
  return {
    n,
    title: str(o.title).trim() || `#${n}`,
    status: str(o.status).trim() || "unknown",
    priority: str(o.priority).trim() || null,
    kind: str(o.kind).trim() || null,
    tags: Array.isArray(o.tags) ? o.tags.map((t) => (isObj(t) ? str(t.name ?? t.label) : str(t))).filter(Boolean) : [],
    claim: claimOf(o),
    blockedBy: numbersOf(o.blocked_by ?? o.blockedBy),
    waiting: waitingOf(o.waiting_on ?? o.waitingOn),
  };
}

function historyOf(raw: unknown): HouseHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).map((e) => {
    const status = str(first(e, ["to_status", "status", "new_status"])).trim() || null;
    return {
      kind: str(first(e, ["event", "kind", "type", "action"])).trim() || (status ? "status" : "note"),
      text: str(first(e, ["note", "text", "body", "message", "comment", "summary", "detail"])),
      by: personOf(first(e, ["actor", "by", "author", "builder", "user", "who"])),
      at: str(first(e, ["at", "created_at", "timestamp", "time", "date"])).trim() || null,
      status,
      reference: str(e.reference).trim() || null,
    };
  });
}

/** A ticket with its detail and history; null when the answer isn't one. */
export function detailOf(raw: unknown): HouseTicketDetail | null {
  const t = ticketOf(raw);
  const o = unwrap(raw);
  if (!t || !o) return null;
  return {
    ...t,
    url: str(first(o, ["web_url", "html_url", "url", "link"])).trim() || null,
    detail: str(first(o, ["detail", "description", "body"])),
    acceptance: str(o.acceptance),
    history: historyOf(o.history ?? o.events),
    branch: t.claim?.branch ?? (str(first(o, ["branch", "branch_name", "claim_branch"])).trim() || null),
    links: linksOf(o.links ?? o.references),
  };
}

/** A ticket's links: URLs, or objects with a url and a label (title, name). */
function linksOf(v: unknown): HouseTicketDetail["links"] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (isObj(x) ? { label: str(first(x, ["label", "title", "name", "kind"])).trim() || null, url: str(first(x, ["url", "href", "link"])).trim() } : { label: null, url: str(x).trim() }))
    .filter((l) => !!l.url);
}
