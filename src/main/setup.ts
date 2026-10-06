import * as fs from "fs";
import type { AgentCheck, AgentKind, SetupStatus } from "../shared/types";
import { Store, expandHome } from "./store";
import { indexRepos } from "./repos";
import { hookStatus } from "./hooks";
import { userShell, quote } from "./shell";
import { adoIdentity } from "./ado";
import { isInstalledBin } from "./agents";

/**
 * The agents' binaries. `refresh` looks them up afresh in the user's shell
 * without blocking; binFor() then answers from what it found.
 */
export interface AgentBins {
  binFor(kind: AgentKind): string;
  refresh(): Promise<void>;
}

async function checkAgent(sessions: AgentBins, kind: AgentKind): Promise<AgentCheck> {
  const bin = sessions.binFor(kind);
  if (!isInstalledBin(bin)) return { found: false, path: null, version: null, signedIn: null };
  const path = bin;
  const version = (await userShell(`${quote(path)} --version 2>&1`)).out.split("\n")[0] || null;
  if (kind === "claude") {
    // prints JSON with loggedIn; anything unparseable is reported, not guessed
    const r = await userShell(`${quote(path)} auth status`);
    try {
      return { found: true, path, version, signedIn: !!JSON.parse(r.out).loggedIn };
    } catch {
      return { found: true, path, version, signedIn: null, detail: r.out.slice(0, 200) || "claude auth status gave no answer" };
    }
  }
  const r = await userShell(`${quote(path)} login status 2>&1`);
  return { found: true, path, version, signedIn: r.code === 0 && /logged in/i.test(r.out), detail: r.code === 0 ? undefined : r.out.slice(0, 200) };
}

const ADO_TIMEOUT_MS = 10_000;

async function checkAdo(store: Store): Promise<SetupStatus["ado"]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Azure DevOps didn't answer within ${ADO_TIMEOUT_MS / 1000}s — check the org URL, or your VPN`)),
      ADO_TIMEOUT_MS
    );
  });
  try {
    const me = await Promise.race([adoIdentity(store), timeout]);
    return { connected: true, display: me.display, detail: `${me.org} · ${me.project}` };
  } catch (err) {
    return { connected: false, detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Everything the setup wizard shows, read from the machine rather than from saved flags. */
export async function setupStatus(store: Store, bins: AgentBins): Promise<SetupStatus> {
  const adoCheck = checkAdo(store); // network — runs alongside the local checks, bounded
  await bins.refresh(); // a CLI installed since the last check must show up on "Check again"
  const [claude, codex] = await Promise.all([checkAgent(bins, "claude"), checkAgent(bins, "codex")]);
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
  const ado = await adoCheck;
  return {
    claude,
    codex,
    hooks: hookStatus(codex.path),
    repoRoots,
    workTrackerPath: store.settings.workTrackerPath,
    ado,
  };
}
