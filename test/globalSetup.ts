import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { TestProject } from "vitest/node";
import { ensureElectron } from "./e2e/electron";
import { checkRun } from "./leaks";

declare module "vitest" {
  export interface ProvidedContext {
    /** The run's folder, holding the log of every test file's temp folders (see test/leaks.ts). */
    mbTestRun: string;
  }
}

/**
 * Once per run: Electron for the two-app tests when they're asked for, and a
 * log every test file adds its temp folders to. When the run ends, anything
 * still running from those folders is killed, the folders still there are
 * removed, and the run fails with the list — itemising, too, what each file
 * reported leaving.
 */
export function setup(project: TestProject) {
  if (process.env.MB_E2E_APP && !process.env.CI) {
    const e = ensureElectron(path.resolve(__dirname, ".."));
    if (e.installed) console.log(`[e2e] installed Electron's binary, from ${e.how}: ${e.bin}`);
  }
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "mockingbird-test-run-"));
  project.provide("mbTestRun", run);
  return async () => {
    const problems = await checkRun(run);
    fs.rmSync(run, { recursive: true, force: true });
    if (problems.length) throw new Error(`The test run left things behind:\n  ${problems.join("\n  ")}`);
  };
}
