import * as fs from "fs";
import { afterAll } from "vitest";

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

// a process a test started can still be writing here as it exits (a language
// server's own tsserver child, say): removal retries while the folder empties
afterAll(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
