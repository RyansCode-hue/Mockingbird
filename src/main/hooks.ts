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

// Codex uses the same hook format in its own file. It has no Notification event:
// PermissionRequest is its "blocked on you", and because that fires after
// PreToolUse, PostToolUse is what flips an approved tool back to working.
const CODEX_DIR = path.join(os.homedir(), ".codex");
const CODEX_HOOKS = path.join(CODEX_DIR, "hooks.json");
const CODEX_EVENTS = ["Stop", "PermissionRequest", "UserPromptSubmit", "PreToolUse", "PostToolUse"] as const;

/** Codex hooks are only managed on machines that have Codex set up. */
const codexPresent = () => fs.existsSync(CODEX_DIR);

/** Parse a JSON config we are about to rewrite; an unparseable file aborts rather than being replaced. */
function readConfig(file: string): any {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON (${(err as Error).message}). ` +
        `Fix or move that file, then install hooks again — Mockingbird will not overwrite it.`
    );
  }
}

/** Add our hook command to each event, leaving every existing hook in place. */
function mergeHooks(config: any, events: readonly string[]): void {
  config.hooks = config.hooks ?? {};
  for (const event of events) {
    const existing: any[] = config.hooks[event] ?? [];
    if (!JSON.stringify(existing).includes(HOOK_SCRIPT)) {
      existing.push({ hooks: [{ type: "command", command: `"${HOOK_SCRIPT}" ${event}` }] });
      config.hooks[event] = existing;
    }
  }
}

function wired(file: string, events: readonly string[]): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    return events.every((ev) => JSON.stringify(config.hooks?.[ev] ?? []).includes(HOOK_SCRIPT));
  } catch {
    return false; // missing or unreadable counts as not installed — the UI offers the install
  }
}

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

  const settings = readConfig(CLAUDE_SETTINGS);
  mergeHooks(settings, HOOK_EVENTS);
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));

  if (!codexPresent()) return { installed: true, message: "Hooks installed into ~/.claude/settings.json" };
  const codex = readConfig(CODEX_HOOKS);
  mergeHooks(codex, CODEX_EVENTS);
  fs.writeFileSync(CODEX_HOOKS, JSON.stringify(codex, null, 2));
  return {
    installed: true,
    message:
      "Hooks installed into ~/.claude/settings.json and ~/.codex/hooks.json. " +
      "Codex ignores new hooks until you approve them once: type /hooks in any Codex session.",
  };
}

export function hookStatus(): { claude: boolean; codex: boolean | null } {
  return { claude: wired(CLAUDE_SETTINGS, HOOK_EVENTS), codex: codexPresent() ? wired(CODEX_HOOKS, CODEX_EVENTS) : null };
}

export function hooksInstalled(): boolean {
  // every event must be wired — an older install missing one counts as not
  // installed so the UI offers the one-click upgrade
  return wired(CLAUDE_SETTINGS, HOOK_EVENTS) && (!codexPresent() || wired(CODEX_HOOKS, CODEX_EVENTS));
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
          const blocked = evt.event === "Notification" || evt.event === "PermissionRequest";
          const status = evt.event === "Stop" ? "idle" : blocked ? "waiting" : "working";
          // Notification payloads carry a specific message ("Claude needs your
          // permission to use Bash") — surfaced in the pane's waiting banner.
          const tool = typeof evt.payload?.tool_name === "string" ? evt.payload.tool_name : "a tool";
          const reason =
            evt.event === "Notification" ? msg
            : evt.event === "PermissionRequest" ? `Codex needs your permission to use ${tool}`
            : undefined;
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
