import * as fs from "fs";
import * as path from "path";
import { electronBin } from "./appInstance";

/**
 * The app tests' stand-ins for Claude Code and Codex (fakeCli.cjs), set as Settings' claudeBin and codexBin: a bash shim
 * per CLI that answers `--version` and `--help` as the CLI does, does nothing when it isn't run on a terminal (a
 * headless read of the binary), and otherwise runs the stand-in, under Electron as Node, in the pane.
 */

const SCRIPT = path.join(__dirname, "fakeCli.cjs");
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const shim = (kind: "claude" | "codex", version: string) => `#!/bin/bash
if [ "$1" = "--version" ]; then echo ${q(version)}; exit 0; fi
if [ "$1" = "--help" ]; then echo "Usage: ${kind} [options] [prompt]"; exit 0; fi
if [ ! -t 0 ]; then exit 0; fi
ELECTRON_RUN_AS_NODE=1 exec ${q(electronBin ?? "electron")} ${q(SCRIPT)} ${kind} "$@"
`;

/** The two shims, written into `dir`. */
export function fakeClis(dir: string): { claude: string; codex: string } {
  const claude = path.join(dir, "claude");
  const codex = path.join(dir, "codex");
  fs.writeFileSync(claude, shim("claude", "2.1.400 (Claude Code stand-in)"), { mode: 0o755 });
  fs.writeFileSync(codex, shim("codex", "codex-cli 0.160.0 (stand-in)"), { mode: 0o755 });
  return { claude, codex };
}

/** One line of what a stand-in saw and did (fakeCli.cjs). */
export interface FakeEntry {
  at: number;
  pid: number;
  kind: "started" | "paste" | "prompt" | "commit" | "tool" | "turn-ended" | "turn-failed" | "hooks" | "killed" | "mcp-exit" | "mcp-error";
  text?: string;
  how?: "typed" | "pasted" | "argv";
  conv?: string;
  resumed?: boolean;
  cwd?: string;
  args?: string[];
  sha?: string;
  name?: string;
  reply?: string;
  isError?: boolean;
  message?: string;
}

/** What the stand-in in pane `id` of the app at `home` has logged, every launch's, in order. */
export function fakeLog(home: string, id: string): FakeEntry[] {
  const file = path.join(home, "fake-cli", `${id}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FakeEntry);
}

/** Have the next paste holding `marker` into any stand-in of the app at `home` signal process `pid` before its Enter. */
export function killOnPaste(home: string, pid: number, marker: string, signal: NodeJS.Signals = "SIGKILL"): void {
  fs.mkdirSync(path.join(home, "fake-cli"), { recursive: true });
  fs.writeFileSync(path.join(home, "fake-cli", "kill-on-paste"), JSON.stringify({ pid, marker, signal }));
}
