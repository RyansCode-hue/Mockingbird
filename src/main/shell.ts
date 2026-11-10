import { execFile, execFileSync, spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "child_process";

// Commands that need the user's CLIs run in the same shell setup as the panes.
// Panes start `zsh -il`, which reads ~/.zshrc — where nvm and ~/.local/bin are
// usually put on PATH. A non-interactive `zsh -l` skips ~/.zshrc, and an app
// opened from the Dock starts with only the system PATH, so neither can find
// `claude` or `codex`. Interactive rc files may print (banners, nvm notices), so
// the command's own output is fenced off from theirs.
const START = "__MOCKINGBIRD_OUT_START__";
const END = "__MOCKINGBIRD_OUT_END__";
const fenced = (cmd: string) => `printf '%s\\n' ${START}; ${cmd}; __mb=$?; printf '\\n%s\\n' ${END}; exit $__mb`;

/** The command's own output, without what the rc files printed around it. */
function unfence(stdout: string): string {
  const a = stdout.indexOf(START);
  const b = stdout.lastIndexOf(END);
  if (a < 0) return stdout.trim(); // the shell died before running the command — show what it said
  return stdout.slice(a + START.length, b > a ? b : undefined).trim();
}

/** Output as it streams (for a log): everything the shell printed, without the fence markers. */
const unmarked = (chunk: string) => chunk.split(START).join("").split(END).join("");

/** The last line of `command -v` output when it's an absolute path; anything else means not found. */
function pathFrom(out: string): string | null {
  const p = out.split("\n").pop()?.trim();
  return p && p.startsWith("/") ? p : null;
}

export interface ShellResult {
  code: number;
  out: string;
}

/** How long a stopped command gets to exit on SIGTERM before its process group is killed. */
const STOP_GRACE_MS = 2000;

// A stopped command's shell leads its own process group, and everything the
// command started is in it. The whole group is signalled: an interactive zsh
// ignores SIGTERM, and stopping the shell alone would leave its command
// running. kill(-pgid) by itself can miss members on macOS, so each member
// `ps` lists is signalled as well.
const PS = ["/bin/ps", ["-axo", "pid=,pgid="]] as const;

const send = (target: number, sig: NodeJS.Signals) => {
  try {
    process.kill(target, sig);
  } catch {
    /* already exited */
  }
};

/** Signal group `pgid` and each of its members in `ps` output (`pid pgid` lines). */
function signalMembers(pgid: number, sig: NodeJS.Signals, ps: string): void {
  send(-pgid, sig);
  for (const line of ps.split("\n")) {
    const [pid, group] = line.trim().split(/\s+/).map(Number);
    if (group === pgid && pid > 0) send(pid, sig);
  }
}

function signalGroup(pgid: number | undefined, sig: NodeJS.Signals): void {
  if (!pgid) return;
  send(-pgid, sig); // most of it at once, before the command can start anything new
  execFile(PS[0], PS[1], { encoding: "utf8" }, (err, out) => {
    if (err) console.warn(`[shell] couldn't list process group ${pgid} to ${sig} it: ${err.message}`);
    signalMembers(pgid, sig, err ? "" : out);
  });
}

function signalGroupSync(pgid: number | undefined, sig: NodeJS.Signals): void {
  if (!pgid) return;
  let out = "";
  try {
    out = execFileSync(PS[0], PS[1], { encoding: "utf8" });
  } catch (err) {
    console.warn(`[shell] couldn't list process group ${pgid} to ${sig} it: ${(err as Error).message}`);
  }
  signalMembers(pgid, sig, out);
}

export interface LoginShellOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the command's stdin, which is then closed. */
  input?: string;
  /** Stop the command after this long; none when omitted. */
  timeoutMs?: number;
  /** Stops the command when aborted. */
  signal?: AbortSignal;
  /** Each chunk of stdout and stderr as it arrives, rc-file output included. */
  onOut?: (chunk: string) => void;
  /** The shell's pid, as soon as it's spawned. */
  onSpawn?: (pid: number) => void;
}

/**
 * Run `cmd` in the user's interactive login shell; never rejects — callers
 * inspect `code`. `out` is the command's own stdout (or, when it failed, its
 * stderr, or why it stopped). The shell leads its own process group, so a
 * timeout or abort stops the command and everything it started: SIGTERM to the
 * group, then SIGKILL for whatever is still running after a grace period.
 */
export function loginShell(cmd: string, opts: LoginShellOptions = {}): Promise<ShellResult & { stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-ilc", fenced(cmd)], { cwd: opts.cwd, env: opts.env ?? process.env, detached: true });
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
    let stdout = "";
    let stderr = "";
    let stopped: string | null = null;
    const stop = (why: string) => {
      if (stopped || child.exitCode !== null || child.signalCode !== null) return;
      stopped = why;
      signalGroup(child.pid, "SIGTERM");
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS).unref();
    };
    const timer = opts.timeoutMs ? setTimeout(() => stop(`timed out after ${Math.round(opts.timeoutMs! / 1000)}s`), opts.timeoutMs) : undefined;
    const onAbort = () => stop("stopped");
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (r: ShellResult & { stderr: string }) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      opts.onOut?.(unmarked(s));
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderr += s;
      opts.onOut?.(s);
    });
    child.on("error", (err) => finish({ code: 1, out: err.message, stderr }));
    child.on("close", (code, sig) => {
      const out = unfence(stdout);
      if (stopped) return finish({ code: code || 1, out: [out || stderr.trim(), stopped].filter(Boolean).join("\n"), stderr });
      if (code === 0) return finish({ code: 0, out, stderr });
      finish({ code: code ?? 1, out: out || stderr.trim() || (sig ? `killed (${sig})` : `exited with code ${code}`), stderr });
    });
    child.stdin.on("error", () => {}); // the command may exit before reading all of stdin; close reports that
    child.stdin.end(opts.input ?? "");
  });
}

/** Run `cmd` in the user's interactive login shell; never rejects — callers inspect `code`. */
export async function userShell(cmd: string, timeoutMs = 20_000): Promise<ShellResult> {
  const { code, out } = await loginShell(cmd, { timeoutMs });
  return { code, out };
}

/** Absolute path of a command as the user's shell resolves it, or null when it isn't installed. */
export async function which(bin: string): Promise<string | null> {
  const r = await userShell(`command -v ${quote(bin)}`, 15_000);
  return r.code === 0 ? pathFrom(r.out) : null; // command -v exits 1 when the name isn't found
}

/**
 * `which`, blocking — it starts a login shell, so it holds up every pane for a
 * moment. Only for the rare cold path where a caller can't wait. On a timeout
 * the shell is killed outright (it would ignore SIGTERM), and so is whatever
 * its rc files started.
 */
export function whichSync(bin: string, timeoutMs = 15_000): string | null {
  // spawnSync honours `detached` like spawn does (the shell leads its own
  // process group), though Node's types leave it out
  const opts: SpawnSyncOptionsWithStringEncoding & { detached: boolean } = {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  };
  const r = spawnSync("/bin/zsh", ["-ilc", fenced(`command -v ${quote(bin)}`)], opts);
  if (r.signal) signalGroupSync(r.pid, "SIGKILL");
  return r.status === 0 ? pathFrom(unfence(r.stdout ?? "")) : null; // command -v exits 1 when the name isn't found
}

export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Like userShell, with `input` piped to stdin, a working directory, extra
 * environment, and an AbortSignal that stops the command (Stop in a room).
 */
export async function userShellWithInput(
  cmd: string,
  input: string,
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; onSpawn?: (pid: number) => void } = {}
): Promise<ShellResult> {
  const { code, out } = await loginShell(cmd, { ...opts, input, timeoutMs: opts.timeoutMs ?? 600_000 });
  return { code, out };
}
