import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { DEBUG_DIR, DEBUGPY, JS_DEBUG, ensureAdapter, spawnStdioAdapter } from "./adapters";
import { connectTcp } from "./client";
import type { Connection } from "./session";
import type { RunDebug } from "../../shared/types";

/** What it takes to debug one service: the adapter to talk to and the configuration to launch. */
export interface DebugTarget {
  /**
   * "terminal": the debugger starts the program, on the service's terminal
   * (runInTerminal). "alongside": the service runs as usual and the debugger
   * attaches beside it — a browser opened on a dev server's page.
   */
  kind: "terminal" | "alongside";
  adapterID: string;
  connect: () => Promise<Connection>;
  config: Record<string, unknown> & { request: "launch" | "attach" };
  /** Shell steps that run before the program, in the same terminal (e.g. migrations). */
  pre: string[];
  /** Things the user should know about how this run differs from a plain run. */
  notes: string[];
}

/** Split a shell command into words, honouring quotes (enough for the commands run setups use). */
export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else if (c === "\\" && i + 1 < cmd.length) cur += cmd[++i];
    else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/**
 * Read a Python service's command as something debugpy can launch: the last
 * `&&` step is the program (earlier steps run first, unchanged), leading
 * VAR=value words become environment, `<venv>/bin/<tool>` means that venv's
 * Python running the tool as a module, and `--reload` is dropped — a reloader
 * restarts the process the debugger is attached to.
 */
export function inferPython(command: string): { debug: Extract<RunDebug, { type: "python" }>; env: Record<string, string>; pre: string[]; droppedReload: boolean } | null {
  const steps = command.split(/\s*&&\s*/);
  const last = steps.pop()!;
  const words = shellWords(last);
  const env: Record<string, string> = {};
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const w = words.shift()!;
    env[w.slice(0, w.indexOf("="))] = w.slice(w.indexOf("=") + 1);
  }
  const exe = words.shift();
  if (!exe) return null;
  const base = path.basename(exe);
  let python: string;
  let module: string | undefined;
  let program: string | undefined;
  if (/^python(3(\.\d+)?)?$/.test(base)) {
    python = exe;
    if (words[0] === "-m" && words[1]) {
      module = words[1];
      words.splice(0, 2);
    } else if (words[0] && !words[0].startsWith("-")) program = words.shift();
    else return null;
  } else if (["uvicorn", "flask", "fastapi", "pytest", "celery", "hypercorn", "dramatiq"].includes(base)) {
    python = exe.includes("/") ? path.join(path.dirname(exe), "python") : "python3";
    module = base;
  } else return null;
  const droppedReload = words.includes("--reload");
  const args = words.filter((w) => w !== "--reload");
  return { debug: { type: "python", python, ...(module ? { module } : {}), ...(program ? { program } : {}), args }, env, pre: steps, droppedReload };
}

/**
 * The debug target for a service: its explicit `debug` setup, or one read from
 * its command. `cwd` and `env` are the service's own (placeholders already
 * filled in); `command` is its expanded command.
 */
export async function debugTargetFor(
  service: { name: string; debug?: RunDebug },
  ctx: {
    cwd: string;
    env: Record<string, string>;
    command: string;
    expand: (s: string) => string;
    /** The service's page, when it serves one (for browser debugging). */
    url?: string;
    onProgress?: (msg: string) => void;
    debugRoot?: string;
    /** Extra browser flags (tests run Chrome headless). */
    browserArgs?: string[];
  }
): Promise<DebugTarget> {
  let debug = service.debug;
  let pre: string[] = [];
  const notes: string[] = [];
  const env = { ...ctx.env };
  if (!debug) {
    const py = inferPython(ctx.command);
    if (py) {
      debug = py.debug;
      pre = py.pre;
      Object.assign(env, py.env);
      if (py.droppedReload) notes.push("--reload is off while debugging: a reloader restarts the process the debugger is attached to. Restart to pick up changes.");
      if (pre.length) notes.push(`These run first, in the same terminal: ${pre.join(" && ")}`);
    } else {
      const js = inferNode(ctx.command, ctx.cwd, ctx.url);
      if (!js) throw new Error(`Mockingbird can't tell how to debug ${service.name} from its command — add a "debug" section to its run setup`);
      debug = js;
      // a node program runs only the last && step under the debugger; earlier steps run first
      const steps = ctx.command.split(/\s*&&\s*/);
      if (js.type === "node" && steps.length > 1) pre = steps.slice(0, -1);
    }
  }
  if (debug.type === "python") {
    const pythonRel = debug.python ? ctx.expand(debug.python) : "python3";
    const python = pythonRel.includes("/") ? path.resolve(ctx.cwd, pythonRel) : pythonRel;
    if (python.includes("/") && !fs.existsSync(python)) {
      throw new Error(`${service.name}: Python isn't at ${pythonRel} in this worktree — run Prepare to create the virtualenv`);
    }
    const dir = await ensureAdapter(DEBUGPY, ctx.onProgress, ctx.debugRoot);
    return {
      kind: "terminal",
      adapterID: "debugpy",
      connect: async () => spawnStdioAdapter(python, ["-m", "debugpy.adapter"], { ...process.env, ...env, PYTHONPATH: dir } as Record<string, string>, ctx.cwd),
      config: {
        request: "launch",
        type: "debugpy",
        name: service.name,
        python: [python],
        ...(debug.module ? { module: debug.module } : {}),
        ...(debug.program ? { program: path.resolve(ctx.cwd, ctx.expand(debug.program)) } : {}),
        args: (debug.args ?? []).map(ctx.expand),
        cwd: ctx.cwd,
        env,
        console: "integratedTerminal",
        justMyCode: debug.justMyCode ?? true,
        subProcess: true,
        showReturnValue: true,
      },
      pre,
      notes,
    };
  }
  if (debug.type === "node" || debug.type === "chrome") {
    const dir = await ensureAdapter(JS_DEBUG, ctx.onProgress, ctx.debugRoot);
    const connect = jsDebugConnector(dir);
    const resolveSourceMapLocations = ["**", "!**/node_modules/**"];
    if (debug.type === "chrome") {
      const url = ctx.expand(debug.url);
      const profile = path.join(ctx.debugRoot ?? DEBUG_DIR, "chrome-profiles", crypto.createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 10));
      return {
        kind: "alongside",
        adapterID: "pwa-chrome",
        connect,
        config: {
          request: "launch",
          type: "pwa-chrome",
          name: `${service.name} (browser)`,
          url,
          webRoot: debug.webRoot ? path.resolve(ctx.cwd, ctx.expand(debug.webRoot)) : ctx.cwd,
          // each worktree gets its own Chrome profile: separate sign-ins, no clash with your everyday browser
          userDataDir: profile,
          sourceMaps: true,
          resolveSourceMapLocations,
          ...(ctx.browserArgs ? { runtimeArgs: ctx.browserArgs } : {}),
        },
        pre,
        notes: [...notes, `Opens ${url} in a separate Chrome window for this worktree.`],
      };
    }
    return {
      kind: "terminal",
      adapterID: "pwa-node",
      connect,
      config: {
        request: "launch",
        type: "pwa-node",
        name: service.name,
        ...(debug.program ? { program: path.resolve(ctx.cwd, ctx.expand(debug.program)) } : {}),
        ...(debug.runtimeExecutable ? { runtimeExecutable: ctx.expand(debug.runtimeExecutable) } : {}),
        ...(debug.runtimeArgs ? { runtimeArgs: debug.runtimeArgs.map(ctx.expand) } : {}),
        args: (debug.args ?? []).map(ctx.expand),
        cwd: ctx.cwd,
        env,
        console: "integratedTerminal",
        autoAttachChildProcesses: true,
        skipFiles: ["<node_internals>/**"],
        resolveSourceMapLocations,
      },
      pre,
      notes,
    };
  }
  throw new Error(`Debugging "${debug.type}" services is coming in the next stage of Run and Debug`);
}

/** A free TCP port on loopback. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * js-debug runs as a DAP server; every session — the first, and each child
 * target it announces with startDebugging — is its own connection to it. The
 * server is started on the first connect (with Electron's own Node) and
 * stopped when that first session ends.
 */
function jsDebugConnector(dir: string): () => Promise<Connection> {
  let server: Promise<{ port: number; kill: () => void; stderr: () => string }> | null = null;
  let first = true;
  const start = async () => {
    const port = await freePort();
    const proc = spawn(process.execPath, [path.join(dir, "js-debug", "src", "dapDebugServer.js"), String(port), "127.0.0.1"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    proc.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    return { port, kill: () => proc.exitCode === null && proc.kill(), stderr: () => err };
  };
  return async () => {
    server ??= start();
    const { port, kill, stderr } = await server;
    const conn = await connectTcp(port);
    const owner = first;
    first = false;
    return {
      conn,
      stderr,
      dispose: () => {
        conn.close();
        if (owner) kill();
      },
    };
  };
}

const FRONTEND = /(^|\/)(vite|next|react-scripts|ng|nuxt|astro|svelte-kit|webpack-dev-server)$/;

/**
 * Read a Node service's command for js-debug: a dev server for a browser app
 * (Vite, Next, CRA…) is debugged in the browser at its URL; anything else runs
 * under Node — `node file`, or a package-manager script with its children followed.
 */
export function inferNode(command: string, cwd: string, url: string | undefined): RunDebug | null {
  const steps = command.split(/\s*&&\s*/);
  const words = shellWords(steps[steps.length - 1]);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const exe = words[0];
  if (!exe) return null;
  const base = path.basename(exe);
  const isFrontend =
    words.some((w) => FRONTEND.test(w)) ||
    (["npm", "pnpm", "yarn", "bun"].includes(base) && ["vite.config.ts", "vite.config.js", "vite.config.mjs", "next.config.js", "next.config.mjs", "next.config.ts", "angular.json"].some((f) => fs.existsSync(path.join(cwd, f))));
  if (isFrontend) return url ? { type: "chrome", url } : null;
  if (base === "node") return words[1] && !words[1].startsWith("-") ? { type: "node", program: words[1], args: words.slice(2) } : { type: "node", runtimeExecutable: exe, runtimeArgs: words.slice(1) };
  if (["npm", "pnpm", "yarn", "bun", "npx", "nodemon", "tsx", "ts-node"].includes(base)) return { type: "node", runtimeExecutable: exe, runtimeArgs: words.slice(1) };
  return null;
}
