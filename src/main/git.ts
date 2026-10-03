import { execFile } from "child_process";

const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000; // fetch / push / pull over a slow VPN
const NETWORK = new Set(["fetch", "push", "pull"]);

/**
 * git, off the main thread. This process also carries every pane's keystrokes,
 * so a slow repo or remote must never block it. No terminal prompts: a remote
 * that wants a password fails instead of hanging. `okCodes` are exit codes that
 * aren't failures (`diff --no-index` exits 1 when it found differences).
 */
export function git(cwd: string, args: string[], opts: { okCodes?: number[]; trim?: boolean } = {}): Promise<string> {
  const timeout = NETWORK.has(args[0]) ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
  const ok = opts.okCodes ?? [0];
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        const code = err ? (err as any).code : 0;
        if (!err || (typeof code === "number" && ok.includes(code))) return resolve(opts.trim === false ? stdout : stdout.trim());
        const why = err.killed ? `timed out after ${timeout / 1000}s` : (stderr || err.message).trim();
        reject(new Error(`git ${args[0]}: ${why}`));
      }
    )
  );
}
