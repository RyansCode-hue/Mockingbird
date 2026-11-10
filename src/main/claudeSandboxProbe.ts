import { loginShell, quote, type LoginShellOptions } from "./shell";

/**
 * Proof that a Claude room launch's sandbox is on, as Claude Code itself reads the launch's settings. Its SessionStart
 * marker (RoomSandboxWatch) shows the settings file loaded, but Claude Code ignores a key it doesn't know: a renamed
 * `sandbox.enabled` loads, reports in, and runs Bash unsandboxed. So beside each launch the same binary is started
 * headless in the same folder with the same `--settings` and asked, by its stream-json control protocol, what its
 * /sandbox dialog shows (`get_sandbox_dialog`): whether the sandbox runs, and the restrictions as it enforces them,
 * the user's own settings merged in. It's asked `initialize` too, for its version. No user message is sent, so no turn
 * runs and no model is called; `--bare` reads no keychain or sign-in (and runs no hooks), so it couldn't call one.
 *
 * The launch counts as sandboxed only when that answer shows the sandbox running, nothing allowed to run outside it,
 * every path the room denies denied, nothing allowed beyond what the room allows, and the version the pane runs. Any
 * other answer, or none within SANDBOX_PROBE_MS, keeps the room's line closed for it, saying why.
 */

export const SANDBOX_PROBE_MS = 10_000;
const INIT_ID = "mockingbird-initialize";
const DIALOG_ID = "mockingbird-sandbox";

/** What the probe writes to the CLI's stdin: two control requests, and never a user message. */
export const SANDBOX_PROBE_INPUT = [
  { type: "control_request", request_id: INIT_ID, request: { subtype: "initialize" } },
  { type: "control_request", request_id: DIALOG_ID, request: { subtype: "get_sandbox_dialog" } },
]
  .map((m) => JSON.stringify(m) + "\n")
  .join("");

/**
 * The probe's arguments after the binary: headless (`-p`, stream-json both ways), `--bare` (no hooks, no keychain or
 * sign-in, no plugins), no MCP server, no saved session, and the pane's own settings sources, `--settings` and folders.
 */
export function sandboxProbeArgs(settingsJson: string, extraDirs: readonly string[] = []): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--bare",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--setting-sources",
    "user",
    "--settings",
    settingsJson,
    ...extraDirs.flatMap((d) => ["--add-dir", d]),
  ];
}

/** Credentials taken from the probe's environment after the user's shell has set it up: it has no use for any. */
const NO_CREDENTIALS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

/** The paths a room launch wrote into its sandbox: what Claude Code must deny, at least, and allow, at most. */
export interface WrittenSandbox {
  denyRead: string[];
  denyWrite: string[];
  allowWrite: string[];
  allowRead: string[];
  unixSockets: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A room launch's Claude settings' sandbox paths (claudeRoomSettings). */
export function writtenSandbox(settings: Record<string, unknown>): WrittenSandbox {
  const sandbox = (settings.sandbox ?? {}) as { filesystem?: Record<string, unknown>; network?: Record<string, unknown> };
  const fs = sandbox.filesystem ?? {};
  return {
    denyRead: strings(fs.denyRead),
    denyWrite: strings(fs.denyWrite),
    allowWrite: strings(fs.allowWrite),
    allowRead: strings(fs.allowRead),
    unixSockets: strings(sandbox.network?.allowUnixSockets),
  };
}

export interface SandboxVerdict {
  ok: boolean;
  /** Why the launch isn't in the room's sandbox, for the user; it finishes "it isn't in the room's sandbox: …". */
  why: string | null;
  /** The verdict for the log: no path beyond what the room wrote. */
  log: string;
}

const refused = (why: string, log: string): SandboxVerdict => ({ ok: false, why, log: `refused: ${log}` });

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The control responses in the CLI's stdout, by request id; lines that aren't JSON are skipped. */
function responses(out: string): { byId: Map<string, Json>; json: number } {
  const byId = new Map<string, Json>();
  let json = 0;
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let m: unknown;
    try {
      m = JSON.parse(t);
    } catch {
      continue;
    }
    json++;
    if (!isObj(m) || m.type !== "control_response" || !isObj(m.response)) continue;
    const id = m.response.request_id;
    if (typeof id === "string") byId.set(id, m.response);
  }
  return { byId, json };
}

const list = (xs: string[]) => JSON.stringify(xs);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Judges what the CLI answered (its stdout) against the pane's version and what the room wrote. */
export function judgeSandbox(out: string, expect: { version: string | null; written: WrittenSandbox }): SandboxVerdict {
  const { byId, json } = responses(out);
  if (!json) return refused("Claude Code's answer to Mockingbird's sandbox check wasn't JSON", "the answer wasn't JSON");
  const init = byId.get(INIT_ID);
  const dialog = byId.get(DIALOG_ID);
  const version = isObj(init?.response) && typeof init.response.claude_code_version === "string" ? init.response.claude_code_version : null;
  const cc = `Claude Code ${version ?? expect.version ?? ""}`.trimEnd();
  if (!dialog) return refused(`${cc} no longer reports its sandbox (it didn't answer get_sandbox_dialog)`, `${cc}: no answer to get_sandbox_dialog`);
  if (dialog.subtype !== "success" || !isObj(dialog.response)) {
    const err = typeof dialog.error === "string" ? dialog.error.slice(0, 200) : "no answer";
    return refused(`${cc} no longer reports its sandbox (get_sandbox_dialog: ${err})`, `${cc}: get_sandbox_dialog failed`);
  }
  if (!version) return refused(`Claude Code didn't say its version to Mockingbird's sandbox check, so the check can't be matched to the pane`, "no version in initialize");
  if (!expect.version) return refused(`the pane's Claude Code version isn't known, so Mockingbird's sandbox check (${cc}) can't be matched to it`, `${cc}: the pane's version unknown`);
  if (version !== expect.version)
    return refused(`the Claude Code that answered Mockingbird's sandbox check is ${version}, not ${expect.version} as the pane is (it may have just updated)`, `version ${version}, the pane ${expect.version}`);

  const d = dialog.response;
  const r = d.restrictions;
  const missing = (field: string) => refused(`${cc} no longer reports its sandbox as Mockingbird reads it (get_sandbox_dialog has no ${field})`, `${cc}: no ${field}`);
  for (const f of ["enabled", "enabled_in_settings", "unsandboxed_fallback"]) if (typeof d[f] !== "boolean") return missing(f);
  if (!isObj(d.dependencies) || !Array.isArray(d.dependencies.errors)) return missing("dependencies.errors");
  if (!Array.isArray(d.excluded_commands)) return missing("excluded_commands");
  if (!Array.isArray(d.policy_origins)) return missing("policy_origins");
  if (!isObj(r)) return missing("restrictions");
  for (const f of ["fs_deny_read", "fs_deny_write", "fs_allow_write", "fs_allow_read", "unix_sockets"]) if (!Array.isArray(r[f])) return missing(`restrictions.${f}`);
  if (typeof r.allow_all_unix_sockets !== "boolean") return missing("restrictions.allow_all_unix_sockets");

  if (!d.enabled_in_settings)
    return refused(`${cc} reads the room's settings with its sandbox off (its sandbox.enabled setting isn't one it knows, most likely)`, `${cc}: sandbox off in the settings`);
  if (!d.enabled) {
    const reason = typeof d.unavailable_reason === "string" ? ` (${d.unavailable_reason.slice(0, 200)})` : "";
    return refused(`${cc}'s sandbox didn't start${reason}`, `${cc}: the sandbox didn't start`);
  }
  if (d.unsandboxed_fallback)
    return refused(`${cc} would run a command that fails in the sandbox outside it (the room's allowUnsandboxedCommands isn't applied)`, `${cc}: unsandboxed fallback on`);
  const depErrors = strings(d.dependencies.errors);
  if (depErrors.length) return refused(`${cc}'s sandbox is missing what it needs: ${depErrors.join("; ").slice(0, 300)}`, `${cc}: ${plural(depErrors.length, "dependency error")}`);
  const origins = strings(d.policy_origins);
  if (origins.includes("remote_unknown"))
    return refused(`your organization's managed Claude Code settings couldn't be read, so what they'd change in the sandbox isn't known`, `${cc}: managed settings unknown`);

  const w = expect.written;
  const unapplied = (
    [
      ["denyRead", w.denyRead, strings(r.fs_deny_read)],
      ["denyWrite", w.denyWrite, strings(r.fs_deny_write)],
    ] as const
  )
    .map(([key, wrote, got]) => [key, wrote.filter((p) => !got.includes(p)).length] as const)
    .filter(([, n]) => n > 0);
  if (unapplied.length) {
    const said = unapplied.map(([key, n]) => `${n} of its ${key} paths`).join(" and ");
    return refused(`${cc} doesn't apply the room's sandbox as written: ${said} aren't denied (a setting it reads under another name now, most likely)`, `${cc}: ${said} unapplied`);
  }

  // what the user's own settings (or an organization's) add to every sandbox, which a room pane can't run under
  const excluded = strings(d.excluded_commands);
  const sockets = strings(r.unix_sockets).filter((s) => !w.unixSockets.includes(s));
  const writes = strings(r.fs_allow_write).filter((p) => !w.allowWrite.includes(p));
  const reads = strings(r.fs_allow_read).filter((p) => !w.allowRead.includes(p));
  const extras = [
    excluded.length ? `excludedCommands ${list(excluded)} (they run outside the sandbox)` : null,
    r.allow_all_unix_sockets ? "network.allowAllUnixSockets (a Docker daemon's socket would reach every folder)" : null,
    sockets.length ? `network.allowUnixSockets ${list(sockets)}` : null,
    writes.length ? `filesystem.allowWrite ${list(writes)}` : null,
    reads.length ? `filesystem.allowRead ${list(reads)}` : null,
  ].filter((x): x is string => !!x);
  if (extras.length) {
    const where = origins.length ? "your ~/.claude/settings.json (or your organization's managed settings)" : "your ~/.claude/settings.json";
    const counts = [
      excluded.length && plural(excluded.length, "excluded command"),
      r.allow_all_unix_sockets && "every unix socket",
      sockets.length && plural(sockets.length, "unix socket"),
      writes.length && plural(writes.length, "allowWrite path"),
      reads.length && plural(reads.length, "allowRead path"),
    ].filter(Boolean);
    return refused(
      `${where} sandbox has ${extras.join(", ")}, which room panes can't run under. Move them to the settings of the projects that need them (.claude/settings.local.json there), which room panes don't read. Your panes outside rooms aren't affected`,
      `${cc}: the user's settings add ${counts.join(", ")}`
    );
  }
  return {
    ok: true,
    why: null,
    log: `ok: ${cc}, sandbox on, ${w.denyRead.length} denyRead, ${w.denyWrite.length} denyWrite, ${w.allowWrite.length} allowWrite, ${w.allowRead.length} allowRead as the room wrote them`,
  };
}

export interface SandboxProbe {
  /** The binary the pane runs. */
  bin: string;
  /** The pane's `--settings` value, as passed. */
  settingsJson: string;
  extraDirs: readonly string[];
  cwd: string;
  /** The version the pane runs. */
  version: string | null;
  written: WrittenSandbox;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Runs the probe in the user's login shell, as the pane's shell runs Claude Code, and judges its answer. Never rejects. */
export async function probeRoomSandbox(p: SandboxProbe, run: (cmd: string, o: LoginShellOptions) => ReturnType<typeof loginShell> = loginShell): Promise<SandboxVerdict> {
  const ms = p.timeoutMs ?? SANDBOX_PROBE_MS;
  const cmd = ["/usr/bin/env", ...NO_CREDENTIALS.flatMap((v) => ["-u", v]), p.bin, ...sandboxProbeArgs(p.settingsJson, p.extraDirs)].map(quote).join(" ");
  let res: Awaited<ReturnType<typeof loginShell>>;
  try {
    res = await run(cmd, { cwd: p.cwd, input: SANDBOX_PROBE_INPUT, timeoutMs: ms, ...(p.env ? { env: p.env } : {}) });
  } catch (err) {
    return refused(`Mockingbird's check of its sandbox couldn't run (${(err as Error).message})`, `couldn't run: ${(err as Error).message}`);
  }
  if (res.code !== 0) {
    const why = (res.stderr.trim() || res.out).split("\n").slice(-3).join(" ").slice(0, 300) || `exited with code ${res.code}`;
    // an answer it gave before it failed still counts: a timeout is the only failure with none
    const v = judgeSandbox(res.out, p);
    if (v.ok) return v;
    if (/timed out after/.test(res.out)) return refused(`Mockingbird's check of its sandbox got no answer from Claude Code within ${plural(Math.max(1, Math.round(ms / 1000)), "second")}`, "timed out");
    if (responses(res.out).json === 0) return refused(`Mockingbird's check of its sandbox failed: Claude Code ${why}`, `exited ${res.code}`);
    return v;
  }
  return judgeSandbox(res.out, p);
}
