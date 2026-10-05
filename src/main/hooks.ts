import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { MB_DIR } from "./store";
import { SessionManager } from "./sessions";
import { SessionInfo } from "../shared/types";
import { writeFileAtomic, writeGenerated } from "./fileOps";

const EVENTS_DIR = path.join(MB_DIR, "events");
/** Where hook scripts from older builds append; still read, for one that runs on after an upgrade. */
const LEGACY_EVENTS_FILE = path.join(MB_DIR, "events.jsonl");
const HOOK_SCRIPT = path.join(MB_DIR, "hook.sh");
const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const POLL_MS = 500;

// PreToolUse clears "waiting" the moment an approved tool starts running —
// without it, a permission approval stays amber until the whole turn finishes.
const HOOK_EVENTS = ["Stop", "Notification", "UserPromptSubmit", "PreToolUse"] as const;

// Codex uses the same hook format in its own file. It has no Notification event:
// PermissionRequest is its "blocked on you", and because that fires after
// PreToolUse, PostToolUse is what flips an approved tool back to working.
const CODEX_DIR = path.join(os.homedir(), ".codex");
const CODEX_HOOKS = path.join(CODEX_DIR, "hooks.json");
const CODEX_EVENTS = ["Stop", "PermissionRequest", "UserPromptSubmit", "PreToolUse", "PostToolUse"] as const;

/**
 * Codex hooks are only managed where the Codex CLI is installed. ~/.codex alone
 * proves nothing: the ChatGPT and Codex desktop apps create it too, and they
 * also read ~/.codex/hooks.json. `codexBin` is the resolved binary path, or null.
 */
const codexPresent = (codexBin: string | null) => !!codexBin && fs.existsSync(codexBin);

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

// "pane" is the MOCKINGBIRD_SESSION the pane exported, inherited through the
// agent — empty for agents run outside Mockingbird. Each event gets a file of
// its own, written under a dot-name and then renamed into place: payloads carry
// whole file contents, so hooks running at once would interleave in a shared
// file, and the app never reads an event that is still being written.
const SCRIPT = `#!/bin/bash
# Mockingbird status hook — leaves each agent hook event in a file for the app to read.
dir="${EVENTS_DIR}"
mkdir -p "$dir"
tmp=$(mktemp "$dir/.tmp.XXXXXXXX") || exit 0
if { printf '{"event":"%s","ts":%s,"pane":"%s","payload":' "$1" "$(date +%s)" "\${MOCKINGBIRD_SESSION:-}"; cat; printf '}\\n'; } > "$tmp"; then
  mv -f "$tmp" "$dir/$(date +%s)-\${tmp##*.}.json" || rm -f "$tmp"
else
  rm -f "$tmp"
fi
exit 0
`;

/** Keep hook.sh current: installs from older builds wrote an older script. */
export function ensureHookScript(): void {
  if (!fs.existsSync(HOOK_SCRIPT)) return; // hooks were never installed — the Install button writes it
  try {
    writeGenerated(HOOK_SCRIPT, SCRIPT, 0o755);
  } catch (err) {
    console.error(`[hooks] couldn't update ${HOOK_SCRIPT}; its events still arrive through ${LEGACY_EVENTS_FILE}:`, err);
  }
}

/** Write hook.sh and merge our hooks into ~/.claude/settings.json (preserving existing hooks). */
export function installHooks(codexBin: string | null): { installed: boolean; message: string } {
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  writeGenerated(HOOK_SCRIPT, SCRIPT, 0o755);

  // the user's own Claude and Codex configs are replaced in one step, so a
  // crash mid-write can't leave them truncated
  const settings = readConfig(CLAUDE_SETTINGS);
  mergeHooks(settings, HOOK_EVENTS);
  writeFileAtomic(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));

  if (!codexPresent(codexBin)) return { installed: true, message: "Hooks installed into ~/.claude/settings.json" };
  const codex = readConfig(CODEX_HOOKS);
  mergeHooks(codex, CODEX_EVENTS);
  writeFileAtomic(CODEX_HOOKS, JSON.stringify(codex, null, 2)); // creates ~/.codex when Codex has never run
  return {
    installed: true,
    message:
      "Hooks installed into ~/.claude/settings.json and ~/.codex/hooks.json. " +
      "Codex ignores new hooks until you approve them once: type /hooks in any Codex session.",
  };
}

export function hookStatus(codexBin: string | null): { claude: boolean; codex: boolean | null } {
  return { claude: wired(CLAUDE_SETTINGS, HOOK_EVENTS), codex: codexPresent(codexBin) ? wired(CODEX_HOOKS, CODEX_EVENTS) : null };
}

export function hooksInstalled(codexBin: string | null): boolean {
  // every event must be wired — an older install missing one counts as not
  // installed so the UI offers the one-click upgrade
  return wired(CLAUDE_SETTINGS, HOOK_EVENTS) && (!codexPresent(codexBin) || wired(CODEX_HOOKS, CODEX_EVENTS));
}

type StatusHandler = (session: SessionInfo, status: string) => void;
/** A prompt was submitted in a pane: its turn is starting. */
type PromptHandler = (session: SessionInfo, prompt: string) => void;

/** One hook event → its pane's status, and the alert and prompt callbacks that follow from it. */
function routeEvent(evt: any, sessions: SessionManager, onStatus: StatusHandler, onPrompt?: PromptHandler): void {
  const cwd: string | undefined = typeof evt.payload?.cwd === "string" ? evt.payload.cwd : undefined;
  if (!cwd && !evt.pane) return;
  const msg = typeof evt.payload?.message === "string" ? evt.payload.message : undefined;
  const conversationId: string | undefined = typeof evt.payload?.session_id === "string" ? evt.payload.session_id : undefined;
  const paneId = typeof evt.pane === "string" && evt.pane ? evt.pane : undefined;
  // the transcript's location says which agent wrote the event
  const transcript = typeof evt.payload?.transcript_path === "string" ? evt.payload.transcript_path : "";
  const agent = transcript.includes("/.codex/") ? ("codex" as const) : ("claude" as const);
  const route = { cwd, conversationId, paneId, agent };
  // Claude Code's ~60s idle reminder ("Claude is waiting for your input")
  // is not blocked-on-you — treat it as idle so finished sessions don't
  // flip amber a minute after you walk away.
  if (evt.event === "Notification" && msg && /waiting for your input/i.test(msg)) {
    sessions.statusFromHook({ ...route, status: "idle" });
    return;
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
  const info = sessions.statusFromHook({ ...route, status, reason });
  if (info && (status === "idle" || status === "waiting")) onStatus(info, status);
  if (info && evt.event === "UserPromptSubmit") onPrompt?.(info, typeof evt.payload?.prompt === "string" ? evt.payload.prompt : "");
}

/**
 * Read hook events as they arrive — a file each in ~/.mockingbird/events,
 * taken oldest first and deleted once read — and route them to the session
 * manager. Only events written after this starts count. Returns a function
 * that stops watching.
 */
export function watchEvents(sessions: SessionManager, onStatus: StatusHandler, onPrompt?: PromptHandler): () => void {
  const handle = (raw: string, source: string) => {
    let evt: any;
    try {
      evt = JSON.parse(raw);
    } catch {
      console.warn(`[hooks] skipped a hook event that isn't JSON (${source}): ${raw.slice(0, 200)}`);
      return;
    }
    try {
      routeEvent(evt, sessions, onStatus, onPrompt);
    } catch (err) {
      console.error(`[hooks] handling ${evt?.event} for pane ${evt?.pane || "(none)"} failed:`, err);
    }
  };

  try {
    // events left from before this run describe panes that are gone
    fs.rmSync(EVENTS_DIR, { recursive: true, force: true });
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
    fs.rmSync(LEGACY_EVENTS_FILE, { force: true });
  } catch (err) {
    console.error(`[hooks] couldn't clear earlier hook events in ${MB_DIR}:`, err);
  }

  let problem = "";
  const drain = () => {
    let names: string[];
    try {
      names = fs.readdirSync(EVENTS_DIR).filter((n) => n.endsWith(".json") && !n.startsWith("."));
      problem = "";
    } catch (err) {
      const why = (err as Error).message;
      if (why !== problem) console.error(`[hooks] can't read ${EVENTS_DIR}; pane statuses won't update:`, err);
      problem = why;
      return;
    }
    const files: { file: string; at: bigint }[] = [];
    for (const n of names) {
      const file = path.join(EVENTS_DIR, n);
      try {
        files.push({ file, at: fs.statSync(file, { bigint: true }).mtimeNs });
      } catch (err) {
        console.error(`[hooks] can't read hook event ${file}:`, err);
      }
    }
    // a pane's hooks run one after another, so the order they were written in is the order they happened
    files.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.file < b.file ? -1 : 1));
    for (const { file } of files) {
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
        fs.rmSync(file, { force: true });
      } catch (err) {
        console.error(`[hooks] can't read hook event ${file}:`, err);
        continue;
      }
      handle(raw, path.basename(file));
    }
  };
  const timer = setInterval(drain, POLL_MS);

  // A hook script from an older build appends lines to one file instead. A
  // line still being written waits in `carry` for the rest of it.
  let offset = 0;
  let carry = "";
  let decoder = new StringDecoder("utf8");
  const readLegacy = (curr: fs.Stats) => {
    if (curr.size < offset) {
      offset = 0; // removed or replaced: start over
      carry = "";
      decoder = new StringDecoder("utf8");
    }
    if (curr.size <= offset) return;
    let text: string;
    try {
      const fd = fs.openSync(LEGACY_EVENTS_FILE, "r");
      try {
        const buf = Buffer.alloc(curr.size - offset);
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        offset += n;
        text = decoder.write(buf.subarray(0, n));
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      console.error(`[hooks] can't read ${LEGACY_EVENTS_FILE}:`, err);
      return;
    }
    const lines = (carry + text).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) handle(line, LEGACY_EVENTS_FILE);
  };
  fs.watchFile(LEGACY_EVENTS_FILE, { interval: POLL_MS }, readLegacy);

  return () => {
    clearInterval(timer);
    fs.unwatchFile(LEGACY_EVENTS_FILE, readLegacy);
  };
}
