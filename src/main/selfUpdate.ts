import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { UPDATE_STEPS, type UpdateOutcome, type UpdateProgress, type UpdateStepId } from "../shared/types";
import { isNewer } from "./updates";
import { isRepo, originUrl, parseRemote } from "./git";
import { indexRepos } from "./repos";
import { loginShell, quote } from "./shell";

/**
 * Updating a build-it-yourself install from inside the app: pull the user's
 * clone, build the new app while this one keeps running, then hand over to a
 * detached installer that swaps the bundle once the app has quit and reopens it.
 */

const LOG_LINES = 400;
const MIN_NODE = 22;

/** Is this git remote URL (https or ssh) the GitHub repository owner/repo? */
export function remoteMatches(url: string, owner: string, repo: string): boolean {
  const r = parseRemote(url);
  return r?.provider === "github" && r.owner.toLowerCase() === owner.toLowerCase() && r.repo.toLowerCase() === repo.toLowerCase();
}

/**
 * The folder's origin URL, or null when it isn't a repository or has no
 * origin. Anything else — git missing, a timeout — is an error, not an answer
 * about the folder.
 */
async function originOf(dir: string): Promise<string | null> {
  return (await isRepo(dir)) ? originUrl(dir) : null;
}

/**
 * The user's clone of Mockingbird: the folder set in Settings (which must be
 * one), otherwise the first repository under the repo folders whose origin is
 * the update repository. Null when there's none.
 */
export async function findSourceClone(opts: { configured?: string | null; roots: string[]; owner: string; repo: string }): Promise<string | null> {
  if (opts.configured) {
    const url = await originOf(opts.configured);
    if (url && remoteMatches(url, opts.owner, opts.repo)) return opts.configured;
    throw new Error(`${opts.configured} isn't a clone of ${opts.owner}/${opts.repo} — pick the folder you cloned Mockingbird into.`);
  }
  for (const r of indexRepos(opts.roots)) {
    const url = await originOf(r.path);
    if (url && remoteMatches(url, opts.owner, opts.repo)) return r.path;
  }
  return null;
}

/** Runs one shell command for a step, streaming its output; never rejects. */
export type Exec = (cmd: string, cwd: string, onOut: (chunk: string) => void, signal: AbortSignal) => Promise<{ code: number; out: string }>;

/**
 * The user's interactive login shell, so nvm's Node and Homebrew's tools are on
 * PATH as in their terminal. Everything it prints streams to the log; the
 * output a step parses is the command's own, without the rc files' banners.
 */
export function loginShellExec(env: NodeJS.ProcessEnv): Exec {
  return async (cmd, cwd, onOut, signal) => {
    const r = await loginShell(cmd, { cwd, env, onOut, signal });
    // a failed step is explained by its last lines, which are often on stderr
    const errs = r.stderr.trim();
    return { code: r.code, out: r.code === 0 || !errs || r.out.startsWith(errs) ? r.out : `${r.out}\n${errs}` };
  };
}

class StepFailed extends Error {}

export class UpdateRunner {
  progress: UpdateProgress = { state: "idle", done: [], log: [] };
  private ac: AbortController | null = null;

  constructor(
    private deps: {
      exec: Exec;
      currentVersion: string;
      findClone: () => Promise<string | null>;
      onProgress: (p: UpdateProgress) => void;
    }
  ) {}

  private set(patch: Partial<UpdateProgress>): void {
    this.progress = { ...this.progress, ...patch };
    this.deps.onProgress(this.progress);
  }

  private log(text: string): void {
    const lines = [...this.progress.log, ...text.replace(/\r/g, "\n").split("\n").filter((l) => l.trim())];
    this.set({ log: lines.slice(-LOG_LINES) });
  }

  /** Run a step's command; a non-zero exit fails the step with `why` (or the command's last output). */
  private async run(cmd: string, cwd: string, why?: (out: string) => string): Promise<string> {
    this.log(`$ ${cmd}`);
    const r = await this.deps.exec(cmd, cwd, (s) => this.log(s), this.ac!.signal);
    if (this.ac!.signal.aborted) throw new StepFailed("Cancelled — nothing was installed.");
    if (r.code !== 0) throw new StepFailed(why ? why(r.out) : lastLines(r.out) || `${cmd} exited with code ${r.code}`);
    return r.out.trim();
  }

  private step(id: UpdateStepId): void {
    this.set({ step: id });
    this.log(`▸ ${UPDATE_STEPS.find((s) => s.id === id)!.label}`);
  }

  /** Pull and build. The running app is untouched; on success the update waits for "Restart to update". */
  async prepare(): Promise<UpdateProgress> {
    if (this.progress.state === "preparing" || this.progress.state === "installing") return this.progress;
    this.ac = new AbortController();
    this.set({ state: "preparing", done: [], log: [], error: undefined, step: undefined, version: undefined, appPath: undefined });
    const done = (id: UpdateStepId) => this.set({ done: [...this.progress.done, id] });
    try {
      this.step("check");
      const clone = await this.deps.findClone();
      if (!clone) {
        throw new StepFailed("No clone of Mockingbird was found under your repo folders. Clone it (SETUP.md, option B) or choose its folder in Settings → About.");
      }
      this.set({ clone });
      this.log(`clone: ${clone}`);
      const dirty = await this.run("git status --porcelain --untracked-files=no", clone);
      if (dirty) throw new StepFailed(`Your clone has uncommitted changes (${dirty.split("\n").length} file(s)). Commit or stash them, then update again.`);
      const branch = await this.run("git rev-parse --abbrev-ref HEAD", clone);
      const head = await this.run("git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main", clone);
      const main = head.split("\n").pop()!.replace(/^origin\//, "");
      if (branch !== main) throw new StepFailed(`Your clone is on the branch "${branch}". Switch it to ${main}, then update again.`);
      done("check");

      this.step("node");
      const v = await this.run("node -v", clone, () => `Node isn't installed. Building needs Node ${MIN_NODE} — install it (nodejs.org, or nvm install ${MIN_NODE}).`);
      const major = parseInt(/v(\d+)/.exec(v)?.[1] ?? "0", 10);
      if (major < MIN_NODE) throw new StepFailed(`Building needs Node ${MIN_NODE}; your shell has ${v.split("\n").pop()}. Install it (nvm install ${MIN_NODE}) and make it the default.`);
      done("node");

      this.step("pull");
      await this.run(`git fetch origin ${quote(main)}`, clone, (out) => `Couldn't fetch from GitHub: ${lastLines(out)}`);
      await this.run(
        `git merge --ff-only origin/${quote(main)}`,
        clone,
        () => `Your clone has commits GitHub's ${main} doesn't, so it can't simply move forward. Push or reset them, then update again.`
      );
      done("pull");

      this.step("install");
      // exactly what package-lock.json pins, leaving it untouched: an `npm install`
      // that rewrote it would make the next update find uncommitted changes
      await this.run("npm ci", clone);
      done("install");

      this.step("build");
      // the app alone: the DMG and zip only matter for sending a build to someone.
      // The pull came first, so this is the new version's own build script.
      await this.run("npm run package:app", clone);
      done("build");

      this.step("verify");
      const appPath = newestBuild(clone);
      if (!appPath) throw new StepFailed("The build finished but no Mockingbird.app turned up under release/.");
      const version = await this.run(`plutil -extract CFBundleShortVersionString raw ${quote(path.join(appPath, "Contents", "Info.plist"))}`, clone);
      if (!isNewer(this.deps.currentVersion, version)) {
        throw new StepFailed(`The build is version ${version} and you're running ${this.deps.currentVersion} — there's nothing newer to install.`);
      }
      done("verify");
      this.log(`ready: ${version} at ${appPath}`);
      this.set({ state: "ready", step: undefined, version, appPath });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log(`✕ ${error}`);
      this.set({ state: "failed", error });
    } finally {
      this.ac = null;
    }
    return this.progress;
  }

  cancel(): void {
    this.ac?.abort();
  }

  /** Restarting into the build: the app is quitting, and the installer takes over once it has. */
  markInstalling(): void {
    this.set({ state: "installing" });
  }

  /** The quit was cancelled before the installer started: the build is still ready to install. */
  installAborted(): void {
    if (this.progress.state === "installing") this.set({ state: "ready" });
  }
}

function lastLines(out: string, n = 6): string {
  return out.trim().split("\n").slice(-n).join("\n");
}

/** The most recently built Mockingbird.app under the clone's release/ (mac-arm64, mac, mac-universal…). */
export function newestBuild(clone: string): string | null {
  const release = path.join(clone, "release");
  let best: { p: string; t: number } | null = null;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(release).filter((d) => d.startsWith("mac"));
  } catch {
    return null; // nothing built yet
  }
  for (const d of dirs) {
    const p = path.join(release, d, "Mockingbird.app");
    try {
      const t = fs.statSync(p).mtimeMs;
      if (!best || t > best.t) best = { p, t };
    } catch {
      /* no app in this output folder */
    }
  }
  return best?.p ?? null;
}

/** The detached installer. $MB_OPEN stands in for `open` in tests. */
const INSTALLER = `#!/bin/bash
# Mockingbird's installer, started by the app just before it quits for an update.
# Waits for the old app to exit, swaps the new bundle in (putting the old one back
# if anything fails), records the result for the next launch, and reopens the app.
PID="$1"; NEW="$2"; TARGET="$3"; RESULT="$4"
OPEN="\${MB_OPEN:-/usr/bin/open}"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
finish() { echo "$1" > "$RESULT"; say "$1"; "$OPEN" "$TARGET"; exit 0; }

say "waiting for Mockingbird ($PID) to quit"
for _ in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then
  echo "failed: Mockingbird didn't quit within a minute, so nothing was replaced." > "$RESULT"
  say "gave up waiting"
  exit 1
fi
[ -x "$NEW/Contents/MacOS/Mockingbird" ] || finish "failed: the new build is missing at $NEW, so nothing was replaced."
BACKUP="\${TARGET%.app}.previous.app"
rm -rf "$BACKUP"
mv "$TARGET" "$BACKUP" || finish "failed: couldn't move $TARGET aside (permissions?), so nothing was replaced."
if ditto "$NEW" "$TARGET" && [ -x "$TARGET/Contents/MacOS/Mockingbird" ]; then
  rm -rf "$BACKUP"
  finish "ok"
fi
rm -rf "$TARGET"
mv "$BACKUP" "$TARGET"
finish "failed: copying the new build into $TARGET failed, so the previous version was put back."
`;

const PENDING = "update-pending.json";
const RESULT = "update-result.txt";
const LOG = "update.log";

/**
 * Hand over to the installer: record what's being installed (and which sessions
 * to bring back), then start the installer detached with a clean environment —
 * it outlives this process, and the relaunched app mustn't inherit our env.
 */
export function startInstaller(opts: { mbDir: string; pid: number; builtApp: string; targetApp: string; from: string; to: string; sessions: string[]; open?: string }): void {
  if (!opts.targetApp.endsWith(".app")) throw new Error(`This copy of Mockingbird isn't an installed app (${opts.targetApp}), so it can't replace itself.`);
  fs.mkdirSync(opts.mbDir, { recursive: true });
  const script = path.join(opts.mbDir, "update.sh");
  fs.writeFileSync(script, INSTALLER, { mode: 0o755 });
  fs.rmSync(path.join(opts.mbDir, RESULT), { force: true });
  fs.writeFileSync(path.join(opts.mbDir, PENDING), JSON.stringify({ from: opts.from, to: opts.to, sessions: opts.sessions, at: Date.now() }));
  const log = fs.openSync(path.join(opts.mbDir, LOG), "a");
  const child = spawn("/bin/bash", [script, String(opts.pid), opts.builtApp, opts.targetApp, path.join(opts.mbDir, RESULT)], {
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      HOME: process.env.HOME ?? "",
      USER: process.env.USER ?? "",
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ...(opts.open ? { MB_OPEN: opts.open } : {}),
    },
  });
  child.unref();
  fs.closeSync(log);
}

/**
 * What happened to the update this launch follows, if any — read once at
 * startup, then cleared. The sessions that were open come back either way:
 * the app restarted whether or not the new version went in.
 */
export function takeUpdateOutcome(mbDir: string, currentVersion: string, now = Date.now()): UpdateOutcome | null {
  const pendingFile = path.join(mbDir, PENDING);
  const logPath = path.join(mbDir, LOG);
  const forget = () => {
    fs.rmSync(pendingFile, { force: true });
    fs.rmSync(path.join(mbDir, RESULT), { force: true });
  };
  let pending: { from: string; to: string; sessions: string[]; at: number };
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // no update in flight
    // said once, then cleared — not re-read at every launch
    forget();
    return { ok: false, from: "", to: "", sessions: [], logPath, message: `An update was under way, but its record (${PENDING}) couldn't be read: ${(err as Error).message}. See ${logPath}.` };
  }
  let result = "";
  try {
    result = fs.readFileSync(path.join(mbDir, RESULT), "utf8").trim();
  } catch {
    /* the installer never finished — reported below */
  }
  forget();
  if (now - pending.at > 24 * 3_600_000) return null; // a stale marker from an update long gone
  const base = { from: pending.from, to: pending.to, sessions: pending.sessions ?? [], logPath };
  if (result === "ok" && currentVersion === pending.to) return { ...base, ok: true, message: `Updated to ${pending.to}.` };
  if (result === "ok") return { ...base, ok: false, message: `The installer finished, but this is still ${currentVersion} (expected ${pending.to}).` };
  if (result.startsWith("failed: ")) return { ...base, ok: false, message: `Update to ${pending.to} failed: ${result.slice(8)}` };
  return { ...base, ok: false, message: `The update to ${pending.to} didn't finish — see ${logPath}.` };
}
