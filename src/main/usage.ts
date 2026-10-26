import * as fs from "fs";
import * as path from "path";
import { MB_DIR } from "./store";
import { capitalize, type AgentUsage, type ContextWindow, type SessionInfo, type UsageLimit, type UsageReport } from "../shared/types";
import { isMissing, readJsonFile, readSlice, writeGenerated } from "./fileOps";
import { CLAUDE_SETTINGS, codexRolloutOf, codexRollouts, epochMs } from "./agentFiles";

const USAGE_FILE = path.join(MB_DIR, "usage.json");
// the last payload that carried the 5-hour window — the CLI leaves it out of some
const FIVE_HOUR_FILE = path.join(MB_DIR, "usage-5h.json");
const STATUSLINE_SCRIPT = path.join(MB_DIR, "statusline.sh");
const STATUSLINE_SETTINGS = path.join(MB_DIR, "statusline-settings.json");
/** Each Claude conversation's latest statusline payload, as <conversation id>.json: its context window. */
export const CONTEXT_DIR = path.join(MB_DIR, "context");
/** A conversation id safe to name a file with: what the script accepts, and what the reader looks up. */
const CONVERSATION_ID_RE = /^[A-Za-z0-9-]{1,100}$/;
const CONTEXT_KEEP_MS = 14 * 86_400_000;

// Claude Code only exposes plan rate limits through the statusline payload.
// The script prints nothing (so no status line is drawn) and swaps the file in
// with mv so the watcher never reads a half-written document. Payloads carry
// no limits until a session's first API response, so those are dropped rather
// than allowed to replace another session's real numbers. Some payloads carry
// the weekly window but not the 5-hour one, so the last one that had it is kept too.
// Every payload is also kept per conversation, for its context window; the
// first session_id is the top-level one (the payload's nested ones come later).
const SCRIPT = `#!/bin/bash
# Mockingbird usage reporter — saves Claude Code's statusline payload for the app to read.
tmp="${USAGE_FILE}.$$"
cat > "$tmp"
sid=$(grep -oE '"session_id" *: *"[A-Za-z0-9-]{1,100}"' "$tmp" | head -n 1 | sed -E 's/.*"([A-Za-z0-9-]+)"$/\\1/')
if [ -n "$sid" ] && grep -q '"context_window"' "$tmp"; then
  mkdir -p "${CONTEXT_DIR}" && cp -f "$tmp" "${CONTEXT_DIR}/$sid.json.$$" && mv -f "${CONTEXT_DIR}/$sid.json.$$" "${CONTEXT_DIR}/$sid.json"
fi
if grep -Eq '"(five_hour|seven_day)"' "$tmp"; then
  if grep -q '"five_hour"' "$tmp"; then cp -f "$tmp" "${FIVE_HOUR_FILE}.$$" && mv -f "${FIVE_HOUR_FILE}.$$" "${FIVE_HOUR_FILE}"; fi
  mv -f "$tmp" "${USAGE_FILE}"
else
  rm -f "$tmp"
fi
exit 0
`;

/**
 * Extra claude args that make a session report usage. Empty when the user has
 * their own statusLine — --settings outranks ~/.claude/settings.json and would
 * replace it.
 */
export function usageReporterArgs(): string[] {
  try {
    if (readJsonFile(CLAUDE_SETTINGS, {})?.statusLine) return [];
  } catch (err) {
    console.warn(`usage: cannot read ${CLAUDE_SETTINGS}, usage reporting off: ${(err as Error).message}`);
    return [];
  }
  // running panes run the script every few hundred ms: it is only replaced when it changed, and in one step
  writeGenerated(STATUSLINE_SCRIPT, SCRIPT, 0o755);
  writeGenerated(STATUSLINE_SETTINGS, JSON.stringify({ statusLine: { type: "command", command: `"${STATUSLINE_SCRIPT}"` } }));
  pruneContextReports();
  return ["--settings", STATUSLINE_SETTINGS];
}

/** Drops the context reports of conversations that haven't run for two weeks. */
function pruneContextReports(): void {
  let names: string[];
  try {
    names = fs.readdirSync(CONTEXT_DIR);
  } catch (err) {
    if (!isMissing(err)) console.warn(`usage: cannot list ${CONTEXT_DIR}: ${(err as Error).message}`);
    return;
  }
  const cutoff = Date.now() - CONTEXT_KEEP_MS;
  for (const name of names) {
    const file = path.join(CONTEXT_DIR, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch (err) {
      if (!isMissing(err)) console.warn(`usage: cannot prune ${file}: ${(err as Error).message}`);
    }
  }
}

const CODEX_FILES_CHECKED = 12; // newest rollouts; limits ride on every turn, so the latest file has them
const CODEX_TAIL_BYTES = 256 * 1024;

let claudePlan: string | null = null;
/** From `claude auth status` (subscriptionType) — the statusline payload doesn't carry it. */
export function setClaudePlan(plan: string | null): void {
  claudePlan = plan ? capitalize(plan) : null;
}

const FIVE_HOUR = "5-hour limit";

// Model-scoped weekly windows the Claude CLI reports when the plan has them.
const CLAUDE_MODEL_WEEKLY: Record<string, string> = { seven_day_opus: "Opus", seven_day_sonnet: "Sonnet" };

/** The 5-hour window from the last payload that had one, while that window is still open. */
function openFiveHourWindow(): { used_percentage: number; resets_at: unknown } | null {
  let w: any;
  try {
    w = readJsonFile(FIVE_HOUR_FILE, null)?.rate_limits?.five_hour; // null: never seen one
  } catch (err) {
    console.warn(`usage: cannot read ${FIVE_HOUR_FILE}: ${(err as Error).message}`);
    return null; // the panel says there's no reading
  }
  const resets = epochMs(w?.resets_at);
  return typeof w?.used_percentage === "number" && resets !== null && resets > Date.now() ? w : null;
}

function readClaude(): AgentUsage | null {
  let payload: any;
  try {
    payload = readJsonFile(USAGE_FILE, null);
  } catch (err) {
    console.warn(`usage: cannot read ${USAGE_FILE}: ${(err as Error).message}`);
    return null;
  }
  if (!payload) return null; // no session has reported yet
  const rl = payload.rate_limits;
  const limits: UsageLimit[] = [];
  const add = (w: any, label: string, window: UsageLimit["window"], model?: string) => {
    if (typeof w?.used_percentage === "number") limits.push({ label, window, ...(model ? { model } : {}), usedPct: w.used_percentage, resetsAt: epochMs(w.resets_at) });
  };
  const fiveHour = rl?.five_hour ?? openFiveHourWindow();
  add(fiveHour, FIVE_HOUR, "5h");
  add(rl?.seven_day, "Weekly · all models", "week");
  for (const [key, name] of Object.entries(CLAUDE_MODEL_WEEKLY)) add(rl?.[key], `Weekly · ${name}`, "week", name);
  if (!limits.length) return null;
  if (typeof fiveHour?.used_percentage !== "number") {
    limits.unshift({ label: FIVE_HOUR, window: "5h", usedPct: 0, resetsAt: null, note: "no reading yet" });
  }
  return { agent: "claude", plan: claudePlan, limits, at: fs.statSync(USAGE_FILE).mtimeMs };
}

/** The newest `rate_limits` event in a rollout, read from its tail. Null when it has none. */
function lastRateLimits(file: string): { rl: any; at: number } | null {
  let lines: string[];
  try {
    lines = readSlice(file, "end", CODEX_TAIL_BYTES).split("\n");
  } catch (err) {
    console.warn(`usage: cannot read Codex session ${file}: ${(err as Error).message}`);
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const e = JSON.parse(lines[i]);
      const rl = e.payload?.rate_limits ?? e.payload?.info?.rate_limits;
      if (rl?.primary || rl?.secondary) return { rl, at: epochMs(e.timestamp) ?? fs.statSync(file).mtimeMs };
    } catch {
      /* the tail's first line is usually cut mid-way — keep looking */
    }
  }
  return null;
}

/** A Codex window by its length in minutes. */
const codexWindow = (minutes: unknown): Pick<UsageLimit, "label" | "window"> =>
  minutes === 300
    ? { label: FIVE_HOUR, window: "5h" }
    : minutes === 10080
      ? { label: "Weekly limit", window: "week" }
      : { label: typeof minutes === "number" ? `${Math.round(minutes / 60)}-hour limit` : "Limit", window: "other" };

/**
 * Codex writes its plan limits into each session's rollout as token_count
 * events. The format is undocumented, so anything unexpected yields null
 * (no Codex usage shown) rather than a guess.
 */
function readCodex(): AgentUsage | null {
  const newest: { file: string; mtime: number }[] = [];
  try {
    for (const file of codexRollouts(CODEX_FILES_CHECKED * 3)) {
      try {
        newest.push({ file, mtime: fs.statSync(file).mtimeMs });
      } catch {
        continue; // removed since it was listed
      }
    }
  } catch (err) {
    console.warn(`usage: ${(err as Error).message}`);
    return null;
  }
  newest.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of newest.slice(0, CODEX_FILES_CHECKED)) {
    const hit = lastRateLimits(file);
    if (!hit) continue;
    const limits: UsageLimit[] = [];
    for (const w of [hit.rl.primary, hit.rl.secondary]) {
      if (typeof w?.used_percent === "number") limits.push({ ...codexWindow(w.window_minutes), usedPct: w.used_percent, resetsAt: epochMs(w.resets_at ?? w.reset_at) });
    }
    if (!limits.length) return null;
    const plan = typeof hit.rl.plan_type === "string" ? capitalize(hit.rl.plan_type) : null;
    return { agent: "codex", plan, limits, at: hit.at };
  }
  return null;
}

/** Latest plan usage for each agent; an agent is null until one of its sessions has reported. */
export function readUsage(): UsageReport {
  return { claude: readClaude(), codex: readCodex() };
}

/** Calls onChange whenever either agent's usage changes (Claude's file is watched; Codex is polled). */
export function watchUsage(onChange: (u: UsageReport) => void): void {
  let last = JSON.stringify(readUsage());
  const check = () => {
    const u = readUsage();
    const json = JSON.stringify(u);
    if (json !== last) {
      last = json;
      onChange(u);
    }
  };
  fs.watchFile(USAGE_FILE, { interval: 2000 }, check);
  setInterval(check, 60_000);
}

// ---- a session's context window ----------------------------------------------

const NO_REPLY_YET = "No reply yet in this conversation";

/** A failure the panel shows in a few words; the details go to the log. */
function contextError(what: string, err: unknown): ContextWindow {
  console.warn(`usage: context window: ${what}: ${(err as Error)?.message ?? err}`);
  return { state: "error", why: `Couldn't read ${what}` };
}

/** Whether the user's own statusLine replaces Mockingbird's reporter (so Claude's sessions report nothing). */
function ownStatusLine(): boolean {
  try {
    return !!readJsonFile(CLAUDE_SETTINGS, {})?.statusLine;
  } catch {
    return true; // usageReporterArgs turns reporting off then too, and logs why
  }
}

/** A Claude conversation's context window, from the statusline payload the reporter kept for it. */
export function claudeContext(id: string, dir = CONTEXT_DIR): ContextWindow {
  if (!CONVERSATION_ID_RE.test(id)) return contextError("the report", new Error(`unexpected conversation id ${JSON.stringify(id)}`));
  const file = path.join(dir, `${id}.json`);
  let payload: any;
  try {
    payload = readJsonFile(file, null);
  } catch (err) {
    return contextError("Claude's report", err);
  }
  if (!payload) {
    return ownStatusLine()
      ? { state: "none", why: "Not reported: your own statusLine in ~/.claude/settings.json replaces Mockingbird's reporter" }
      : { state: "none", why: "No report yet — appears after this session's next reply" };
  }
  const cw = payload.context_window;
  const tokens = cw?.total_input_tokens;
  const window = cw?.context_window_size;
  if (typeof tokens !== "number" || typeof window !== "number" || !(window > 0)) {
    return contextError("Claude's report", new Error(`${file} has no context_window this app understands`));
  }
  if (tokens <= 0) return { state: "none", why: NO_REPLY_YET };
  let at: number;
  try {
    at = fs.statSync(file).mtimeMs;
  } catch (err) {
    return contextError("Claude's report", err);
  }
  return { state: "reading", agent: "claude", tokens, window, at, ...claudeExtras(payload) };
}

/**
 * What else Claude Code 2.1.3xx's statusline payload says about the
 * conversation: the model (model.id), the prompt cache (prompt_cache: warm,
 * expires_at in epoch seconds, recache_tokens_if_cold), and the process's
 * running cost (cost.total_cost_usd, API list prices). Each is left out when
 * missing or not the type expected: older CLIs don't send prompt_cache.
 */
export function claudeExtras(payload: any): Pick<Extract<ContextWindow, { state: "reading" }>, "model" | "cache" | "costUsd"> {
  const out: Pick<Extract<ContextWindow, { state: "reading" }>, "model" | "cache" | "costUsd"> = {};
  if (typeof payload?.model?.id === "string") out.model = payload.model.id;
  const pc = payload?.prompt_cache;
  if (typeof pc?.warm === "boolean") {
    out.cache = {
      warm: pc.warm,
      expiresAt: typeof pc.expires_at === "number" ? pc.expires_at * 1000 : null,
      recacheTokens: typeof pc.recache_tokens_if_cold === "number" ? pc.recache_tokens_if_cold : null,
    };
  }
  if (typeof payload?.cost?.total_cost_usd === "number") out.costUsd = payload.cost.total_cost_usd;
  return out;
}

const rolloutFiles = new Map<string, string>();

/**
 * A Codex conversation's context window, from the newest token_count event in
 * its rollout: the last turn's tokens (what the next one starts from) over
 * the model's window. Codex's own "% context left" sets aside a fixed baseline
 * first, so it reads a little differently.
 */
export function codexContext(id: string, root?: string): ContextWindow {
  let file = rolloutFiles.get(id) ?? null;
  if (!file || !fs.existsSync(file)) {
    try {
      file = root ? codexRolloutOf(id, root) : codexRolloutOf(id);
    } catch (err) {
      return contextError("Codex's session log", err);
    }
    if (!file) return { state: "none", why: NO_REPLY_YET };
    rolloutFiles.set(id, file);
  }
  let lines: string[];
  try {
    lines = readSlice(file, "end", CODEX_TAIL_BYTES).split("\n");
  } catch (err) {
    return contextError("Codex's session log", err);
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"last_token_usage"')) continue;
    let e: any;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue; // the tail's first line is usually cut mid-way
    }
    const info = e.payload?.info;
    const last = info?.last_token_usage;
    const tokens = typeof last?.total_tokens === "number" ? last.total_tokens : (last?.input_tokens ?? 0) + (last?.output_tokens ?? 0);
    const window = info?.model_context_window;
    if (typeof window !== "number" || !(window > 0)) return { state: "none", why: "Codex didn't report this model's context window" };
    if (!(tokens > 0)) return { state: "none", why: NO_REPLY_YET };
    return { state: "reading", agent: "codex", tokens, window, at: epochMs(e.timestamp) ?? fs.statSync(file).mtimeMs };
  }
  return { state: "none", why: NO_REPLY_YET };
}

/** The context window of a session on this Mac: its current conversation's, as its agent last reported it. */
export function readContextWindow(s: Pick<SessionInfo, "shell" | "agent" | "conversation">): ContextWindow {
  if (s.shell) return { state: "none", why: "A terminal has no context window" };
  const conv = s.conversation;
  if (!conv || conv.agent !== (s.agent ?? "claude")) return { state: "none", why: NO_REPLY_YET };
  return conv.agent === "codex" ? codexContext(conv.id) : claudeContext(conv.id);
}
