import { app } from "electron";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { which } from "./shell";

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  newer: boolean;
  /** Where "latest" came from: a published GitHub release, or the version on the default branch. */
  source: "release" | "branch";
}

/** owner/repo from a package.json "repository" field ("github:owner/repo", a URL, or { url }). */
export function repoFromPackage(pkg: { repository?: string | { url?: string } }): { owner: string; repo: string } | null {
  const r = pkg.repository;
  const url = typeof r === "string" ? r : (r?.url ?? "");
  const m = url.match(/github(?:\.com)?[/:]([^/]+)\/([^/.]+)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Is b newer than a (simple semver x.y.z compare). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * The GitHub CLI's token, when it's installed and signed in — Mockingbird's
 * repository is private, and GitHub answers "not found" to anyone it can't
 * identify. Not signed in is an ordinary state, not a failure: the check then
 * goes unauthenticated and explains a 404.
 */
async function ghToken(): Promise<string | null> {
  const gh = await which("gh");
  if (!gh) return null;
  return new Promise((resolve) =>
    execFile(gh, ["auth", "token", "--hostname", "github.com"], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout.trim() || null))
  );
}

export interface UpdateDeps {
  pkg: { version?: string; repository?: string | { url?: string } };
  current: string;
  token: () => Promise<string | null>;
  fetch: typeof fetch;
}

/**
 * The newest version on GitHub: the latest published release, or — when the
 * repository has none — the version in package.json on its default branch, so
 * people who build from the repo hear about a bump too. Returns null when the
 * app has no repository to check. Unsigned macOS apps can't replace
 * themselves, so callers show a link and the user updates when they choose.
 */
export async function checkUpdateWith(deps: UpdateDeps): Promise<UpdateInfo | null> {
  const repo = repoFromPackage(deps.pkg);
  if (!repo) return null;
  const token = await deps.token();
  const api = (p: string) =>
    deps.fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}${p}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "mockingbird-app", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  const failed = (res: Response) =>
    new Error(
      res.status === 404 || res.status === 401 || res.status === 403
        ? token
          ? `GitHub refused (${res.status}) — the account the GitHub CLI is signed in to can't see ${repo.owner}/${repo.repo}.`
          : `${repo.owner}/${repo.repo} is private, and this Mac isn't signed in to GitHub. Install the GitHub CLI and run "gh auth login", then check again.`
        : `GitHub answered ${res.status} ${res.statusText}`
    );

  const rel = await api("/releases/latest");
  if (rel.ok) {
    const body = await rel.json();
    const latest = String(body.tag_name ?? "").replace(/^v/i, "");
    return { current: deps.current, latest, url: body.html_url ?? `https://github.com/${repo.owner}/${repo.repo}/releases`, newer: !!latest && isNewer(deps.current, latest), source: "release" };
  }
  // 404 here means "no releases" only once we know the repository itself is visible
  if (rel.status !== 404) throw failed(rel);
  const file = await api("/contents/package.json");
  if (!file.ok) throw failed(file);
  const body = await file.json();
  const latest = String(JSON.parse(Buffer.from(String(body.content ?? ""), "base64").toString("utf8")).version ?? "");
  if (!latest) throw new Error(`package.json on GitHub has no version`);
  return { current: deps.current, latest, url: `https://github.com/${repo.owner}/${repo.repo}`, newer: isNewer(deps.current, latest), source: "branch" };
}

function appPackage(): UpdateDeps["pkg"] {
  return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
}

/** The GitHub repository this build updates from, or null when it doesn't name one. */
export function updateRepo(): { owner: string; repo: string } | null {
  return repoFromPackage(appPackage());
}

export function checkForUpdate(): Promise<UpdateInfo | null> {
  return checkUpdateWith({ pkg: appPackage(), current: app.getVersion(), token: ghToken, fetch });
}
