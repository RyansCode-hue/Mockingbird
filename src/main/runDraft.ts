import * as path from "path";
import { git } from "./git";
import { quote } from "./shell";
import { parseClaudeJson, type ShellRunner } from "./headless";
import { agentLabel, isInstalledBin } from "./agents";
import { validateProfile } from "./runProfile";
import type { RunProfile } from "../shared/types";
import { SECRET_READS } from "./secrets";

const TIMEOUT_MS = 6 * 60_000;
// gitignored files worth carrying into a worktree: env files, local certs, local settings
const CARRY = /(^|\/)(\.env(\.[\w-]+)?|[\w.-]+\.env|local\.settings\.json|\.certs|[\w.-]+\.(pem|key|crt|p12|pfx))(\/|$)/;

/** Gitignored files and folders in the main checkout that a worktree would lack, e.g. backend/.env. */
export async function ignoredCandidates(repo: string): Promise<string[]> {
  const out = await git(repo, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { trim: false });
  return out
    .split("\0")
    .filter(Boolean)
    .map((p) => p.replace(/\/$/, ""))
    .filter((p) => CARRY.test(p) && !/(^|\/)node_modules\//.test(p))
    .slice(0, 60);
}

const SCHEMA = `interface RunProfile {
  services: {
    name: string;                 // a word: api, web, worker…
    kind?: "process" | "compose"; // default "process"
    cwd: string;                  // relative to the repository root
    command: string;              // a zsh command; use \${port:<name>} wherever a port goes
    env?: Record<string, string>; // may use \${port:<name>}, \${slot}, \${worktree}
    envFiles?: string[];          // KEY=VALUE files, relative to the root, loaded into the environment
    ports?: { name: string; base: number; url?: string }[]; // base = the standard port; url like "https://localhost:\${port}"
    dependsOn?: string[];
    ready?: { port?: string; log?: string }; // a port name to wait for, or a regex for a log line
    compose?: { file: string; services?: string[] }; // for kind "compose": the compose file (relative to cwd)
    // only when the debugger can't be worked out from the command (see below):
    debug?:
      | { type: "python"; module?: string; program?: string; args?: string[]; python?: string }
      | { type: "node"; program?: string; runtimeExecutable?: string; runtimeArgs?: string[]; args?: string[] }
      | { type: "chrome"; url: string; webRoot?: string }
      | { type: "dotnet"; program: string; args?: string[]; browser?: { url: string; blazor?: boolean } } // program: the .csproj (or a built .dll)
      | { type: "python-attach"; port: string; pathMappings?: { localRoot: string; remoteRoot: string }[]; container?: string };
  }[];
  prepare?: {
    copy?: string[];              // gitignored files/globs to copy from the main checkout into a new worktree
    commands?: { cwd: string; command: string; ifMissing: string }[]; // e.g. npm ci when node_modules is missing
  };
  sideBySide?: { slots: number; step: number }; // default { slots: 3, step: 10 }
  blockers?: { what: string; fix: string }[];   // what stops two copies running at once, with the exact code change
  notes?: string[];                              // e.g. sign-in redirect URIs to register for slots 1–3
}`;

function draftPrompt(repo: string, candidates: string[]): string {
  return [
    `Work out how to run the application in this repository (${path.basename(repo)}) locally, and describe it as JSON matching this TypeScript type:`,
    "",
    SCHEMA,
    "",
    "How Mockingbird uses it:",
    "- Each service runs in its own terminal from a git worktree of this repository (not always the main checkout), via an interactive login zsh, so the user's PATH, nvm, pyenv and dotnet are available. Commands must not depend on VS Code.",
    "- Ports: every port a service listens on is declared with its standard number as base. Several worktrees can run side by side: slot N adds N × step to every port. So every place a port appears — command flags, env vars like ASPNETCORE_URLS / PORT / FRONTEND_URL / API URLs — must use ${port:<name>}, never a literal number. Prefer flags and env vars the app already honours (e.g. `dotnet run --no-launch-profile` with ASPNETCORE_URLS, `uvicorn --port`, `vite --port ${port:web} --strictPort`).",
    "- Never write commands that kill other processes by port or name (no `lsof … | kill`, `pkill`); Mockingbird stops what it starts.",
    "- Python: call the virtualenv's executables (e.g. `.venv/bin/uvicorn`), and add a prepare command that creates the venv and installs requirements when `.venv` is missing. Node: add `npm ci` (or the lockfile's tool) when `node_modules` is missing.",
    "- Docker Compose stacks: use kind \"compose\" with the compose file; Mockingbird adds an override that renames containers, shifts published ports and points absolute bind mounts and env_files at the worktree, so do not work around those yourself. Declare each published host port as a port of that service.",
    "- Look at .vscode/launch.json and tasks.json, Properties/launchSettings.json, package.json scripts, compose files, Makefiles, bin/ scripts and the README to find the real commands.",
    candidates.length
      ? `- These gitignored files exist in the main checkout and a new worktree won't have them; put the ones the app needs in prepare.copy: ${candidates.join(", ")}`
      : "- No gitignored env or cert files were found in the main checkout.",
    "- blockers: list anything that still stops two copies running at once even with shifted ports — e.g. a dev-server proxy hardcoded to localhost:8000, a strictPort, a fixed cookie domain — each with the exact one-line code change that would fix it (file and new code).",
    "- notes: list the browser origins sign-in must allow (MSAL/OIDC redirect URIs, CORS origins) for slots 0–3 if the app signs in through Entra or B2C.",
    "",
    "- Debugging: Mockingbird reads `.venv/bin/uvicorn …`, `python -m …`, `node …`, npm scripts, Vite/Next dev servers (debugged in the browser) and `dotnet run --project …` (a Blazor WebAssembly host also opens the browser) by itself — add `debug` only for anything else. For Python inside a Docker container, give the service a port named `debug` (base 5678, or the next free number) and `debug: { type: \"python-attach\", port: \"debug\", container: <compose service>, pathMappings: [{ localRoot, remoteRoot }] }`; Mockingbird mounts debugpy into that container at $MOCKINGBIRD_DEBUGPY and publishes the port, and add a blocker saying the container's start command must run `PYTHONPATH=$MOCKINGBIRD_DEBUGPY python -m debugpy --listen 0.0.0.0:5678 …` when MOCKINGBIRD_DEBUGPY is set (with the exact change to the start script).",
    "- Never open env files, keys or certificates (.env*, *.env, *.pem, *.key, local.settings.json, user secrets) — refer to env files through envFiles and prepare.copy, and never put a secret value in the JSON.",
    "Read files with your tools; don't run anything. Reply with only the JSON object, no prose and no code fences.",
  ].join("\n");
}

/** The JSON object in a reply: the whole reply, a fenced block, or the outermost braces. */
function extractJson(text: string): unknown {
  const t = text.trim();
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(t);
  const body = fence ? fence[1] : t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1);
  if (!body) throw new Error("The reply had no JSON in it");
  return JSON.parse(body);
}

/**
 * Draft a repository's run setup with Claude, reading the repo with its
 * read-only tools (Read, Grep, Glob) from the main checkout; nothing runs and
 * nothing is saved as a conversation. The reply is validated; a draft that
 * doesn't validate comes back with the reason and the raw JSON to fix by hand.
 */
export async function draftProfile(
  repo: string,
  bin: string,
  run: ShellRunner,
  env: Record<string, string>
): Promise<{ profile: RunProfile; raw: string } | { error: string; raw: string }> {
  if (!isInstalledBin(bin)) throw new Error(`${agentLabel("claude")} isn't installed — drafting a run setup needs it`);
  const prompt = draftPrompt(repo, await ignoredCandidates(repo));
  const cmd = [
    quote(bin), "-p", "--model", "sonnet", "--output-format", "json",
    "--tools", "Read", "Grep", "Glob", "--allowedTools", "Read", "Grep", "Glob",
    // secrets stay unread: the draft names env files, it never needs their values
    "--disallowedTools", ...SECRET_READS.map((r) => quote(r)),
    "--strict-mcp-config", "--no-session-persistence",
  ].join(" ");
  const r = await run(cmd, prompt, { cwd: repo, env: { ...env, MOCKINGBIRD_SESSION: `run-draft-${Date.now()}` }, timeoutMs: TIMEOUT_MS });
  const raw = parseClaudeJson(r).text;
  try {
    return { profile: validateProfile(extractJson(raw), repo), raw };
  } catch (err) {
    return { error: (err as Error).message, raw };
  }
}
