import * as fs from "fs";
import * as path from "path";
import { git, makeRepo, tempDir, write } from "./helpers";

/** What hostileRepo plants, each a command that touches its marker when it runs. */
export const PLANTED = ["fsmonitor", "plain", "equals", "empty", "textconv", "external", "pager", "gpg", "hook", "refhook"] as const;

/**
 * Commands planted in `dir`, each touching `<name>-ran` there when it runs and adding a line for the git that ran it
 * (its parent's command line) to `ran-by`: `ran` says which ran, `ranBy` which git ran them.
 */
function planter(dir: string, planted: readonly string[]) {
  const names = [...planted];
  const marker = (name: string) => path.join(dir, `${name}-ran`);
  const log = path.join(dir, "ran-by");
  const script = (name: string, then = "", file = path.join(dir, `${name}.sh`)) => {
    if (!names.includes(name)) names.push(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\ntouch '${marker(name)}'\nprintf '%s\\t%s\\n' '${name}' "$(/bin/ps -o command= -p $PPID)" >> '${log}'\n${then}\n`, { mode: 0o755 });
    return file;
  };
  const ran = () => names.filter((n) => fs.existsSync(marker(n)));
  /** Each run whose git's command line `re` matches, as "<what was planted>\t<that git's command line>". */
  const ranBy = (re: RegExp) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l && re.test(l.slice(l.indexOf("\t") + 1))) : []);
  const clear = () => {
    for (const n of names) fs.rmSync(marker(n), { force: true });
    fs.rmSync(log, { force: true });
  };
  return { script, ran, ranBy, clear };
}

/** What watchRepo plants: what runs when git reads the index, writes one, and moves a ref. */
export const WATCHED = ["fsmonitor", "hook", "refhook"] as const;

/**
 * Plants in an existing repository's config what hostileRepo plants for its index and its refs: fsmonitor, and in a
 * folder core.hooksPath names by its whole path (`hooks`, so a linked worktree's gits find it too) post-index-change
 * ("hook") and reference-transaction ("refhook"). `ranBy` says which git ran each. `plant` makes another command that
 * marks it ran, for a test to name in the config, or in `hooks` as another hook.
 */
export function watchRepo(repo: string) {
  const dir = tempDir(`watch-${path.basename(repo)}`);
  const hooks = path.join(dir, "hooks");
  const p = planter(dir, WATCHED);
  git(repo, "config", "core.fsmonitor", p.script("fsmonitor", "exit 1"));
  p.script("hook", "", path.join(hooks, "post-index-change"));
  p.script("refhook", "cat >/dev/null", path.join(hooks, "reference-transaction"));
  git(repo, "config", "core.hooksPath", hooks);
  return { hooks, plant: p.script, ran: p.ran, ranBy: p.ranBy, clear: p.clear };
}

/**
 * A feature branch off `dev` whose repository config names a command at every turn a read of it takes: fsmonitor, a
 * filter driver under a plain name, one whose name holds "=", one with an empty name (`[filter ""]`, which git runs for
 * `filter=` set to nothing), a text conversion, an external diff, a pager, a gpg that log.showSignature runs for the
 * signed commit at the branch's tip, and hooks in a folder of the working tree that core.hooksPath names:
 * post-index-change ("hook", run whenever git writes an index) and reference-transaction ("refhook", whenever it moves
 * a ref). Each touches a marker beside the repo when it runs; `ran` says which did, `ranBy` which git ran them. Its four
 * files are changed in the working tree, each to the same size, so git reads each through its filter to tell whether
 * it changed. f.txt is unchanged but dated anew (`stale` dates it again), so a status or diff refreshes the index for
 * it, writing it.
 */
export function hostileRepo() {
  const repo = makeRepo({ "a.txt": "one\n", "b.md": "bee\n", "c.bin": "see\n", "d.e": "dee\n", "f.txt": "same\n" });
  git(repo, "branch", "dev");
  git(repo, "switch", "-q", "-c", "feature", "dev");
  write(repo, { ".gitattributes": "*.txt filter=plain\n*.md filter=x=y\n*.bin diff=conv\n*.e filter=\n" });
  git(repo, "add", ".gitattributes");
  git(repo, "commit", "-qm", "attributes");
  // its signature is made up: what's under test is that nothing asks gpg about it
  const signed = path.join(path.dirname(repo), "signed-commit");
  const stamp = "t <t@t> 1700000000 +0000";
  fs.writeFileSync(signed, `tree ${git(repo, "rev-parse", "HEAD^{tree}")}\nparent ${git(repo, "rev-parse", "HEAD")}\nauthor ${stamp}\ncommitter ${stamp}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n`);
  git(repo, "update-ref", "refs/heads/feature", git(repo, "hash-object", "-t", "commit", "-w", signed));
  const { script, ran, ranBy, clear } = planter(path.dirname(repo), PLANTED);
  git(repo, "config", "core.fsmonitor", script("fsmonitor", "exit 1"));
  git(repo, "config", "filter.plain.clean", script("plain", "cat"));
  git(repo, "config", "filter.plain.smudge", "cat");
  // set through the file: `git config` would split these keys itself
  fs.appendFileSync(path.join(repo, ".git", "config"), `[filter "x=y"]\n\tclean = ${script("equals", "cat")}\n\tsmudge = cat\n`);
  fs.appendFileSync(path.join(repo, ".git", "config"), `[filter ""]\n\tclean = ${script("empty", "cat")}\n\tsmudge = cat\n`);
  git(repo, "config", "diff.conv.textconv", script("textconv", 'cat "$1"'));
  git(repo, "config", "diff.external", script("external"));
  git(repo, "config", "core.pager", script("pager", "cat"));
  git(repo, "config", "log.showSignature", "true");
  git(repo, "config", "gpg.program", script("gpg", "exit 1"));
  // in the working tree, as an agent could write them; left out of status, so every read lists what it did before
  script("hook", "", path.join(repo, ".githooks", "post-index-change"));
  script("refhook", "cat >/dev/null", path.join(repo, ".githooks", "reference-transaction"));
  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "/.githooks/\n");
  git(repo, "config", "core.hooksPath", ".githooks");
  write(repo, { "a.txt": "two\n", "b.md": "bea\n", "c.bin": "sea\n", "d.e": "dea\n" });
  let dated = 1_600_000_000;
  const stale = () => {
    dated += 10;
    fs.utimesSync(path.join(repo, "f.txt"), dated, dated);
  };
  stale();
  return { repo, ran, ranBy, clear, stale };
}
