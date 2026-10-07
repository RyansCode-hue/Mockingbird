import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { tempDir } from "../helpers";
import { startLocalSignaling } from "../../signaling/src/local/server";
import { DEFAULT_SETTINGS, type Settings } from "../../src/shared/types";
import type { TeamStatus } from "../../src/shared/team/types";

/**
 * A real Mockingbird instance (this checkout's dist/ build) with its own
 * HOME and userData, driven over the DevTools protocol: for the opt-in
 * two-instance team rooms tests. Its window opens on screen.
 */

export const root = path.resolve(__dirname, "..", "..");

export const electronBin = (() => {
  try {
    return path.join(root, "node_modules/electron/dist", fs.readFileSync(path.join(root, "node_modules/electron/path.txt"), "utf8").trim());
  } catch {
    return null;
  }
})();

/** Whether the two-instance tests run: asked for (they open windows), not in CI, and Electron is installed. */
export const appE2E = !!process.env.MB_E2E_APP && !process.env.CI && !!electronBin && fs.existsSync(electronBin);

export type AppInstance = Awaited<ReturnType<typeof launchApp>>;

export interface LaunchOptions {
  /** Run in this HOME (an existing instance's, to start it again) instead of a new throwaway one. */
  home?: string;
  /** Keep the HOME's saved state (sessions, settings) rather than writing a fresh one. */
  keepState?: boolean;
  settings?: Partial<Settings>;
  /** More environment for the app (e.g. MOCKINGBIRD_E2E_RELAY_ONLY). */
  env?: Record<string, string>;
}

export async function launchApp(name: string, signalingUrl: string, o: LaunchOptions = {}) {
  const home = o.home ?? tempDir(name.toLowerCase());
  const userData = path.join(home, "userdata");
  fs.mkdirSync(path.join(home, ".mockingbird"), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const stateFile = path.join(home, ".mockingbird", "state.json");
  if (!o.keepState || !fs.existsSync(stateFile)) {
    const settings = { ...DEFAULT_SETTINGS, repoRoots: [], notifications: false, setupDone: true, teamName: name, signalingUrl, ...o.settings };
    fs.writeFileSync(stateFile, JSON.stringify({ settings, sessions: [] }));
  }
  // the app's git (worktrees, backups) needs an identity, and this HOME has no other
  fs.writeFileSync(path.join(home, ".gitconfig"), `[user]\n\tname = ${name}\n\temail = ${name.toLowerCase()}@example.invalid\n`);
  const main = path.join(home, "devmain.js");
  fs.writeFileSync(main, `const { app } = require("electron");\napp.setPath("userData", ${JSON.stringify(userData)});\nrequire(${JSON.stringify(path.join(root, "dist", "main.js"))});\n`);
  const env = { HOME: home, USER: process.env.USER ?? "", LOGNAME: process.env.USER ?? "", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: process.env.TMPDIR ?? "/tmp", ...o.env };
  // the DevTools port is written once Electron listens: a previous run's file names a port nobody listens on
  const portFile = path.join(userData, "DevToolsActivePort");
  fs.rmSync(portFile, { force: true });
  const child = spawn(electronBin!, [main, "--remote-debugging-port=0", "--use-mock-keychain", "--password-store=basic"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const output: string[] = [];
  child.stdout!.on("data", (d) => output.push(String(d)));
  child.stderr!.on("data", (d) => output.push(String(d)));
  let wsUrl = "";
  for (let i = 0; i < 120 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!fs.existsSync(portFile)) continue;
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      wsUrl = pages.find((p) => p.type === "page" && p.url.endsWith("/index.html"))?.webSocketDebuggerUrl ?? "";
    } catch {
      // not listening yet
    }
  }
  if (!wsUrl) throw new Error(`${name}'s window never appeared:\n${output.join("").slice(-2000)}`);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = () => reject(new Error("no DevTools connection")))));
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  /** A DevTools protocol call (Input.insertText types as a person would). */
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async <T,>(expression: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r?.result?.value;
  };
  // the page can be listed before its preload has run
  await untilTrue(`${name}'s window bridge`, async () => (await evaluate<string>("typeof window.mb")) === "object", 20_000);
  return { name, home, child, output, send, evaluate, status: () => evaluate<TeamStatus>("window.mb.teamStatus()"), close: () => ws.close() };
}

export async function untilTrue(what: string, cond: () => Promise<boolean>, ms = 30_000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function quitApp(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

/** An instance's main.log, for what went wrong. */
export const mainLog = (a: { home: string }) => {
  const f = path.join(a.home, ".mockingbird", "main.log");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
};

// ---- the signaling server: local, or a deployed Worker -----------------------------------------

/**
 * Where the room creator's HOME lives when the tests run against a deployed
 * Worker: outside ~/.mockingbird, at a fixed path, so its identity — the
 * fingerprint in the Worker's ALLOWED_CREATORS — is the same every run
 * (`npm run team:e2e-fingerprint` prints it).
 */
export const E2E_CREATOR_HOME = path.join(os.tmpdir(), "mockingbird-e2e-creator");

/**
 * The signaling server the two-instance tests use: the deployed Worker at
 * MB_E2E_SIGNALING_URL, or a local one. `creatorHome` is the room creator's
 * HOME for a Worker: E2E_CREATOR_HOME emptied of everything but its identity,
 * so each run starts with no rooms.
 */
export async function e2eSignaling(): Promise<{ url: string; real: boolean; creatorHome: string | undefined; close: () => Promise<void> }> {
  const real = process.env.MB_E2E_SIGNALING_URL?.trim().replace(/\/+$/, "");
  if (!real) {
    const local = await startLocalSignaling({ log: () => undefined });
    return { url: local.url, real: false, creatorHome: undefined, close: () => local.close() };
  }
  const identity = path.join(E2E_CREATOR_HOME, ".mockingbird", "team", "identity.json");
  const keep = fs.existsSync(identity) ? fs.readFileSync(identity) : null;
  fs.rmSync(E2E_CREATOR_HOME, { recursive: true, force: true });
  if (keep) {
    fs.mkdirSync(path.dirname(identity), { recursive: true, mode: 0o700 });
    fs.writeFileSync(identity, keep, { mode: 0o600 });
  } else fs.mkdirSync(E2E_CREATOR_HOME, { recursive: true });
  return { url: real, real: true, creatorHome: E2E_CREATOR_HOME, close: async () => {} };
}

/** How each instance reaches the other right now ("direct", "turn", …), from its peer status. */
export async function routes(...apps: AppInstance[]): Promise<string[]> {
  return Promise.all(apps.map(async (a) => (await a.status()).peers.map((p) => p.state).join(",")));
}
