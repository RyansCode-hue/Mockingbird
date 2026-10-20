import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import type * as http from "http";
import * as https from "https";
import * as path from "path";
import { pipeline } from "stream/promises";
import { spawnRpcProcess } from "../rpc";
import { quote } from "../shell";
import { MB_DIR } from "../store";
import { DapConnection } from "./client";

/**
 * The debug adapters Mockingbird uses, downloaded on first use at pinned
 * versions and checked against their publishers' SHA-256 before anything is
 * unpacked. All MIT-licensed. (Microsoft's own .NET debugger, vsdbg, is
 * licensed for Visual Studio and VS Code only, so .NET uses netcoredbg.)
 */
export const DEBUG_DIR = path.join(MB_DIR, "debug");

export interface Pinned {
  name: string;
  version: string;
  url: string;
  /** The publisher's checksum: a SHA-256 hex digest, or an npm/NuGet-style "sha512-<base64>" integrity. */
  sha256?: string;
  integrity?: string;
  /** Unpacked size check: the folder that must exist once installed. */
  marker: string;
}

export const DEBUGPY: Pinned = {
  name: "debugpy",
  version: "1.8.22",
  // the pure-Python wheel works with every project's Python version
  url: "https://files.pythonhosted.org/packages/56/3d/c7dc9f35bc9e22cdb53679f844bee40fd5cff871862f60595869a433400d/debugpy-1.8.22-py2.py3-none-any.whl",
  sha256: "a9e9d3550e15ca479c59333e90845029190531f0cacfedab3b815a57bd913947",
  marker: "debugpy/adapter/__init__.py",
};

export const JS_DEBUG: Pinned = {
  name: "js-debug",
  version: "1.140.0",
  url: "https://github.com/microsoft/vscode-js-debug/releases/download/v1.140.0/js-debug-dap-v1.140.0.tar.gz",
  sha256: "27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968",
  marker: "js-debug/src/dapDebugServer.js",
};

export const NETCOREDBG: Pinned = {
  name: "netcoredbg",
  version: "3.2.0-1092",
  url: "https://github.com/Samsung/netcoredbg/releases/download/3.2.0-1092/netcoredbg-osx-arm64.zip",
  sha256: "f4fa33b3ff874910cc184b4bb3b9c56d0abdf5c6521cee0b144d7c6e4a6e59ea",
  marker: "netcoredbg/netcoredbg",
};

export const installDir = (p: Pinned, root = DEBUG_DIR) => path.join(root, `${p.name}-${p.version}`);

/**
 * Download `url` to `dest`, following redirects. Settles exactly once: an
 * HTTP error, a connection that fails or sits idle for `timeoutMs` (before or
 * during the body), and a failed write all reject.
 */
export function download(url: string, dest: string, opts: { get?: typeof https.get; timeoutMs?: number; redirects?: number } = {}): Promise<void> {
  const { get = https.get, timeoutMs = 60_000, redirects = 5 } = opts;
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = get(url, { headers: { "User-Agent": "Mockingbird" }, timeout: timeoutMs }, resolve);
    req.on("error", reject);
    // the socket's idle timeout; destroying the request also fails a body still arriving
    req.on("timeout", () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
  })
    .then(async (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!redirects) throw new Error("too many redirects");
        return download(new URL(res.headers.location, url).href, dest, { ...opts, redirects: redirects - 1 });
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode}`);
      }
      await pipeline(res, fs.createWriteStream(dest));
    })
    .catch((err: Error) => {
      throw err.message.startsWith("Downloading ") ? err : new Error(`Downloading ${url} failed: ${err.message}`);
    });
}

const run = (cmd: string, args: string[], cwd: string) =>
  new Promise<void>((resolve, reject) =>
    execFile(cmd, args, { cwd, timeout: 120_000 }, (err, _o, stderr) => (err ? reject(new Error(`${path.basename(cmd)}: ${(stderr || err.message).trim()}`)) : resolve()))
  );

/**
 * Make sure an adapter is installed, downloading it if needed; returns its
 * folder. A download whose hash doesn't match is deleted and reported — never
 * unpacked. Installs go to a temp folder and are renamed into place, so a
 * half-finished install is never mistaken for a good one.
 */
export async function ensureAdapter(p: Pinned, onProgress: (msg: string) => void = () => {}, root = DEBUG_DIR): Promise<string> {
  const dir = installDir(p, root);
  if (fs.existsSync(path.join(dir, p.marker))) return dir;
  fs.mkdirSync(root, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(root, `.${p.name}-`));
  try {
    const file = path.join(tmp, path.basename(new URL(p.url).pathname));
    onProgress(`Downloading ${p.name} ${p.version}…`);
    await download(p.url, file);
    const bytes = fs.readFileSync(file);
    const [want, got] = p.sha256
      ? [p.sha256, crypto.createHash("sha256").update(bytes).digest("hex")]
      : p.integrity?.startsWith("sha512-")
        ? [p.integrity, `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`]
        : [null, ""];
    if (!want) throw new Error(`${p.name} ${p.version} has no checksum to check against — not installed`);
    if (got !== want) throw new Error(`${p.name} ${p.version} didn't match its published checksum (got ${got.slice(0, 19)}…) — not installed`);
    onProgress(`Unpacking ${p.name}…`);
    const into = path.join(tmp, "x");
    fs.mkdirSync(into);
    if (file.endsWith(".tar.gz") || file.endsWith(".tgz")) await run("/usr/bin/tar", ["-xzf", file, "-C", into], tmp);
    else await run("/usr/bin/unzip", ["-q", file, "-d", into], tmp);
    if (!fs.existsSync(path.join(into, p.marker))) throw new Error(`${p.name} unpacked without ${p.marker}`);
    // a downloaded binary carries the quarantine flag, which stops it running
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", into], tmp).catch((err) =>
      onProgress(`Couldn't clear macOS's quarantine flag on ${p.name} (${err.message}) — if it won't start, run: xattr -dr com.apple.quarantine ${quote(dir)}`)
    );
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(into, dir);
    return dir;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A running adapter process speaking DAP on its stdio. */
interface StdioAdapter {
  conn: DapConnection;
  dispose(): void;
  stderr(): string;
}

/**
 * Start an adapter in its own process group, ended whole when its connection
 * closes: on a stop, on quitting, and when the adapter exits. A program the
 * adapter launches itself (netcoredbg's dotnet app) is in that group, so it
 * never outlives the adapter; a process the adapter only attaches to is in a
 * group of its own, which this never touches.
 */
export function spawnStdioAdapter(command: string, args: string[], env: Record<string, string>, cwd: string): StdioAdapter {
  const { conn, stderr } = spawnRpcProcess(command, args, { cwd, env, name: "The debug adapter", group: true }, (input, output, onClose) => new DapConnection(input, output, { onClose, closeOnEnd: false }));
  return { conn, dispose: () => conn.close(), stderr };
}
