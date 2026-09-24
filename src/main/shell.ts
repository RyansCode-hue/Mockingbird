import { execFile, execFileSync } from "child_process";

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
