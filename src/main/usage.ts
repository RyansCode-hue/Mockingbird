import * as fs from "fs";
import * as path from "path";
import { MB_DIR } from "./store";
import { capitalize, type AgentUsage, type UsageLimit, type UsageReport } from "../shared/types";
import { readJsonFile, readSlice, writeGenerated } from "./fileOps";
import { CLAUDE_SETTINGS, codexRollouts, epochMs } from "./agentFiles";

const USAGE_FILE = path.join(MB_DIR, "usage.json");
// the last payload that carried the 5-hour window — the CLI leaves it out of some
const FIVE_HOUR_FILE = path.join(MB_DIR, "usage-5h.json");
const STATUSLINE_SCRIPT = path.join(MB_DIR, "statusline.sh");
const STATUSLINE_SETTINGS = path.join(MB_DIR, "statusline-settings.json");

// Claude Code only exposes plan rate limits through the statusline payload.
// The script prints nothing (so no status line is drawn) and swaps the file in
// with mv so the watcher never reads a half-written document. Payloads carry
// no limits until a session's first API response, so those are dropped rather
// than allowed to replace another session's real numbers. Some payloads carry
// the weekly window but not the 5-hour one, so the last one that had it is kept too.
const SCRIPT = `#!/bin/bash
# Mockingbird usage reporter — saves Claude Code's statusline payload for the app to read.
tmp="${USAGE_FILE}.$$"
cat > "$tmp"
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
  return ["--settings", STATUSLINE_SETTINGS];
}

const CODEX_FILES_CHECKED = 12; // newest rollouts; limits ride on every turn, so the latest file has them
const CODEX_TAIL_BYTES = 256 * 1024;

let claudePlan: string | null = null;
/** From `claude auth status` (subscriptionType) — the statusline payload doesn't carry it. */
export function setClaudePlan(plan: string | null): void {
  claudePlan = plan ? capitalize(plan) : null;
}

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
  const add = (label: string, w: any) => {
    if (typeof w?.used_percentage === "number") limits.push({ label, usedPct: w.used_percentage, resetsAt: epochMs(w.resets_at) });
  };
  const fiveHour = rl?.five_hour ?? openFiveHourWindow();
  add("5-hour limit", fiveHour);
  add("Weekly · all models", rl?.seven_day);
  for (const [key, name] of Object.entries(CLAUDE_MODEL_WEEKLY)) add(`Weekly · ${name}`, rl?.[key]);
  if (!limits.length) return null;
  if (typeof fiveHour?.used_percentage !== "number") {
    limits.unshift({ label: "5-hour limit", usedPct: 0, resetsAt: null, note: "no reading yet" });
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

const windowLabel = (minutes: unknown) =>
  minutes === 300 ? "5-hour limit" : minutes === 10080 ? "Weekly limit" : typeof minutes === "number" ? `${Math.round(minutes / 60)}-hour limit` : "Limit";

/**
 * Codex writes its plan limits into each session's rollout as token_count
 * events. The format is undocumented, so anything unexpected yields null
 * (no Codex usage shown) rather than a guess.
 */
function readCodex(): AgentUsage | null {
  const newest: { file: string; mtime: number }[] = [];
  for (const file of codexRollouts(CODEX_FILES_CHECKED * 3)) {
    try {
      newest.push({ file, mtime: fs.statSync(file).mtimeMs });
    } catch {
      continue; // removed since it was listed
    }
  }
  newest.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of newest.slice(0, CODEX_FILES_CHECKED)) {
    const hit = lastRateLimits(file);
    if (!hit) continue;
    const limits: UsageLimit[] = [];
    for (const w of [hit.rl.primary, hit.rl.secondary]) {
      if (typeof w?.used_percent === "number") limits.push({ label: windowLabel(w.window_minutes), usedPct: w.used_percent, resetsAt: epochMs(w.resets_at ?? w.reset_at) });
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
