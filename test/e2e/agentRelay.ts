import * as net from "net";
import * as path from "path";
import { electronBin } from "./appInstance";

/**
 * The app tests' way to call Mockingbird's tools as a pane's agent would, from inside that pane's own processes (the
 * socket's caller check, W20): a stand-in agent starts agentRelay.cjs beside itself with `relayLine`, and the test
 * talks through it.
 */

const RELAY = path.join(__dirname, "agentRelay.cjs");
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The line a stand-in agent's bash script runs to start the relay, with its own pid and arguments: only in a pane (on
 * its pty), so a headless run of the same stand-in never starts one.
 */
export const relayLine = (mode: "raw" | "mcp") =>
  `if [ -t 0 ]; then ELECTRON_RUN_AS_NODE=1 ${q(electronBin ?? "electron")} ${q(RELAY)} ${mode} $$ "$@" </dev/null >/dev/null 2>&1 & fi`;

/**
 * The line a stand-in Claude Code's bash script runs first: Mockingbird's check of a room launch's sandbox
 * (claudeSandboxProbe.ts) is answered as Claude Code `version` answers it, the sandbox on as its --settings write it.
 */
export const sandboxAnswerLine = (version: string) =>
  `if [[ " $* " == *" --bare "* ]]; then MB_FAKE_SANDBOX_VERSION=${q(version)} ELECTRON_RUN_AS_NODE=1 exec ${q(electronBin ?? "electron")} ${q(path.join(__dirname, "..", "fixtures", "fakeClaudeSandbox.cjs"))} "$@"; fi`;

const sockOf = (home: string, pane: string) => path.join(home, "relay", `${pane}.sock`);

/** A connection to pane `pane`'s relay, once it's listening: the pane's relay before it is a stale file, refused. */
async function connect(home: string, pane: string): Promise<net.Socket> {
  for (let i = 0; ; i++) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const c = net.createConnection({ path: sockOf(home, pane), allowHalfOpen: true });
        c.once("connect", () => resolve(c));
        c.once("error", reject);
      });
    } catch (err) {
      if (i >= 150) throw new Error(`pane ${pane}'s relay isn't listening: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** One request on Mockingbird's socket from inside pane `pane`, as its MCP server sends one, and the reply. */
export async function relayRaw(home: string, pane: string, body: string): Promise<any> {
  const c = await connect(home, pane);
  return new Promise((resolve, reject) => {
    let buf = "";
    c.on("data", (d) => (buf += d));
    c.on("end", () => {
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(err);
      }
    });
    c.on("error", reject);
    c.end(body);
  });
}

/** An MCP server started inside pane `pane`, as its CLI starts one, spoken to over the relay. */
export async function relayServer(home: string, pane: string) {
  const c = await connect(home, pane);
  let out = "";
  c.on("data", (d) => (out += d));
  let nextId = 1;
  const lines = () => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const request = async (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    c.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 300; i++) {
      const m = lines().find((x) => x.id === id);
      if (m) return m;
      if (c.destroyed) throw new Error(`pane ${pane}'s server went before answering ${method}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`pane ${pane}'s server didn't answer ${method}: ${out}`);
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await request("tools/call", { name, arguments: args })).result as { isError: boolean; content: { text: string }[] };
  const stop = () =>
    new Promise<void>((resolve) => {
      if (c.destroyed) return resolve();
      c.once("close", () => resolve());
      c.end();
      setTimeout(() => c.destroy(), 2000).unref();
    });
  return { request, call, stop };
}
