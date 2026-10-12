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
  type HouseSlice,
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
 * What the House answers is read defensively (ticketOf, detailOf, sliceOf):
 * fields it may name differently are looked for under each likely name, and
 * anything missing reads as empty rather than failing the board.
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
export class HouseError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

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

  /** The backlog, high priority first (optionally one tag's). */
  async list(tag?: string): Promise<HouseTicket[]> {
    const raw = await this.call("GET", `work-items${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
    return listOf(raw)
      .map(ticketOf)
      .filter((t): t is HouseTicket => !!t);
  }

  /** One ticket, with its history. */
  async ticket(n: number): Promise<HouseTicketDetail> {
    const t = detailOf(await this.call("GET", `work-items/${num(n)}`));
    if (!t) throw new HouseError(`The House's answer for #${n} isn't a ticket`, null);
    return t;
  }

  /** A new ticket; the House assigns its number. */
  async create(body: { title: string; detail?: string; acceptance?: string; kind?: string; priority?: string }): Promise<HouseTicketDetail> {
    const t = detailOf(await this.call("POST", "work-items", { kind: "engineering", priority: "medium", ...body }));
    if (!t) throw new HouseError("The House created the ticket but its answer doesn't say which number it got", null);
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

  /** The current frozen spec, as the House gives it. */
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
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new HouseError(`The House (${where}) didn't answer within ${Math.round(this.timeoutMs / 1000)} s`, null);
      const cause = e.cause?.code ?? e.cause?.message ?? e.message;
      throw new HouseError(this.clean(`Couldn't reach the House at ${where}: ${cause}`), null);
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_RESPONSE) throw new HouseError(`The House's answer is ${length} bytes; Mockingbird reads at most ${MAX_RESPONSE}`, res.status);
    const text = await res.text().catch((err: Error) => {
      throw new HouseError(this.clean(`The House's answer couldn't be read: ${err.message}`), res.status);
    });
    if (text.length > MAX_RESPONSE) throw new HouseError(`The House's answer is longer than ${MAX_RESPONSE} characters`, res.status);
    let parsed: unknown = null;
    let json = true;
    try {
      parsed = text.trim() ? JSON.parse(text) : null;
    } catch {
      json = false;
    }
    if (!res.ok) {
      const said = messageOf(parsed) ?? (json ? null : text.trim().slice(0, 300)) ?? res.statusText;
      const hint = res.status === 401 || res.status === 403 ? ` — your build token is stale or isn't for this project. ${HOUSE_TOKEN_HOW}` : "";
      throw new HouseError(this.clean(`The House answered ${res.status}${said ? `: ${said}` : ""}${hint}`), res.status);
    }
    if (!json) throw new HouseError(this.clean(`The House's answer to ${method} ${rel.split("?")[0]} isn't JSON: ${text.trim().slice(0, 200)}`), res.status);
    return parsed;
  }

  private clean(s: string): string {
    return scrub(s, this.env.token);
  }
}

function num(n: number): number {
  if (!isTicketNumber(n)) throw new HouseError(`${JSON.stringify(n)} isn't a ticket number`, null);
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

const CLAIMANT_KEYS = ["claimed_by", "claimant", "claimed_by_name", "assignee"];

/**
 * Who has the ticket: a `claim` object, or claimant / branch fields on the
 * ticket itself. A claimant field that's present but empty means unclaimed,
 * whatever branch the ticket still names.
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
  };
}

function historyOf(raw: unknown): HouseHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObj).map((e) => ({
    kind: str(first(e, ["event", "kind", "type", "action"])).trim() || "note",
    text: str(first(e, ["note", "text", "body", "message", "comment", "summary", "detail"])),
    by: personOf(first(e, ["by", "author", "actor", "builder", "user", "who"])),
    at: str(first(e, ["at", "created_at", "timestamp", "time", "date"])).trim() || null,
    status: str(e.status).trim() || null,
    reference: str(e.reference).trim() || null,
  }));
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
    blockedBy: Array.isArray(o.blocked_by) ? o.blocked_by.map(intOf).filter((x): x is number => x !== null) : [],
    history: historyOf(o.history ?? o.events),
  };
}

const TICKET_KEYS = /^(work_?items|workItems|tickets)$/i;

/**
 * The current frozen slice from the spec: its name, and the tickets it names
 * — numbers (or "#123", or objects with a number) in a work_items / tickets
 * list anywhere in the spec. A spec that names none says so (listsTickets).
 */
export function sliceOf(spec: unknown): HouseSlice {
  const root = isObj(spec) ? spec : {};
  const slice = isObj(root.slice) ? root.slice : isObj(root.frozen_slice) ? root.frozen_slice : isObj(root.current_slice) ? root.current_slice : null;
  const name = str(first(slice, ["name", "title", "label", "version"]) ?? first(root, ["slice_name", "slice", "name", "title", "version"])).trim() || null;
  const numbers: number[] = [];
  let listsTickets = false;
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (TICKET_KEYS.test(k) && Array.isArray(x)) {
        listsTickets = true;
        for (const item of x) {
          const n = isObj(item) ? intOf(item.number ?? item.n) : intOf(item);
          if (n !== null && !numbers.includes(n)) numbers.push(n);
        }
      } else walk(x, depth + 1);
    }
  };
  walk(spec, 0);
  return { name, numbers, listsTickets };
}
