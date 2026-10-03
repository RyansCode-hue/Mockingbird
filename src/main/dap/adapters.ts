import { execFile, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
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
  sha256: string;
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

function download(url: string, dest: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "Mockingbird" }, timeout: 60_000 }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (!redirects) return reject(new Error(`Too many redirects downloading ${url}`));
          return download(res.headers.location, dest, redirects - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Downloading ${url} failed: HTTP ${res.statusCode}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
      })
      .on("error", reject)
      .on("timeout", function (this: any) {
        this.destroy(new Error(`Downloading ${url} timed out`));
      });
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
    const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (hash !== p.sha256) throw new Error(`${p.name} ${p.version} didn't match its published checksum (got ${hash.slice(0, 12)}…) — not installed`);
    onProgress(`Unpacking ${p.name}…`);
    const into = path.join(tmp, "x");
    fs.mkdirSync(into);
    if (file.endsWith(".tar.gz")) await run("/usr/bin/tar", ["-xzf", file, "-C", into], tmp);
    else await run("/usr/bin/unzip", ["-q", file, "-d", into], tmp);
    if (!fs.existsSync(path.join(into, p.marker))) throw new Error(`${p.name} unpacked without ${p.marker}`);
    // a downloaded binary carries the quarantine flag, which stops it running
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", into], tmp).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(into, dir);
    return dir;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A running adapter process speaking DAP on its stdio. */
export interface StdioAdapter {
  conn: DapConnection;
  dispose(): void;
  stderr(): string;
}

export function spawnStdioAdapter(command: string, args: string[], env: Record<string, string>, cwd: string): StdioAdapter {
  const proc = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => (err = (err + d).slice(-8000)));
  const conn = new DapConnection(proc.stdout, proc.stdin, () => {
    if (proc.exitCode === null) proc.kill();
  });
  proc.on("error", (e) => conn.close(`The debug adapter didn't start: ${e.message}`));
  proc.on("exit", (code) => conn.close(code ? `The debug adapter exited with code ${code}${err ? `: ${err.trim().split("\n").pop()}` : ""}` : "The debug adapter exited"));
  return { conn, dispose: () => conn.close(), stderr: () => err };
}
