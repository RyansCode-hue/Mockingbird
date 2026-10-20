import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { it } from "vitest";

// Its worker dies mid-test, so none of its cleanup runs: the run's last check
// finds the process it left running from its HOME, and the HOME itself.
it("starts a process, then its worker crashes", () => {
  const sleeper = spawn("/bin/sleep", ["600"], { cwd: process.env.HOME, detached: true, stdio: "ignore" });
  sleeper.unref();
  fs.appendFileSync(process.env.MB_LEAK_FIXTURE_OUT!, `pid:${sleeper.pid}\nhome:${process.env.HOME}\n`);
  fs.writeFileSync(path.join(process.env.HOME!, "work.txt"), "unfinished");
  process.kill(process.pid, "SIGKILL");
});
