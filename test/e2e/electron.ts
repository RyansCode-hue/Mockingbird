import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Electron for the two-app tests. Reinstalling node_modules (the app's own
 * Update does) can leave Electron's package without its binary — no dist/,
 * no path.txt — and the tests would then have nothing to run. With
 * MB_E2E_APP set, the run's global setup puts it back with Electron's own
 * installer (it unpacks the zip cached in ~/Library/Caches/electron, and
 * downloads only when that's missing) and fails, saying where it looked,
 * when it can't.
 */

/** The main checkout of the git worktree at `root` (itself when it is the main one), or why there isn't one. */
function mainCheckout(root: string): { dir: string } | { error: string } {
  try {
    const common = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return { dir: path.dirname(common) };
  } catch (err) {
    return { error: `${root} isn't a git checkout (${((err as { stderr?: string }).stderr ?? (err as Error).message).trim()})` };
  }
}

/**
 * Electron's package for the checkout at `root`: its own node_modules', or —
 * a worktree without one — the main checkout's. `how` says where it was
 * found, or everywhere it was looked for.
 */
export function findElectronPackage(root: string): { pkg: string | null; how: string } {
  const own = path.join(root, "node_modules", "electron");
  if (fs.existsSync(path.join(own, "package.json"))) return { pkg: own, how: `${own}, in this checkout's node_modules` };
  const main = mainCheckout(root);
  if ("error" in main) return { pkg: null, how: `looked in ${own}; ${main.error}, so there's no main checkout to look in` };
  // git names the folder by its real path: /tmp is /private/tmp
  if (fs.realpathSync(main.dir) === fs.realpathSync(root)) return { pkg: null, how: `looked in ${own} (this is the main checkout)` };
  const theirs = path.join(main.dir, "node_modules", "electron");
  if (fs.existsSync(path.join(theirs, "package.json"))) return { pkg: theirs, how: `${theirs}, in the main checkout's node_modules (${own} doesn't exist)` };
  return { pkg: null, how: `looked in ${own}, then in the main checkout's ${theirs}` };
}

/** The Electron binary path.txt names in `pkg`, when both are there. */
export function electronBinary(pkg: string): string | null {
  let rel: string;
  try {
    rel = fs.readFileSync(path.join(pkg, "path.txt"), "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const bin = path.join(pkg, "dist", rel);
  return rel && fs.existsSync(bin) ? bin : null;
}

export type Installer = (pkg: string) => { ok: boolean; output: string };

/** Electron's own installer, as npm runs it after installing the package. */
export const runElectronInstaller: Installer = (pkg) => {
  const r = spawnSync(process.execPath, [path.join(pkg, "install.js")], { cwd: pkg, encoding: "utf8", timeout: 300_000 });
  return { ok: r.status === 0, output: `${r.error ? `${r.error.message}\n` : ""}${r.stdout ?? ""}${r.stderr ?? ""}` };
};

/**
 * The Electron binary for `root`, installed first when its package has none
 * (`install: false` only looks). Throws, saying where it looked and what the
 * installer said, when there's still no binary.
 */
export function ensureElectron(root: string, install: Installer | false = runElectronInstaller): { bin: string; how: string; installed: boolean } {
  const { pkg, how } = findElectronPackage(root);
  if (!pkg) throw new Error(`MB_E2E_APP is set, but Electron isn't installed: ${how}. Run npm install, or unset MB_E2E_APP to skip the two-app tests.`);
  const bin = electronBinary(pkg);
  if (bin) return { bin, how, installed: false };
  if (!install) throw new Error(`MB_E2E_APP is set, but Electron's binary is missing from ${how} (no dist/ or path.txt), and the run's global setup didn't install it.`);
  const r = install(pkg);
  const after = electronBinary(pkg);
  if (r.ok && after) return { bin: after, how, installed: true };
  throw new Error(
    `MB_E2E_APP is set, but Electron's binary is missing from ${how} (no dist/ or path.txt), and its installer ` +
      `(node ${path.join(pkg, "install.js")}) ${r.ok ? "ran but left no binary" : "failed"}:\n${r.output.trim().slice(-2000) || "(no output)"}\n` +
      `It unpacks the zip cached in ~/Library/Caches/electron, downloading only when that's missing. Run it by hand to see why, or unset MB_E2E_APP to skip the two-app tests.`
  );
}
