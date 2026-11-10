import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { branchStat } from "../src/main/files";
import { guardedGit } from "../src/main/safeGit";
import { git, makeRepo, write } from "./helpers";

/**
 * A feature branch off `dev` whose repository config names a command at every turn a diff takes: fsmonitor, a filter
 * driver under a plain name and one whose name holds "=", a text conversion, an external diff and a pager. Each touches
 * a marker beside the repo when it runs.
 */
function hostileRepo() {
  const repo = makeRepo({ "a.txt": "one\n", "b.md": "bee\n", "c.bin": "see\n" });
  git(repo, "branch", "dev");
  git(repo, "switch", "-q", "-c", "feature", "dev");
  write(repo, { ".gitattributes": "*.txt filter=plain\n*.md filter=x=y\n*.bin diff=conv\n" });
  git(repo, "add", ".gitattributes");
  git(repo, "commit", "-qm", "attributes");
  const marker = (name: string) => path.join(path.dirname(repo), `${name}-ran`);
  const script = (name: string, then = "") => {
    const file = path.join(path.dirname(repo), `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\ntouch '${marker(name)}'\n${then}\n`, { mode: 0o755 });
    return file;
  };
  git(repo, "config", "core.fsmonitor", script("fsmonitor", "exit 1"));
  git(repo, "config", "filter.plain.clean", script("plain", "cat"));
  git(repo, "config", "filter.plain.smudge", "cat");
  // set through the file: `git config filter.x=y.clean` would split the key itself
  fs.appendFileSync(path.join(repo, ".git", "config"), `[filter "x=y"]\n\tclean = ${script("equals", "cat")}\n\tsmudge = cat\n`);
  git(repo, "config", "diff.conv.textconv", script("textconv", 'cat "$1"'));
  git(repo, "config", "diff.external", script("external"));
  git(repo, "config", "core.pager", script("pager", "cat"));
  // the same sizes, so git reads each file through its filter to tell whether it changed
  write(repo, { "a.txt": "two\n", "b.md": "bea\n", "c.bin": "sea\n" });
  const ran = () => ["fsmonitor", "plain", "equals", "textconv", "external", "pager"].filter((n) => fs.existsSync(marker(n)));
  const clear = () => {
    for (const n of ["fsmonitor", "plain", "equals", "textconv", "external", "pager"]) fs.rmSync(marker(n), { force: true });
  };
  return { repo, ran, clear };
}

// each makes a repository and runs a dozen gits, which a busy machine takes a while to start
describe("git run through guardedGit", { timeout: 300_000 }, () => {
  it("runs nothing the repository's config names, a filter driver whose name holds '=' included", async () => {
    const h = hostileRepo();
    // each does run for a plain git, so the markers prove something (a pager needs a terminal, so it's left to the env)
    const plain = spawnSync("git", ["-C", h.repo, "diff", "dev"], { encoding: "utf8" });
    expect(plain.status, plain.stderr).toBe(0);
    expect(h.ran()).toEqual(["fsmonitor", "plain", "equals", "external"]);
    h.clear();
    expect(spawnSync("git", ["-C", h.repo, "diff", "--no-ext-diff", "dev"], { encoding: "utf8" }).status).toBe(0);
    expect(h.ran()).toContain("textconv");
    h.clear();

    const g = await guardedGit(h.repo);
    const diff = await g.diff(["dev"]);
    expect(diff).toContain("+two");
    expect(diff).toContain("+bea");
    expect(await g.run(["status", "--porcelain"], { trim: false })).toMatch(/^ M a\.txt$/m);
    expect(h.ran()).toEqual([]);
  });

  it("keeps the card's diff badge from running any of it, every round", async () => {
    const h = hostileRepo();
    expect(await branchStat(h.repo, "dev")).toMatchObject({ base: "dev", files: 4 });
    expect(h.ran()).toEqual([]);
  });

  it("throws when the config can't be read, rather than run with nothing turned off", async () => {
    const repo = makeRepo();
    fs.appendFileSync(path.join(repo, ".git", "config"), "[broken\n");
    await expect(guardedGit(repo)).rejects.toThrow(/git config/);
  });
});
