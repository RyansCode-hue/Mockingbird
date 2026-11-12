import { git, parseRemote, publicUrl } from "../git";
import { baseRef } from "../files";
import { ownFetch } from "../safeGit";

/**
 * Teammates' branches as this Mac can see them: pushed to origin and fetched
 * into a local clone, and the files each changes against the repo's base.
 * Room session records name a branch and the repository's origin; this is
 * how their files are found (the House board's claims, the overlap check).
 */

/** A canonical form of a remote URL, so two members' clones of one repo match whatever form each cloned with. */
export function originKey(url: string): string {
  const r = parseRemote(url);
  if (r?.provider === "github") return `github:${r.owner}/${r.repo}`.toLowerCase();
  if (r?.provider === "ado") return `ado:${r.base}/${r.project}/${r.repo}`.toLowerCase();
  return publicUrl(url)
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/**
 * Fetch origin's branches into the clone (remote-tracking refs only), as Mockingbird fetches on its own (ownFetch): a
 * room's repository, so refused for config its sessions' agents can write (`roomRepo`).
 */
export async function fetchOrigin(repo: string): Promise<void> {
  await ownFetch(repo, ["-q", "--prune", "--no-tags", "origin"], { roomRepo: true });
}

/**
 * The files a pushed branch changes against the repo's base branch (as
 * origin/<branch> was last fetched): a commit since it forked.
 */
export async function pushedBranchFiles(repo: string, branch: string): Promise<{ tip: string; files: string[] } | { problem: string }> {
  const tip = (await git(repo, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}^{commit}`], { okCodes: [0, 1] })) || null;
  if (!tip) return { problem: `${branch} isn't on origin (not pushed yet)` };
  const base = await baseRef(repo);
  if (!base) return { problem: "no dev/main-style base branch to compare it with" };
  try {
    const out = await git(repo, ["diff", "--name-only", "-z", `${base}...${tip}`], { trim: false });
    return { tip, files: out.split("\0").filter(Boolean).sort() };
  } catch (err) {
    return { problem: `couldn't compare it with ${base}: ${(err as Error).message}` };
  }
}
