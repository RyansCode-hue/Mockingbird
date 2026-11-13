// Stands in for Claude Code or Codex in a pane, for the app tests: `fakeCli.cjs claude|codex <the CLI's arguments>`,
// run by Electron as Node from a bash shim (fakeCli.ts). Nothing calls a model. What Mockingbird reads of a real CLI:
// - it reads its prompt as a TUI does, the terminal raw: keys typed, a bracketed paste (ESC[200~ … ESC[201~) whole,
//   and Enter submitting what's in the prompt;
// - it runs the hooks the user's config names (~/.claude/settings.json, ~/.codex/hooks.json) with the CLI's JSON on
//   their stdin: SessionStart as it starts (source "resume" when resuming), UserPromptSubmit and Stop around each turn;
// - it keeps its conversation where the CLI does (a Claude transcript under ~/.claude/projects, a Codex rollout under
//   ~/.codex/sessions), and resumes one by id (`--resume <id>`, `resume <id>`);
// - it starts Mockingbird's MCP server from its arguments as the CLI would, inside the pane, and calls its tools;
// - Codex's prompt in its arguments (after `--`) is its first turn.
// A turn's prompt can hold directives, each "@word args", several joined by "; @": `@commit <file>` writes the file in
// its folder and commits it; `@finish <summary>` calls finish_step with that summary.
// Everything it sees and does is a JSON line in $HOME/fake-cli/<pane>.jsonl ("started", "paste", "prompt", "commit",
// "tool", "turn-ended"), each with its pid, so a test can tell one launch from the next. A file
// $HOME/fake-cli/kill-on-paste ({ pid, marker, signal }) has it send that pid the signal as soon as a paste holding the
// marker has arrived, before its Enter: SIGKILL leaves what a run ending mid-paste leaves (the file goes once used).
const { execFileSync, spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { mcpLaunchFrom } = require("./cliLaunch.cjs");

const [kind, ...argv] = process.argv.slice(2);
const HOME = process.env.HOME;
const pane = process.env.MOCKINGBIRD_SESSION || "outside";
const cwd = process.cwd();
const logDir = path.join(HOME, "fake-cli");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `${pane}.jsonl`);
const log = (entry) => fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + "\n");

// ---- the arguments, as each CLI reads them --------------------------------------------------------------------------

let resumed = null;
let firstPrompt = null;
if (kind === "claude") {
  const r = argv.indexOf("--resume");
  if (r >= 0) resumed = argv[r + 1];
} else {
  if (argv[0] === "resume" && argv[1] && argv[1] !== "--last") resumed = argv[1];
  const dd = argv.indexOf("--");
  if (dd >= 0) firstPrompt = argv[dd + 1] ?? null;
}
const conv = resumed ?? crypto.randomUUID();

// ---- its conversation, kept where the CLI keeps it ------------------------------------------------------------------

function transcriptPath() {
  if (kind === "claude") return path.join(HOME, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${conv}.jsonl`);
  const root = path.join(HOME, ".codex", "sessions");
  const found = findRollout(root);
  if (found) return found;
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const day = [String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate())];
  return path.join(root, ...day, `rollout-${day.join("-")}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}-${conv}.jsonl`);
}
function findRollout(dir) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  for (const n of names) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) {
      const f = findRollout(p);
      if (f) return f;
    } else if (n.name.endsWith(`-${conv}.jsonl`)) return p;
  }
  return null;
}
const transcript = transcriptPath();
fs.mkdirSync(path.dirname(transcript), { recursive: true });
if (kind === "codex" && !fs.existsSync(transcript)) {
  fs.writeFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: conv, cwd, source: "cli", originator: "codex_cli_rs" } }) + "\n");
}
function remember(role, text) {
  const line =
    kind === "claude"
      ? { type: role, sessionId: conv, cwd, timestamp: new Date().toISOString(), message: { role, content: role === "user" ? text : [{ type: "text", text }] } }
      : { timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } };
  fs.appendFileSync(transcript, JSON.stringify(line) + "\n");
}

// ---- hooks, as the user's config names them -------------------------------------------------------------------------

function hook(event, extra = {}) {
  const file = kind === "claude" ? path.join(HOME, ".claude", "settings.json") : path.join(HOME, ".codex", "hooks.json");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return log({ kind: "hooks", event, ran: 0, why: `${file} isn't there` });
  }
  const payload = JSON.stringify({ session_id: conv, transcript_path: transcript, cwd, hook_event_name: event, ...extra });
  let ran = 0;
  for (const entry of config.hooks?.[event] ?? [])
    for (const h of entry.hooks ?? []) {
      if (h.type !== "command") continue;
      const r = spawnSync("/bin/sh", ["-c", h.command], { input: payload, cwd, env: process.env, encoding: "utf8", timeout: 60_000 });
      ran++;
      if (r.status !== 0) log({ kind: "hooks", event, failed: h.command, status: r.status, stderr: r.stderr });
    }
  if (!ran) log({ kind: "hooks", event, ran: 0, why: `${file} names none` });
}

// ---- Mockingbird's MCP server, started from the arguments inside the pane --------------------------------------------

const launch = mcpLaunchFrom(argv);
let server = null;
let nextId = 1;
const waiting = new Map();
if (launch) {
  server = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  server.stdout.on("data", (d) => {
    out += d;
    for (let nl = out.indexOf("\n"); nl >= 0; nl = out.indexOf("\n")) {
      const line = out.slice(0, nl);
      out = out.slice(nl + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    }
  });
  server.on("exit", (code, signal) => {
    log({ kind: "mcp-exit", code, signal });
    server = null;
    for (const w of waiting.values()) w({ error: { message: `the server exited (${code ?? signal})` } });
    waiting.clear();
  });
  server.stdin.on("error", () => undefined); // a server gone mid-write is said by its exit
}
function request(method, params) {
  if (!server) return Promise.resolve({ error: { message: "no Mockingbird server is running" } });
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ error: { message: `no answer to ${method} within 30 s` } });
    }, 30_000);
    waiting.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const ready = launch
  ? request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `fake-${kind}`, version: "0.0.0" } }).then((m) => {
      if (m.error) log({ kind: "mcp-error", during: "initialize", message: m.error.message });
      else server?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    })
  : Promise.resolve();

// ---- turns -----------------------------------------------------------------------------------------------------------

async function turn(text, how) {
  // an Enter read after its app is gone submits nothing: the pane went with the app
  if (process.ppid !== parent) bye();
  log({ kind: "prompt", text, how });
  hook("UserPromptSubmit", { prompt: text });
  remember("user", text);
  const did = [];
  for (const d of text.split(/\s*;\s*(?=@)/)) {
    const m = /^@(\w+)\s+([\s\S]*)$/.exec(d.trim());
    if (!m) continue;
    if (m[1] === "commit") {
      fs.writeFileSync(path.join(cwd, m[2]), `${m[2]}, written by the stand-in in ${pane}\n`);
      execFileSync("git", ["add", "--", m[2]], { cwd });
      execFileSync("git", ["commit", "-q", "-m", `Add ${m[2]}`], { cwd });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
      log({ kind: "commit", file: m[2], sha });
      did.push(`committed ${m[2]} (${sha.slice(0, 7)})`);
    } else if (m[1] === "finish") {
      await ready;
      const r = await request("tools/call", { name: "finish_step", arguments: { summary: m[2] } });
      const reply = r.error ? `error: ${r.error.message}` : r.result.content.map((c) => c.text).join("\n");
      log({ kind: "tool", name: "finish_step", isError: !!(r.error || r.result.isError), reply });
      did.push(`finish_step: ${reply.split("\n")[0]}`);
    }
  }
  const answer = did.length ? did.join("; ") : "Read it.";
  remember("assistant", answer);
  process.stdout.write(`${answer}\n`);
  hook("Stop", { stop_hook_active: false });
  log({ kind: "turn-ended" });
}
let turns = Promise.resolve();
const queueTurn = (text, how) => {
  turns = turns.then(() => turn(text, how)).catch((err) => log({ kind: "turn-failed", message: String(err && err.stack ? err.stack : err) }));
};

// ---- the prompt, read raw ----------------------------------------------------------------------------------------------

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
let input = "";
let prompt = "";
let pasted = false;
let paste = null;

/** How much of the end of `s` could be the start of `marker`, cut across two reads. */
const partial = (s, marker) => {
  for (let n = Math.min(marker.length - 1, s.length); n > 0; n--) if (marker.startsWith(s.slice(-n))) return n;
  return 0;
};

// The kill is read ahead and kept: the paste's Enter comes 120 ms after it, and a file read or write before the signal
// can take longer than that on a loaded machine.
const killFile = path.join(logDir, "kill-on-paste");
let killAsked = null;
function readKill() {
  try {
    return JSON.parse(fs.readFileSync(killFile, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return null;
  }
}
setInterval(() => {
  killAsked = readKill();
}, 100).unref();

function pasteArrived(text) {
  const kill = killAsked ?? readKill();
  if (kill && text.includes(kill.marker)) {
    process.kill(kill.pid, kill.signal);
    killAsked = null;
    fs.rmSync(killFile, { force: true });
    log({ kind: "paste", text });
    log({ kind: "killed", target: kill.pid, signal: kill.signal });
    // its pane goes with the app it ended, as a real CLI's would: it reads nothing more, an Enter included
    if (kill.signal === "SIGKILL") bye();
    return;
  }
  log({ kind: "paste", text });
}

function feed(chunk) {
  input += chunk;
  while (input) {
    if (paste !== null) {
      const end = input.indexOf(PASTE_END);
      if (end < 0) {
        const keep = partial(input, PASTE_END);
        paste += input.slice(0, input.length - keep);
        input = input.slice(input.length - keep);
        return;
      }
      paste += input.slice(0, end);
      input = input.slice(end + PASTE_END.length);
      prompt += paste;
      pasted = true;
      const text = paste;
      paste = null;
      pasteArrived(text);
      continue;
    }
    if (input.startsWith(PASTE_START)) {
      paste = "";
      input = input.slice(PASTE_START.length);
      continue;
    }
    if (input[0] === "\x1b") {
      // any other escape (a focus report, an arrow): wait for the rest of it, then skip it
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(input) ?? /^\x1b[^[]/.exec(input);
      if (!m) {
        if (input.length < 16) return;
        input = input.slice(1);
        continue;
      }
      input = input.slice(m[0].length);
      continue;
    }
    const c = input[0];
    input = input.slice(1);
    if (c === "\r") {
      const text = prompt;
      const how = pasted ? "pasted" : "typed";
      prompt = "";
      pasted = false;
      if (text.trim()) queueTurn(text, how);
    } else if (c === "\x7f" || c === "\b") prompt = prompt.slice(0, -1);
    else if (c === "\x03") prompt = ""; // Ctrl-C clears the prompt, as the CLIs' does
    else if (c >= " " || c === "\n" || c === "\t") prompt += c;
  }
}

function bye() {
  server?.kill();
  process.exit(0);
}
process.on("SIGHUP", bye);
process.on("SIGTERM", bye);
// it ends with the app that started its pane, as agentRelay.cjs does: its terminal's hangup alone hasn't always ended
// it once that app was killed
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) bye();
}, 200).unref();

log({ kind: "started", agent: kind, conv, resumed: !!resumed, cwd, args: argv });
process.stdout.write(`fake-${kind} started (${resumed ? "resumed" : "new"} conversation ${conv})\n`);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", feed);
process.stdin.on("end", bye);
hook("SessionStart", { source: resumed ? "resume" : "startup" });
if (firstPrompt) queueTurn(firstPrompt, "argv");
