import * as fs from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { MB_DIR } from "./store";
import { SessionManager } from "./sessions";
import { SessionInfo } from "../shared/types";
import { readJsonFile, writeFileAtomic, writeGenerated } from "./fileOps";
import { CLAUDE_SETTINGS, CODEX_DIR } from "./agentFiles";
import { hookShellLines, writeClaimsCheck } from "./team/claims";
import type { ClaimWarning } from "../shared/team/claims";
import type { MigrationHit } from "../shared/team/migrations";
import type { OverlapHit } from "../shared/team/overlaps";

const EVENTS_DIR = path.join(MB_DIR, "events");
/** Where hook scripts from older builds append; still read, for one that runs on after an upgrade. */
const LEGACY_EVENTS_FILE = path.join(MB_DIR, "events.jsonl");
const HOOK_SCRIPT = path.join(MB_DIR, "hook.sh");
const POLL_MS = 500;

// PreToolUse clears "waiting" the moment an approved tool starts running —
// without it, a permission approval stays amber until the whole turn finishes.
// It also checks edits against a team room's claims, and SessionStart hands an
// agent in a room's repo the room's instructions (see team/claims.ts).
const HOOK_EVENTS = ["Stop", "Notification", "UserPromptSubmit", "PreToolUse", "SessionStart"] as const;

// Codex uses the same hook format in its own file. It has no Notification event:
// PermissionRequest is its "blocked on you", and because that fires after
// PreToolUse, PostToolUse is what flips an approved tool back to working.
const CODEX_HOOKS = path.join(CODEX_DIR, "hooks.json");
const CODEX_EVENTS = ["Stop", "PermissionRequest", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionStart"] as const;

/**
 * Codex hooks are only managed where the Codex CLI is installed. ~/.codex alone
 * proves nothing: the ChatGPT and Codex desktop apps create it too, and they
 * also read ~/.codex/hooks.json. `codexBin` is the resolved binary path, or null.
 */
const codexPresent = (codexBin: string | null) => !!codexBin && fs.existsSync(codexBin);

/**
 * A JSON config we are about to rewrite: {} when there is none yet. One that
 * can't be read, or doesn't hold a JSON object, aborts the install rather than
 * being replaced — it is the user's own file.
 */
function readConfig(file: string): any {
  const refuse = (why: string) => new Error(`${why}. Fix or move that file, then install hooks again — Mockingbird will not overwrite it.`);
  let config: any;
  try {
    config = readJsonFile(file, {});
  } catch (err) {
    throw refuse((err as Error).message);
  }
  const isObject = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObject(config) || (config.hooks !== undefined && !isObject(config.hooks))) throw refuse(`${file} isn't a settings object with "hooks" as an object`);
  return config;
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
    const config = readJsonFile(file, {});
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
// SessionStart leaves its event too (a pane that just started or resumed is at
// its prompt: see routeEvent), then answers the agent with the room's instructions.
//
// Team room claims: an edit of a file a teammate's claimed ticket owns is answered
// with the same JSON by both CLIs. The first such edit of a file in a
// conversation is denied, with the reason for the agent (Claude Code and Codex
// both give a deny's reason to the model, before anything is written) and a
// systemMessage for the user; repeating it goes through the normal permission
// flow with a reminder (additionalContext). That is the claims' "warned, and
// you can still proceed": "allow" would skip permission prompts the user would
// otherwise see, and its reason reaches only a debug log; "ask" shows its
// reason to the user but not the agent, and Codex doesn't support it (the hook
// fails and the edit runs); additionalContext alone reaches Claude only next
// to the tool's result, after the edit has landed.
const ROOM = hookShellLines();
const SCRIPT = `#!/bin/bash
# Mockingbird hook — leaves each agent hook event in a file for the app to read,
# hands agents in a team room's repo the room's instructions, and checks their edits against its claims.
${ROOM.functions}
dir="${EVENTS_DIR}"
mkdir -p "$dir"
if tmp=$(mktemp "$dir/.tmp.XXXXXXXX"); then
  if { printf '{"event":"%s","ts":%s,"pane":"%s","payload":' "$1" "$(date +%s)" "\${MOCKINGBIRD_SESSION:-}"; cat; printf '}\\n'; } > "$tmp"; then
${ROOM.preToolUse}
    mv -f "$tmp" "$dir/$(date +%s)-\${tmp##*.}.json" || rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
fi
${ROOM.sessionStart}
exit 0
`;

/** Keep hook.sh current: installs from older builds wrote an older script. */
export function ensureHookScript(): void {
  if (!fs.existsSync(HOOK_SCRIPT)) return; // hooks were never installed — the Install button writes it
  try {
    writeClaimsCheck(EVENTS_DIR);
    writeGenerated(HOOK_SCRIPT, SCRIPT, 0o755);
  } catch (err) {
    console.error(`[hooks] couldn't update ${HOOK_SCRIPT}; its events still arrive through ${LEGACY_EVENTS_FILE}:`, err);
  }
}

/**
 * Write hook.sh and merge our hooks into ~/.claude/settings.json (and Codex's
 * hooks.json where its CLI is installed), keeping every hook already there.
 * Both configs are read before either is written, so a refusal changes nothing.
 */
export function installHooks(codexBin: string | null): { installed: boolean; message: string } {
  const withCodex = codexPresent(codexBin);
  const settings = readConfig(CLAUDE_SETTINGS);
  const codex = withCodex ? readConfig(CODEX_HOOKS) : null;

  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  writeClaimsCheck(EVENTS_DIR);
  writeGenerated(HOOK_SCRIPT, SCRIPT, 0o755);
  // the user's own Claude and Codex configs are replaced in one step, so a
  // crash mid-write can't leave them truncated
  mergeHooks(settings, HOOK_EVENTS);
  writeFileAtomic(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  if (!codex) return { installed: true, message: "Hooks installed into ~/.claude/settings.json" };
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
  const s = hookStatus(codexBin);
  return s.claude && s.codex !== false;
}

type StatusHandler = (session: SessionInfo, status: string) => void;
/** A prompt was submitted in a pane: its turn is starting. */
type PromptHandler = (session: SessionInfo, prompt: string) => void;

/** A new migration held back, or a teammate overlap told, by the room checks in an agent's hook. */
export interface RoomCheckNotice {
  pane: string;
  cwd: string;
  conversation: string;
  tool: string;
  migrations: MigrationHit[];
  overlaps: { file: string; hits: OverlapHit[] }[];
}

/** What the room checks left for the app: a claims warning it gave an agent, a migration or overlap notice, or a check's failure. */
export type ClaimEvent = { kind: "warning"; warning: ClaimWarning } | { kind: "room"; notice: RoomCheckNotice } | { kind: "failed"; pane: string; message: string };
type ClaimHandler = (e: ClaimEvent) => void;

function claimEvent(evt: any): ClaimEvent | null {
  const p = evt.payload ?? {};
  const pane = typeof evt.pane === "string" ? evt.pane : "";
  if (evt.event === "ClaimCheckFailed") return { kind: "failed", pane, message: String(p.message ?? "no reason given").slice(0, 2000) };
  if (evt.event === "RoomCheck") {
    if (!Array.isArray(p.migrations) || !Array.isArray(p.overlaps)) {
      console.error(`[hooks] skipped a room check notice that doesn't have the expected shape: ${JSON.stringify(p).slice(0, 300)}`);
      return null;
    }
    return { kind: "room", notice: { pane, cwd: String(p.cwd ?? ""), conversation: String(p.conversation ?? ""), tool: String(p.tool ?? ""), migrations: p.migrations, overlaps: p.overlaps } };
  }
  if (!Array.isArray(p.conflicts) || (p.decision !== "deny" && p.decision !== "context")) {
    console.error(`[hooks] skipped a claim warning that doesn't have the expected shape: ${JSON.stringify(p).slice(0, 300)}`);
    return null;
  }
  return { kind: "warning", warning: { pane, cwd: String(p.cwd ?? ""), conversation: String(p.conversation ?? ""), tool: String(p.tool ?? ""), decision: p.decision, conflicts: p.conflicts } };
}

/** One hook event → its pane's status, and the alert and prompt callbacks that follow from it. */
function routeEvent(evt: any, sessions: SessionManager, onStatus: StatusHandler, onPrompt?: PromptHandler, onClaim?: ClaimHandler): void {
  if (evt.event === "ClaimWarning" || evt.event === "ClaimCheckFailed" || evt.event === "RoomCheck") {
    const e = claimEvent(evt);
    if (e) onClaim?.(e);
    return;
  }
  const cwd: string | undefined = typeof evt.payload?.cwd === "string" ? evt.payload.cwd : undefined;
  if (!cwd && !evt.pane) return;
  const msg = typeof evt.payload?.message === "string" ? evt.payload.message : undefined;
  const conversationId: string | undefined = typeof evt.payload?.session_id === "string" ? evt.payload.session_id : undefined;
  const paneId = typeof evt.pane === "string" && evt.pane ? evt.pane : undefined;
  // the transcript's location says which agent wrote the event
  const transcript = typeof evt.payload?.transcript_path === "string" ? evt.payload.transcript_path : "";
  const agent = transcript.includes("/.codex/") ? ("codex" as const) : ("claude" as const);
  const route = { cwd, conversationId, paneId, agent, transcriptPath: transcript || undefined };
  // An agent that has just started, resumed or cleared its conversation waits at
  // its prompt: no turn has run, so no Stop will come until someone prompts it.
  // A compaction's SessionStart can come mid-turn, so it says nothing. A starting
  // pane is no "Finished" to announce, so onStatus doesn't hear it.
  if (evt.event === "SessionStart") {
    const source = typeof evt.payload?.source === "string" ? evt.payload.source : "startup";
    if (source !== "compact") sessions.statusFromHook({ ...route, status: "idle", started: true });
    return;
  }
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
  const info = sessions.statusFromHook({ ...route, status, reason, finished: evt.event === "Stop" });
  if (info && (status === "idle" || status === "waiting")) onStatus(info, status);
  if (info && evt.event === "UserPromptSubmit") onPrompt?.(info, typeof evt.payload?.prompt === "string" ? evt.payload.prompt : "");
}

/**
 * Read hook events as they arrive — a file each in ~/.mockingbird/events,
 * taken oldest first and deleted once read — and route them to the session
 * manager. Only events written after this starts count. Returns a function
 * that stops watching. `onClaim` hears team rooms' claim warnings.
 */
export function watchEvents(sessions: SessionManager, onStatus: StatusHandler, onPrompt?: PromptHandler, onClaim?: ClaimHandler): () => void {
  const handle = (raw: string, source: string) => {
    let evt: any;
    try {
      evt = JSON.parse(raw);
    } catch {
      console.warn(`[hooks] skipped a hook event that isn't JSON (${source}): ${raw.slice(0, 200)}`);
      return;
    }
    try {
      routeEvent(evt, sessions, onStatus, onPrompt, onClaim);
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
