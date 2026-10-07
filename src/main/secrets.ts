import * as fs from "fs";
import * as path from "path";
import { expandHome } from "./store";
import { isMissing } from "./fileOps";

/**
 * Files an agent never needs to read: env files, keys and certificates,
 * local settings. As Claude permission rules (--disallowedTools), relative to
 * the session's folder. The run-setup drafter names env files without
 * reading them; team room sessions run with these denied.
 */
export const SECRET_READS = ["Read(**/.env)", "Read(**/.env.*)", "Read(**/*.env)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/*.pfx)", "Read(**/*.p12)", "Read(**/local.settings.json)", "Read(**/secrets.json)"];

/** Credentials outside any repository, and this install's own team keys and invite tokens. */
const HOME_SECRETS = ["~/.ssh/**", "~/.aws/**", "~/.config/gh/**", "~/.netrc", "~/.git-credentials", "~/.mockingbird/team/**"];

/**
 * The deny rules a team room session starts with: SECRET_READS (also
 * anywhere on disk, not only under its folder), credential files, the known
 * credential folders in home, and the Azure DevOps PAT file WorkTracker's
 * config.json names. `problem` says what couldn't be worked out — the rules
 * still hold everything else.
 */
export function roomSecretReads(workTrackerPath: string): { rules: string[]; problem: string | null } {
  const anywhere = SECRET_READS.map((r) => r.replace(/^Read\(\*\*\//, "Read(//**/"));
  const rules = [...SECRET_READS, ...anywhere, "Read(**/credentials.json)", "Read(**/*.pat)", "Read(**/*pat*.txt)", ...HOME_SECRETS.map((p) => `Read(${p})`)];
  let problem: string | null = null;
  try {
    const pat = adoPatFile(workTrackerPath);
    // "//" starts an absolute path in a permission rule
    if (pat) rules.push(`Read(/${pat})`);
  } catch (err) {
    problem = `Couldn't find the Azure DevOps PAT file to deny reading it: ${(err as Error).message}`;
  }
  return { rules, problem };
}

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
