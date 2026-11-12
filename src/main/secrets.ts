import * as fs from "fs";
import * as path from "path";
import { expandHome } from "./store";
import { isMissing } from "./fileOps";
import { HOUSE_CONFIG_DIR } from "../shared/team/house";

/**
 * Secret files by name, at any depth: env files, keys and certificates, and
 * the usual credential, PAT and local-settings files. The one list every
 * secret guard is built from: Claude's deny-read rules (SECRET_READS,
 * roomSecretReads), Codex's room sandbox (codexRoomSandbox.ts), what a
 * room backup leaves out (secretPathspecs) and the room artifacts agents
 * may not read (isSecretFileName).
 */
export const SECRET_FILE_GLOBS: readonly string[] = [
  ".env",
  ".env.*",
  "*.env",
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p12",
  "*.pat",
  "*_pat.txt",
  "*-pat.txt",
  "pat.txt",
  "credentials.json",
  "secrets.json",
  "local.settings.json",
];

const SECRET_NAME_RES = SECRET_FILE_GLOBS.map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")}$`, "i"));

/**
 * Whether a file's name (its last path segment; any case) is one of
 * SECRET_FILE_GLOBS: what room artifacts keep from agents and ask about
 * before adding.
 */
export function isSecretFileName(name: string): boolean {
  const base = name.trim().split(/[/\\]/).pop() ?? "";
  return !!base && SECRET_NAME_RES.some((re) => re.test(base));
}

/**
 * SECRET_FILE_GLOBS as Claude permission rules (--disallowedTools), relative
 * to the session's folder. The run-setup drafter names env files without
 * reading them; team room sessions run with these denied.
 */
export const SECRET_READS = SECRET_FILE_GLOBS.map((g) => `Read(**/${g})`);

/**
 * Credentials outside any repository, this install's own team keys and invite tokens, and each running launch's MCP
 * token. A room session's sandbox denies these to the agent's commands: Codex's from CODEX_ROOM_GUARD_SINCE
 * (codexRoomSandbox.ts), Claude's always (claudeRoomSandbox.ts); Claude's deny rules (roomSecretReads) cover its file
 * tools. Neither covers the MCP servers the agents start, which read their own token here.
 */
export const HOME_SECRETS = ["~/.ssh/**", "~/.aws/**", "~/.config/gh/**", "~/.netrc", "~/.git-credentials", "~/.mockingbird/team/**", "~/.mockingbird/mcp-tokens/**"];

/**
 * What runs inside every pane's process tree, or in Mockingbird's own processes: Mockingbird's hook, status line and
 * MCP scripts, the login shell's start-up files (a pane is `zsh -ilc`), the CLIs' own settings, hooks and MCP config,
 * git's config (core.fsmonitor, hooksPath, aliases) and ssh's, and launchd's agents. Whatever writes one of these acts as
 * every pane, so a room session's agent may write none of them: its sandbox denies them to its commands, and its deny
 * rules to its file tools (claudeRoomSandbox.ts). The git folder's own config and hooks are added per repository.
 */
export const HOME_RUNS_CODE = [
  "~/.mockingbird/**",
  "~/.zshenv",
  "~/.zshrc",
  "~/.zprofile",
  "~/.zlogin",
  "~/.bashrc",
  "~/.bash_profile",
  "~/.profile",
  "~/.claude/**",
  "~/.codex/**",
  "~/.gitconfig",
  "~/.config/git/**",
  "~/.ssh/**",
  "~/Library/LaunchAgents/**",
];

/**
 * Personal data in home: Messages' history and attachments, and Mail's store
 * (macOS keeps them from apps without Full Disk Access, but phone-alert
 * replies need it, and everything Mockingbird runs inherits it); the
 * artifacts this install's areas keep (areaArtifacts.ts), which aren't any
 * room's; every pane's saved output; and the landscape, whose wires hold what
 * private sessions finished with, their diffs and files included, and the
 * Orchestrators' held plans (plans.json), each with the copies beside it (a
 * write's `.<pid>.tmp`, an unreadable file's `.bad-<time>`), the file by its own
 * path and the copies by a glob. Denied to room agents beside HOME_SECRETS.
 */
export const HOME_PRIVATE_DATA = [
  "~/Library/Messages/**",
  "~/Library/Mail/**",
  "~/.mockingbird/artifacts/areas/**",
  "~/.mockingbird/scrollback/**",
  "~/.mockingbird/landscape.json",
  "~/.mockingbird/landscape.json.*",
  "~/.mockingbird/plans.json",
  "~/.mockingbird/plans.json.*",
];

/** Credential stores in home: HOME_SECRETS, and the folder of the House's env files (each member's builder token). */
const HOME_SECRET_PLACES = [...HOME_SECRETS, `~/${HOUSE_CONFIG_DIR}/**`];

/**
 * Which of this Mac's credential stores (HOME_SECRET_PLACES, "~/.aws/**")
 * `file` is in, by its real path; null when none. A room artifact added from
 * one is asked about first and stays unreadable to agents.
 */
export function homeSecretPlace(file: string): string | null {
  const real = realpathOr(file);
  for (const place of HOME_SECRET_PLACES) {
    const isDir = place.endsWith("/**");
    const at = realpathOr(expandHome(isDir ? place.slice(0, -3) : place));
    const rel = path.relative(at, real);
    const within = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    if (isDir ? within : rel === "") return place;
  }
  return null;
}

/**
 * Secret files at known places on this Mac: the Azure DevOps PAT file
 * WorkTracker's config.json names. `problem` says what couldn't be worked
 * out; `files` still holds the rest.
 */
export function knownSecretFiles(workTrackerPath: string): { files: string[]; problem: string | null } {
  try {
    const pat = adoPatFile(workTrackerPath);
    return { files: pat ? [pat] : [], problem: null };
  } catch (err) {
    return { files: [], problem: `Couldn't find the Azure DevOps PAT file: ${(err as Error).message}` };
  }
}

/**
 * The deny rules a team room session starts with: SECRET_READS (also
 * anywhere on disk, not only under its folder), the known credential folders
 * in home, Messages and Mail (HOME_PRIVATE_DATA), and the known secret files
 * (knownSecretFiles). They gate Claude's file tools, not its shell commands.
 * `problem` says what couldn't be worked out — the rules still hold
 * everything else.
 */
export function roomSecretReads(workTrackerPath: string): { rules: string[]; problem: string | null } {
  const anywhere = SECRET_FILE_GLOBS.map((g) => `Read(//**/${g})`);
  const known = knownSecretFiles(workTrackerPath);
  // "//" starts an absolute path in a permission rule
  const rules = [...SECRET_READS, ...anywhere, ...[...HOME_SECRETS, ...HOME_PRIVATE_DATA].map((p) => `Read(${p})`), ...known.files.map((f) => `Read(/${f})`)];
  return { rules, problem: notDeniedByPath(known.problem) };
}

/** A knownSecretFiles problem as a deny list reports it. */
export const notDeniedByPath = (problem: string | null) => problem && `${problem} — so it isn't denied by path`;

/**
 * Git pathspecs (for git run at `top`) that match secret files, in any case:
 * SECRET_FILE_GLOBS at any depth, and each of `files` (absolute paths, such as
 * knownSecretFiles) that lies inside `top`.
 */
export function secretPathspecs(top: string, files: readonly string[] = []): string[] {
  const inside = files
    .map((f) => path.relative(realpathOr(top), realpathOr(f)))
    .filter((rel) => rel && !rel.startsWith("..") && !path.isAbsolute(rel));
  // in any case, as isSecretFileName matches names (App.ENV, Secrets.JSON), and as macOS finds files
  return [...SECRET_FILE_GLOBS.map((g) => `:(glob,icase)**/${g}`), ...inside.map((rel) => `:(literal,icase)${rel}`)];
}

const realpathOr = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (isMissing(err)) return p;
    throw err;
  }
};

/** Where WorkTracker's config.json says the ADO PAT is (never read here); null when none is configured. */
export function adoPatFile(workTrackerPath: string): string | null {
  const wt = expandHome(workTrackerPath);
  let text: string;
  try {
    text = fs.readFileSync(path.join(wt, "config.json"), "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  const file = JSON.parse(text)?.azureDevOps?.patFile;
  if (typeof file !== "string" || !file.trim()) return null;
  return path.isAbsolute(file) ? file : path.join(wt, file);
}
