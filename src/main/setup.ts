import { execFile } from "child_process";
import * as fs from "fs";
import type { AgentCheck, AgentKind, SetupStatus } from "../shared/types";
import { Store, expandHome } from "./store";
import { SessionManager } from "./sessions";
import { indexRepos } from "./repos";
import { hookStatus } from "./hooks";
import { adoIdentity } from "./ado";

/** Run a command in a login shell (the user's PATH) and hand back its exit code and output. */
function sh(cmd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-lc", cmd], { timeout: 20_000, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function checkAgent(sessions: SessionManager, kind: AgentKind): Promise<AgentCheck> {
  const bin = sessions.binFor(kind);
  const where = await sh(`command -v ${q(bin)}`);
  if (where.code !== 0) return { found: false, path: null, version: null, signedIn: null };
  const path = where.out.split("\n").pop() ?? bin;
  const version = (await sh(`${q(path)} --version`)).out.split("\n")[0] || null;
  if (kind === "claude") {
    // prints JSON with loggedIn; anything unparseable is reported, not guessed
    const r = await sh(`${q(path)} auth status`);
    try {
      return { found: true, path, version, signedIn: !!JSON.parse(r.out).loggedIn };
    } catch {
      return { found: true, path, version, signedIn: null, detail: r.out.slice(0, 200) || "claude auth status gave no answer" };
    }
  }
  const r = await sh(`${q(path)} login status`);
  return { found: true, path, version, signedIn: r.code === 0 && /logged in/i.test(r.out), detail: r.code === 0 ? undefined : r.out.slice(0, 200) };
}

/** Everything the setup wizard shows, read from the machine rather than from saved flags. */
export async function setupStatus(store: Store, sessions: SessionManager): Promise<SetupStatus> {
  const [claude, codex] = await Promise.all([checkAgent(sessions, "claude"), checkAgent(sessions, "codex")]);
  const repoRoots = store.settings.repoRoots.map((root) => {
    const repos = indexRepos([root]);
    let exists = true;
    try {
      exists = fs.statSync(expandHome(root)).isDirectory();
    } catch {
      exists = false;
    }
    return { path: root, exists, repos: repos.length };
  });
  let ado: SetupStatus["ado"];
  try {
    const me = await adoIdentity(store);
    ado = { connected: true, display: me.display, detail: `${me.org} · ${me.project}` };
  } catch (err) {
    ado = { connected: false, detail: (err as Error).message };
  }
  return {
    claude,
    codex,
    hooks: hookStatus(),
    repoRoots,
    workTrackerPath: store.settings.workTrackerPath,
    ado,
  };
}
