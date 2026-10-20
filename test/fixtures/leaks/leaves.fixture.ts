import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { expect, it } from "vitest";
import { scratchDir } from "../../helpers";

// Passes, but leaves a process running from its HOME, in its own group, and a
// temp folder outside the HOME: the file's own check reports the process.
it("starts a process and doesn't stop it", () => {
  const sleeper = spawn("/bin/sleep", ["600"], { cwd: process.env.HOME, detached: true, stdio: "ignore" });
  sleeper.unref();
  fs.appendFileSync(process.env.MB_LEAK_FIXTURE_OUT!, `pid:${sleeper.pid}\n`);
  const scratch = scratchDir("mb-leak-fixture");
  fs.writeFileSync(path.join(scratch, "left.txt"), "left");
  fs.appendFileSync(process.env.MB_LEAK_FIXTURE_OUT!, `dir:${scratch}\n`);
  expect(sleeper.pid).toBeGreaterThan(0);
});
