import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MB_DIR } from "./store";
import { UsageInfo, UsageWindow } from "../shared/types";

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

function toWindow(w: any): UsageWindow | undefined {
  if (typeof w?.used_percentage !== "number") return undefined;
  // resets_at arrives as epoch seconds or an ISO string depending on its source
  const r = w.resets_at;
  const ms = typeof r === "number" ? r * 1000 : typeof r === "string" ? Date.parse(r) : NaN;
  return { usedPct: w.used_percentage, resetsAt: Number.isFinite(ms) ? ms : null };
}

/** Last usage any session reported; null when none has yet or plan limits don't apply (API key). */
export function readUsage(): UsageInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(USAGE_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`usage: cannot read ${USAGE_FILE}: ${(err as Error).message}`);
    }
    return null;
  }
  try {
    const limits = JSON.parse(raw).rate_limits;
    const fiveHour = toWindow(limits?.five_hour);
    const sevenDay = toWindow(limits?.seven_day);
    if (!fiveHour && !sevenDay) return null;
    return { fiveHour, sevenDay, at: fs.statSync(USAGE_FILE).mtimeMs };
  } catch (err) {
    console.warn(`usage: ${USAGE_FILE} is not a valid statusline payload: ${(err as Error).message}`);
    return null;
  }
}

export function watchUsage(onChange: (u: UsageInfo | null) => void): void {
  fs.watchFile(USAGE_FILE, { interval: 2000 }, () => onChange(readUsage()));
}
