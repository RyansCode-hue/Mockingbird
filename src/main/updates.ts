import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  newer: boolean;
}

/**
 * Update source = the package.json "repository" field (e.g.
 * "github:owner/mockingbird"). Absent → update checks are disabled; the
 * Settings tab says so instead of erroring.
 */
function repoFromPackage(): { owner: string; repo: string } | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
    const r = pkg.repository;
    const url: string = typeof r === "string" ? r : (r?.url ?? "");
    const m = url.match(/github(?:\.com)?[/:]([^/]+)\/([^/.]+)/i);
    return m ? { owner: m[1], repo: m[2] } : null;
  } catch {
    return null;
  }
}

/** Is b newer than a (simple semver x.y.z compare). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Checks the GitHub "latest release" for a newer version. The app can't
 * silently self-replace (unsigned macOS apps can't auto-update), so callers
 * surface a notification/link and the user updates when they choose.
 * Returns null when no repository is configured.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const repo = repoFromPackage();
  if (!repo) return null;
  const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "mockingbird-app" },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText}`);
  const rel = await res.json();
  const latest = String(rel.tag_name ?? "").replace(/^v/i, "");
  const current = app.getVersion();
  return {
    current,
    latest,
    url: rel.html_url ?? `https://github.com/${repo.owner}/${repo.repo}/releases`,
    newer: !!latest && isNewer(current, latest),
  };
}
