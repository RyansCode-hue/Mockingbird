import * as fs from "fs";
import * as path from "path";
import { expandHome } from "./store";
import { isMissing } from "./fileOps";

/**
 * Secret files by name, at any depth: env files, keys and certificates, and
 * the usual credential, PAT and local-settings files. The one list every
 * secret guard is built from: Claude's deny-read rules (SECRET_READS,
 * roomSecretReads) and what a room backup leaves out (secretPathspecs).
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

/**
 * SECRET_FILE_GLOBS as Claude permission rules (--disallowedTools), relative
 * to the session's folder. The run-setup drafter names env files without
 * reading them; team room sessions run with these denied.
 */
export const SECRET_READS = SECRET_FILE_GLOBS.map((g) => `Read(**/${g})`);

/** Credentials outside any repository, and this install's own team keys and invite tokens. */
const HOME_SECRETS = ["~/.ssh/**", "~/.aws/**", "~/.config/gh/**", "~/.netrc", "~/.git-credentials", "~/.mockingbird/team/**"];

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
  return { rules, problem: known.problem && `${known.problem} — so it isn't denied by path` };
}

/**
 * Git pathspecs (for `git add` run at `top`) that leave secret files out:
 * SECRET_FILE_GLOBS at any depth, and each of `files` (absolute paths, such as
 * knownSecretFiles) that lies inside `top`.
 */
export function secretPathspecs(top: string, files: readonly string[] = []): string[] {
  const inside = files
    .map((f) => path.relative(realpathOr(top), realpathOr(f)))
    .filter((rel) => rel && !rel.startsWith("..") && !path.isAbsolute(rel));
  return [...SECRET_FILE_GLOBS.map((g) => `:(exclude,glob)**/${g}`), ...inside.map((rel) => `:(exclude,literal)${rel}`)];
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
