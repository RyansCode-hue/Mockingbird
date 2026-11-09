import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as net from "net";
import { mcpLaunch, type McpLaunch } from "../src/main/messaging";

const held = new Map<string, string>();

/** A live token standing for session `id`, read and removed from its file as the MCP server does. */
export function tokenFor(id: string): string {
  let token = held.get(id);
  if (!token) {
    const file = mcpLaunch(id).env.MOCKINGBIRD_TOKEN_FILE;
    token = fs.readFileSync(file, "utf8");
    fs.rmSync(file);
    held.set(id, token);
  }
  return token;
}

/** Bytes on the socket, and whatever comes back, parsed. */
export function askRaw(sock: string, body: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
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

/** One tool call over the socket as session `from`'s MCP server makes it: `from` picks the token and isn't sent. */
export function askAs(sock: string, { from, ...req }: { from: string; op: string; args?: Record<string, unknown> }): Promise<any> {
  return askRaw(sock, JSON.stringify({ ...req, token: tokenFor(from) }));
}

/** The real MCP server over stdio, as an agent starts it from a launch. */
export function startServer(launch: McpLaunch, env: Record<string, string> = {}) {
  const p: ChildProcessWithoutNullStreams = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env, ...env } });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  let nextId = 1;
  const lines = () => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const request = async (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 250; i++) {
      const m = lines().find((x) => x.id === id);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`the MCP server didn't answer ${method}: ${err || out}`);
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await request("tools/call", { name, arguments: args })).result as { isError: boolean; content: { text: string }[] };
  const stop = () =>
    new Promise<void>((resolve) => {
      if (p.exitCode !== null || p.signalCode !== null) return resolve();
      p.once("exit", () => resolve());
      p.kill();
    });
  return { p, request, call, stop, stderr: () => err };
}
