import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MB_DIR } from "./store";
import type { AgentUsage, UsageLimit, UsageReport } from "../shared/types";

const USAGE_FILE = path.join(MB_DIR, "usage.json");
const STATUSLINE_SCRIPT = path.join(MB_DIR, "statusline.sh");
const STATUSLINE_SETTINGS = path.join(MB_DIR, "statusline-settings.json");
const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

// Claude Code only exposes plan rate limits through the statusline payload.
// The script prints nothing (so no status line is drawn) and swaps the file in
// with mv so the watcher never reads a half-written document. Payloads carry
// no limits until a session's first API response, so those are dropped rather
// than allowed to replace another session's real numbers.
const SCRIPT = `#!/bin/bash
# Mockingbird usage reporter — saves Claude Code's statusline payload for the app to read.
tmp="${USAGE_FILE}.$$"
cat > "$tmp"
if grep -Eq '"(five_hour|seven_day)"' "$tmp"; then mv -f "$tmp" "${USAGE_FILE}"; else rm -f "$tmp"; fi
exit 0
`;

/**
 * Extra claude args that make a session report usage. Empty when the user has
 * their own statusLine — --settings outranks ~/.claude/settings.json and would
 * replace it.
 */
export function usageReporterArgs(): string[] {
  try {
    const raw = fs.readFileSync(CLAUDE_SETTINGS, "utf8");
    if (raw.trim() && JSON.parse(raw).statusLine) return [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`usage: cannot read ${CLAUDE_SETTINGS}, usage reporting off: ${(err as Error).message}`);
      return [];
    }
  }
  fs.mkdirSync(MB_DIR, { recursive: true });
  fs.writeFileSync(STATUSLINE_SCRIPT, SCRIPT, { mode: 0o755 });
  fs.writeFileSync(
    STATUSLINE_SETTINGS,
    JSON.stringify({ statusLine: { type: "command", command: `"${STATUSLINE_SCRIPT}"` } })
  );
  return ["--settings", STATUSLINE_SETTINGS];
}

const CODEX_SESSIONS = path.join(os.homedir(), ".codex", "sessions");
const CODEX_FILES_CHECKED = 12; // newest rollouts; limits ride on every turn, so the latest file has them
const CODEX_TAIL_BYTES = 256 * 1024;

const toMs = (r: unknown): number | null => {
  // resets_at arrives as epoch seconds or an ISO string depending on its source
  const ms = typeof r === "number" ? r * 1000 : typeof r === "string" ? Date.parse(r) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

let claudePlan: string | null = null;
/** From `claude auth status` (subscriptionType) — the statusline payload doesn't carry it. */
export function setClaudePlan(plan: string | null): void {
  claudePlan = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
}

// Model-scoped weekly windows the Claude CLI reports when the plan has them.
const CLAUDE_MODEL_WEEKLY: Record<string, string> = { seven_day_opus: "Opus", seven_day_sonnet: "Sonnet" };

function readClaude(): AgentUsage | null {
  let raw: string;
  try {
    raw = fs.readFileSync(USAGE_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`usage: cannot read ${USAGE_FILE}: ${(err as Error).message}`);
    return null;
  }
  let rl: any;
  try {
    rl = JSON.parse(raw).rate_limits;
  } catch (err) {
    console.warn(`usage: ${USAGE_FILE} is not a valid statusline payload: ${(err as Error).message}`);
    return null;
  }
  const limits: UsageLimit[] = [];
  const add = (label: string, w: any) => {
    if (typeof w?.used_percentage === "number") limits.push({ label, usedPct: w.used_percentage, resetsAt: toMs(w.resets_at) });
  };
  add("5-hour limit", rl?.five_hour);
  add("Weekly · all models", rl?.seven_day);
  for (const [key, name] of Object.entries(CLAUDE_MODEL_WEEKLY)) add(`Weekly · ${name}`, rl?.[key]);
  if (!limits.length) return null;
  return { agent: "claude", plan: claudePlan, limits, at: fs.statSync(USAGE_FILE).mtimeMs };
}

/** The newest `rate_limits` event in a rollout, read from its tail. Null when it has none. */
function lastRateLimits(file: string): { rl: any; at: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, CODEX_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        const rl = e.payload?.rate_limits ?? e.payload?.info?.rate_limits;
        if (rl?.primary || rl?.secondary) return { rl, at: toMs(e.timestamp) ?? fs.statSync(file).mtimeMs };
      } catch {
        /* the tail's first line is usually cut mid-way — keep looking */
      }
    }
    return null;
  } catch (err) {
    console.warn(`usage: cannot read Codex session ${file}: ${(err as Error).message}`);
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
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
  const ls = (dir: string) => {
    try {
      return fs.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  outer: for (const y of ls(CODEX_SESSIONS))
    for (const m of ls(path.join(CODEX_SESSIONS, y)))
      for (const d of ls(path.join(CODEX_SESSIONS, y, m)))
        for (const f of ls(path.join(CODEX_SESSIONS, y, m, d))) {
          if (!f.endsWith(".jsonl")) continue;
          const file = path.join(CODEX_SESSIONS, y, m, d, f);
          try {
            newest.push({ file, mtime: fs.statSync(file).mtimeMs });
          } catch {
            continue;
          }
          if (newest.length >= CODEX_FILES_CHECKED * 3) break outer;
        }
  newest.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of newest.slice(0, CODEX_FILES_CHECKED)) {
    const hit = lastRateLimits(file);
    if (!hit) continue;
    const limits: UsageLimit[] = [];
    for (const w of [hit.rl.primary, hit.rl.secondary]) {
      if (typeof w?.used_percent === "number") limits.push({ label: windowLabel(w.window_minutes), usedPct: w.used_percent, resetsAt: toMs(w.resets_at ?? w.reset_at) });
    }
    if (!limits.length) return null;
    const plan = typeof hit.rl.plan_type === "string" ? hit.rl.plan_type.charAt(0).toUpperCase() + hit.rl.plan_type.slice(1) : null;
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
