import * as fs from "fs";
import * as path from "path";
import { git, makeRepo, write } from "./helpers";

/** What hostileRepo plants, each a command that touches its marker when it runs. */
export const PLANTED = ["fsmonitor", "plain", "equals", "empty", "textconv", "external", "pager", "gpg"] as const;

/**
 * A feature branch off `dev` whose repository config names a command at every turn a read of it takes: fsmonitor, a
 * filter driver under a plain name, one whose name holds "=", one with an empty name (`[filter ""]`, which git runs for
 * `filter=` set to nothing), a text conversion, an external diff, a pager, and a gpg that log.showSignature runs for
 * the signed commit at the branch's tip. Each touches a marker beside the repo when it runs; `ran` says which did. Its
 * four files are changed in the working tree, each to the same size, so git reads each through its filter to tell
 * whether it changed.
 */
export function hostileRepo() {
  const repo = makeRepo({ "a.txt": "one\n", "b.md": "bee\n", "c.bin": "see\n", "d.e": "dee\n" });
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
  const marker = (name: string) => path.join(path.dirname(repo), `${name}-ran`);
  const script = (name: string, then = "") => {
    const file = path.join(path.dirname(repo), `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\ntouch '${marker(name)}'\n${then}\n`, { mode: 0o755 });
    return file;
  };
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
  write(repo, { "a.txt": "two\n", "b.md": "bea\n", "c.bin": "sea\n", "d.e": "dea\n" });
  const ran = () => PLANTED.filter((n) => fs.existsSync(marker(n)));
  const clear = () => {
    for (const n of PLANTED) fs.rmSync(marker(n), { force: true });
  };
  return { repo, ran, clear };
}
