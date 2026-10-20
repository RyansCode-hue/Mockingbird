import * as fs from "fs";
import { afterAll, beforeAll, inject } from "vitest";
import { describeStray, killStrays, record, settledStrays, thisFile } from "./leaks";

// Every test file gets a throwaway home, set before any module under test is
// imported (they compute ~/.mockingbird etc. at load), so nothing touches the
// real ~/.mockingbird, ~/.claude or ~/.codex. The base path is short on
// purpose: macOS caps Unix-socket paths at 104 bytes and the messaging tests
// bind one inside this home.
const home = fs.mkdtempSync("/tmp/mbt-");
process.env.HOME = home;
// commits in fixture repos need an identity, and the fake home has no gitconfig
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Mockingbird Test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.invalid";

// The run's log of temp folders (test/globalSetup.ts): a file whose tests are
// all skipped never runs the hooks below, and the run removes its home.
thisFile.run = inject("mbTestRun");
thisFile.home = home;
record(thisFile.run, { kind: "root", path: home, home });

let file = "this test file";
beforeAll(({}, suite) => {
  file = suite.file.filepath;
  record(thisFile.run, { kind: "started", home, file });
});

// Nothing a file started outlives it: what still runs from it once its own
// cleanup is done (its children, or anything in its temp folders) is killed,
// with its process group, and fails the file by name. Removal retries while
// late writers finish (a language server's own tsserver child, say); a home
// holding fixture repos can take seconds to delete on a loaded machine, so
// this hook has its own limit rather than the 10 s default.
afterAll(async () => {
  // esbuild's API keeps its service process for later builds until it's stopped
  await (await import("esbuild")).stop();
  const roots = [home, ...thisFile.dirs];
  const left = await settledStrays({ roots, descendantsOf: process.pid }, 3000);
  const problems = left.map((s) => `left running (killed now): ${describeStray(s)}`);
  await killStrays(left);
  for (const dir of roots) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      problems.push(`couldn't remove the temp folder ${dir}: ${(err as Error).message}`);
    }
  }
  if (left.length) record(thisFile.run, { kind: "leak", file, lines: problems.slice(0, left.length) });
  record(thisFile.run, { kind: "ended", home });
  if (problems.length) throw new Error(`${file} left things behind:\n  ${problems.join("\n  ")}`);
}, 60_000);
