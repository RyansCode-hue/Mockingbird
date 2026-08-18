import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MB_DIR } from "./store";
import { SessionManager } from "./sessions";
import { SessionInfo } from "../shared/types";

const EVENTS_FILE = path.join(MB_DIR, "events.jsonl");
const HOOK_SCRIPT = path.join(MB_DIR, "hook.sh");
const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

// PreToolUse clears "waiting" the moment an approved tool starts running —
// without it, a permission approval stays amber until the whole turn finishes.
const HOOK_EVENTS = ["Stop", "Notification", "UserPromptSubmit", "PreToolUse"] as const;

const SCRIPT = `#!/bin/bash
# Mockingbird status hook — appends Claude Code hook events for the app to tail.
payload=$(cat)
printf '{"event":"%s","ts":%s,"payload":%s}\\n' "$1" "$(date +%s)" "$payload" >> "${EVENTS_FILE}"
exit 0
`;

/** Write hook.sh and merge our hooks into ~/.claude/settings.json (preserving existing hooks). */
export function installHooks(): { installed: boolean; message: string } {
  fs.mkdirSync(MB_DIR, { recursive: true });
  fs.writeFileSync(HOOK_SCRIPT, SCRIPT, { mode: 0o755 });
  if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, "");

  let settings: any = {};
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    // an unparseable existing file must abort: the write below replaces the
    // whole document, so proceeding would wipe the user's real Claude settings
    const raw = fs.readFileSync(CLAUDE_SETTINGS, "utf8");
    try {
      settings = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      throw new Error(
        `~/.claude/settings.json is not valid JSON (${(err as Error).message}). ` +
          `Fix or move that file, then install hooks again — Mockingbird will not overwrite it.`
      );
    }
  }
  settings.hooks = settings.hooks ?? {};

  for (const event of HOOK_EVENTS) {
    const cmd = `"${HOOK_SCRIPT}" ${event}`;
    const existing: any[] = settings.hooks[event] ?? [];
    const already = JSON.stringify(existing).includes(HOOK_SCRIPT);
    if (!already) {
      existing.push({ hooks: [{ type: "command", command: cmd }] });
      settings.hooks[event] = existing;
    }
  }

  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  return { installed: true, message: "Hooks installed into ~/.claude/settings.json" };
}

export function hooksInstalled(): boolean {
  try {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8"));
    // every event must be wired — an older install missing PreToolUse counts
    // as not installed so the UI offers the one-click upgrade
    return HOOK_EVENTS.every((ev) =>
      JSON.stringify(settings.hooks?.[ev] ?? []).includes(HOOK_SCRIPT)
    );
  } catch {
    return false;
  }
}

/** Tail events.jsonl and route status changes to the session manager. */
export function watchEvents(
  sessions: SessionManager,
  onStatus: (session: SessionInfo, status: string) => void
): void {
  let offset = 0;
  try {
    // PreToolUse makes this file grow with every tool call — trim it on start
    // (we only ever read events appended after launch, so nothing is lost)
    if (fs.statSync(EVENTS_FILE).size > 10_000_000) fs.truncateSync(EVENTS_FILE, 0);
    offset = fs.statSync(EVENTS_FILE).size; // only new events
  } catch {
    fs.writeFileSync(EVENTS_FILE, "");
  }

  fs.watchFile(EVENTS_FILE, { interval: 500 }, (curr) => {
    if (curr.size <= offset) {
      offset = curr.size;
      return;
    }
    const stream = fs.createReadStream(EVENTS_FILE, { start: offset, end: curr.size - 1, encoding: "utf8" });
    let chunk = "";
    stream.on("data", (d) => (chunk += d));
    stream.on("end", () => {
      offset = curr.size;
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          const cwd: string | undefined = evt.payload?.cwd;
          if (!cwd) continue;
          const msg = typeof evt.payload?.message === "string" ? evt.payload.message : undefined;
          // Claude Code's ~60s idle reminder ("Claude is waiting for your input")
          // is not blocked-on-you — treat it as idle so finished sessions don't
          // flip amber a minute after you walk away.
          const claudeId: string | undefined =
            typeof evt.payload?.session_id === "string" ? evt.payload.session_id : undefined;
          if (evt.event === "Notification" && msg && /waiting for your input/i.test(msg)) {
            sessions.statusByCwd(cwd, "idle", undefined, claudeId);
            continue;
          }
          // Stop → idle · Notification → waiting · UserPromptSubmit/PreToolUse → working
          // (PreToolUse is what flips an approved permission back to working immediately)
          const status =
            evt.event === "Stop" ? "idle" : evt.event === "Notification" ? "waiting" : "working";
          // Notification payloads carry a specific message ("Claude needs your
          // permission to use Bash") — surfaced in the pane's waiting banner.
          const reason = evt.event === "Notification" ? msg : undefined;
          const info = sessions.statusByCwd(cwd, status, reason, claudeId);
          if (info && (status === "idle" || status === "waiting")) {
            onStatus(info, status);
          }
        } catch {
          /* malformed line */
        }
      }
    });
  });
}
