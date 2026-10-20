import * as fs from "fs";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { ensureElectron, findElectronPackage, runElectronInstaller } from "./e2e/electron";
import { git, makeRepo, tempDir } from "./helpers";

/** A stand-in for Electron's package in `checkout`'s node_modules, whose install.js runs `install` (Node). */
function electronPackage(checkout: string, install: string, installed = false): string {
  const pkg = path.join(checkout, "node_modules", "electron");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "electron", version: "42.0.0" }));
  fs.writeFileSync(path.join(pkg, "install.js"), install);
  if (installed) {
    fs.mkdirSync(path.join(pkg, "dist", "Electron.app"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "dist", "Electron.app", "Electron"), "");
    fs.writeFileSync(path.join(pkg, "path.txt"), "Electron.app/Electron");
  }
  return pkg;
}

// what Electron's installer does once it has the zip: unpack into dist/ and say where the binary is
const unpacks = `const fs = require("fs"); fs.mkdirSync(__dirname + "/dist/Electron.app", { recursive: true });
fs.writeFileSync(__dirname + "/dist/Electron.app/Electron", ""); fs.writeFileSync(__dirname + "/path.txt", "Electron.app/Electron");`;
const offline = `console.error("HTTPError: Response code 404 (no network)"); process.exit(1);`;

describe("Electron for the two-app tests", () => {
  it("runs Electron's installer when the binary is missing, and uses what it unpacked", () => {
    const checkout = tempDir("checkout");
    const pkg = electronPackage(checkout, unpacks);
    const install = vi.fn(runElectronInstaller);
    const e = ensureElectron(checkout, install);
    expect(install).toHaveBeenCalledOnce();
    expect(e).toEqual({ bin: path.join(pkg, "dist", "Electron.app", "Electron"), how: `${pkg}, in this checkout's node_modules`, installed: true });
  });

  it("leaves an installed Electron alone", () => {
    const checkout = tempDir("checkout");
    electronPackage(checkout, offline, true);
    const install = vi.fn(runElectronInstaller);
    expect(ensureElectron(checkout, install).installed).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it("fails, with where it looked and what the installer said, when the installer can't put it back", () => {
    const checkout = tempDir("checkout");
    const pkg = electronPackage(checkout, offline);
    expect(() => ensureElectron(checkout)).toThrow(
      `MB_E2E_APP is set, but Electron's binary is missing from ${pkg}, in this checkout's node_modules (no dist/ or path.txt), and its installer (node ${pkg}/install.js) failed:\nHTTPError: Response code 404 (no network)\n`
    );
    expect(() => ensureElectron(checkout)).toThrow(/unset MB_E2E_APP to skip the two-app tests/);
    // without the global setup's install, a test file only looks
    expect(() => ensureElectron(checkout, false)).toThrow(/the run's global setup didn't install it/);
  });

  it("fails when an installer exits cleanly without a binary", () => {
    const checkout = tempDir("checkout");
    electronPackage(checkout, "");
    expect(() => ensureElectron(checkout)).toThrow(/its installer \(node .*install\.js\) ran but left no binary/);
  });

  it("finds a worktree's Electron in the main checkout when the worktree has none", () => {
    const main = makeRepo();
    const worktree = path.join(tempDir("worktrees"), "wt");
    git(main, "worktree", "add", "-q", "-b", "wt", worktree);
    const pkg = electronPackage(fs.realpathSync(main), unpacks);
    const e = ensureElectron(worktree);
    expect(e.bin).toBe(path.join(pkg, "dist", "Electron.app", "Electron"));
    expect(e.how).toBe(`${pkg}, in the main checkout's node_modules (${path.join(worktree, "node_modules", "electron")} doesn't exist)`);
  });

  it("says everywhere it looked when there's no Electron at all", () => {
    const main = makeRepo();
    const worktree = path.join(tempDir("worktrees"), "wt");
    git(main, "worktree", "add", "-q", "-b", "wt", worktree);
    expect(() => ensureElectron(worktree)).toThrow(
      `MB_E2E_APP is set, but Electron isn't installed: looked in ${path.join(worktree, "node_modules", "electron")}, then in the main checkout's ${path.join(fs.realpathSync(main), "node_modules", "electron")}. Run npm install`
    );
    expect(findElectronPackage(main).how).toBe(`looked in ${path.join(main, "node_modules", "electron")} (this is the main checkout)`);
    const plain = tempDir("plain");
    expect(findElectronPackage(plain).how).toMatch(new RegExp(`^looked in ${plain}/node_modules/electron; ${plain} isn't a git checkout \\(fatal: not a git repository.*\\), so there's no main checkout to look in$`));
  });
});
