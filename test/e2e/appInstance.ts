import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { tempDir } from "../helpers";
import { DEFAULT_SETTINGS } from "../../src/shared/types";
import type { TeamStatus } from "../../src/shared/team/types";

/**
 * A real Mockingbird instance (this checkout's dist/ build) with its own
 * throwaway HOME and userData, driven over the DevTools protocol: for the
 * opt-in two-instance team rooms tests. Its window opens on screen.
 */

export const root = path.resolve(__dirname, "..", "..");

export const electronBin = (() => {
  try {
    return path.join(root, "node_modules/electron/dist", fs.readFileSync(path.join(root, "node_modules/electron/path.txt"), "utf8").trim());
  } catch {
    return null;
  }
})();

export type AppInstance = Awaited<ReturnType<typeof launchApp>>;

export async function launchApp(name: string, signalingUrl: string) {
  const home = tempDir(name.toLowerCase());
  const userData = path.join(home, "userdata");
  fs.mkdirSync(path.join(home, ".mockingbird"), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const settings = { ...DEFAULT_SETTINGS, repoRoots: [], notifications: false, setupDone: true, teamName: name, signalingUrl };
  fs.writeFileSync(path.join(home, ".mockingbird", "state.json"), JSON.stringify({ settings, sessions: [] }));
  const main = path.join(home, "devmain.js");
  fs.writeFileSync(main, `const { app } = require("electron");\napp.setPath("userData", ${JSON.stringify(userData)});\nrequire(${JSON.stringify(path.join(root, "dist", "main.js"))});\n`);
  const env = { HOME: home, USER: process.env.USER ?? "", LOGNAME: process.env.USER ?? "", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: process.env.TMPDIR ?? "/tmp" };
  const child = spawn(electronBin!, [main, "--remote-debugging-port=0", "--use-mock-keychain", "--password-store=basic"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const output: string[] = [];
  child.stdout!.on("data", (d) => output.push(String(d)));
  child.stderr!.on("data", (d) => output.push(String(d)));
  // the DevTools port is written once Electron listens
  const portFile = path.join(userData, "DevToolsActivePort");
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
