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

/** Credentials outside any repository, and this install's own team keys and invite tokens. */
export const HOME_SECRETS = ["~/.ssh/**", "~/.aws/**", "~/.config/gh/**", "~/.netrc", "~/.git-credentials", "~/.mockingbird/team/**"];

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
 * in home, and the known secret files (knownSecretFiles). `problem` says what
 * couldn't be worked out — the rules still hold everything else.
 */
export function roomSecretReads(workTrackerPath: string): { rules: string[]; problem: string | null } {
  const anywhere = SECRET_FILE_GLOBS.map((g) => `Read(//**/${g})`);
  const known = knownSecretFiles(workTrackerPath);
  // "//" starts an absolute path in a permission rule
  const rules = [...SECRET_READS, ...anywhere, ...HOME_SECRETS.map((p) => `Read(${p})`), ...known.files.map((f) => `Read(/${f})`)];
  return { rules, problem: notDeniedByPath(known.problem) };
}

/** A knownSecretFiles problem as a deny list reports it. */
export const notDeniedByPath = (problem: string | null) => problem && `${problem} — so it isn't denied by path`;

/**
 * Git pathspecs (for git run at `top`) that match secret files:
 * SECRET_FILE_GLOBS at any depth, and each of `files` (absolute paths, such as
 * knownSecretFiles) that lies inside `top`.
 */
export function secretPathspecs(top: string, files: readonly string[] = []): string[] {
  const inside = files
    .map((f) => path.relative(realpathOr(top), realpathOr(f)))
    .filter((rel) => rel && !rel.startsWith("..") && !path.isAbsolute(rel));
  return [...SECRET_FILE_GLOBS.map((g) => `:(glob)**/${g}`), ...inside.map((rel) => `:(literal)${rel}`)];
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
