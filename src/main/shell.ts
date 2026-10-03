import { execFile, execFileSync, spawn } from "child_process";

// Commands that need the user's CLIs run in the same shell setup as the panes.
// Panes start `zsh -il`, which reads ~/.zshrc — where nvm and ~/.local/bin are
// usually put on PATH. A non-interactive `zsh -l` skips ~/.zshrc, and an app
// opened from the Dock starts with only the system PATH, so neither can find
// `claude` or `codex`. Interactive rc files may print (banners, nvm notices), so
// the command's own output is fenced off from theirs.
const START = "__MOCKINGBIRD_OUT_START__";
const END = "__MOCKINGBIRD_OUT_END__";
const fenced = (cmd: string) => `printf '%s\\n' ${START}; ${cmd}; __mb=$?; printf '\\n%s\\n' ${END}; exit $__mb`;

function unfence(stdout: string): string {
  const a = stdout.indexOf(START);
  const b = stdout.lastIndexOf(END);
  if (a < 0) return stdout.trim(); // the shell died before running the command — show what it said
  return stdout.slice(a + START.length, b > a ? b : undefined).trim();
}

export interface ShellResult {
  code: number;
  out: string;
}

/** Run `cmd` in the user's interactive login shell; never rejects — callers inspect `code`. */
export function userShell(cmd: string, timeoutMs = 20_000): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-ilc", fenced(cmd)], { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      const out = unfence(String(stdout));
      resolve({ code, out: out || (err ? String(stderr).trim() || err.message : "") });
    });
  });
}

/** Absolute path of a command as the user's shell resolves it, or null when it isn't installed. */
export async function which(bin: string): Promise<string | null> {
  const r = await userShell(`command -v ${quote(bin)}`, 15_000);
  const path = r.code === 0 ? r.out.split("\n").pop()?.trim() : null; // command -v exits 1 when the name isn't found
  return path && path.startsWith("/") ? path : null;
}

/**
 * `which`, blocking — it starts a login shell, so it holds up every pane for a
 * moment. Only for the rare cold path where a caller can't wait.
 */
export function whichSync(bin: string): string | null {
  try {
    const out = unfence(
      execFileSync("/bin/zsh", ["-ilc", fenced(`command -v ${quote(bin)}`)], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
    const path = out.split("\n").pop()?.trim();
    return path && path.startsWith("/") ? path : null;
  } catch {
    return null; // command -v exits 1 when the name isn't found
  }
}

export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Like userShell, with `input` piped to stdin, a working directory, extra
 * environment, and an AbortSignal that kills the command (Stop in a room).
 */
export function userShellWithInput(
  cmd: string,
  input: string,
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-ilc", fenced(cmd)], { cwd: opts.cwd, env: opts.env ?? process.env, signal: opts.signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 600_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, out: (err as Error).name === "AbortError" ? "stopped" : err.message });
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      const out = unfence(stdout);
      if (code === 0) return resolve({ code: 0, out });
      resolve({ code: code ?? 1, out: out || stderr.trim() || (sig ? `killed (${sig})` : `exited with code ${code}`) });
    });
    child.stdin.on("error", () => {}); // the CLI may exit before reading all of stdin; close reports that
    child.stdin.end(input);
  });
}
