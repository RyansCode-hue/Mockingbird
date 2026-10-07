import { execFileSync, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { startLocalSignaling } from "../signaling/src/local/server";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import type { TeamStatus } from "../src/shared/team/types";

/**
 * Two real Mockingbird instances (this checkout's build) on one Mac, each with
 * its own throwaway HOME and userData, share and join a room over the local
 * signaling server: the whole app path — IPC, the service, the hidden peer
 * host inside the app, the sidebar badge. Their windows open on screen while
 * it runs, so it's opt-in:
 *
 *   MB_E2E_APP=1 npx vitest run test/teamApp.e2e.test.ts
 */

const root = path.resolve(__dirname, "..");
const electronBin = (() => {
  try {
    return path.join(root, "node_modules/electron/dist", fs.readFileSync(path.join(root, "node_modules/electron/path.txt"), "utf8").trim());
  } catch {
    return null;
  }
})();

/** One app instance, driven over the DevTools protocol. */
async function launch(name: string, signalingUrl: string) {
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
  const evaluate = <T,>(expression: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, (m) => (m.result?.exceptionDetails ? reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400))) : resolve(m.result?.result?.value)));
      ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  return { name, home, child, output, evaluate, status: () => evaluate<TeamStatus>("window.mb.teamStatus()"), close: () => ws.close() };
}

async function until(what: string, cond: () => Promise<boolean>, ms = 30_000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function quit(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

describe("team rooms between two Mockingbird instances", () => {
  it.skipIf(!process.env.MB_E2E_APP || !!process.env.CI || !electronBin || !fs.existsSync(electronBin))(
    "shares a group on one, joins it on the other, and both show the room and each other",
    async () => {
      execFileSync(process.execPath, ["esbuild.mjs"], { cwd: root, stdio: "ignore" });
      const signal = await startLocalSignaling({ log: () => undefined });
      const ryan = await launch("Ryan", signal.url);
      const nick = await launch("Nick", signal.url);
      try {
        const share = await ryan.evaluate<{ roomId: string; invite: string; error?: string }>(`window.mb.teamShareGroup("5110", "#5110 Donor entities")`);
        expect(share.error).toBeUndefined();
        await until("Ryan's signaling", async () => (await ryan.status()).rooms[0]?.signaling === "online");
        const join = await nick.evaluate<{ roomId: string; error?: string }>(`window.mb.teamJoin(${JSON.stringify(share.invite)})`);
        expect(join).toMatchObject({ roomId: share.roomId });
        await until("both connected", async () => (await ryan.status()).rooms[0]?.online.length === 1 && (await nick.status()).rooms[0]?.online.length === 1);
        const [r, n] = [await ryan.status(), await nick.status()];
        expect(r.peers).toEqual([expect.objectContaining({ name: "Nick", state: "direct" })]);
        expect(n.peers).toEqual([expect.objectContaining({ name: "Ryan", state: "direct" })]);
        expect(n.rooms[0]).toMatchObject({ name: "#5110 Donor entities", groupKey: "5110", members: [{ name: "Ryan" }, { name: "Nick", self: true }] });
        // the sidebar: the room is a group with the shared badge and the teammate's initials
        await until("Nick's sidebar badge", async () => (await nick.evaluate<string>(`document.querySelector(".team-badge")?.textContent ?? ""`)) === "sharedR");
        await until("Ryan's sidebar badge", async () => (await ryan.evaluate<string>(`document.querySelector(".team-badge")?.textContent ?? ""`)) === "sharedN");
        // the hidden peer host never became the app's window
        expect(await ryan.evaluate<string>("document.title")).toBe("Mockingbird");
      } finally {
        ryan.close();
        nick.close();
        await Promise.all([quit(ryan.child), quit(nick.child)]);
        await signal.close();
      }
      const logs = ["ryan", "nick"].map((who) => {
        const f = path.join(who === "ryan" ? ryan.home : nick.home, ".mockingbird", "main.log");
        return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
      });
      expect(logs.join("\n")).toMatch(/team: connected to/);
    },
    120_000
  );
});
