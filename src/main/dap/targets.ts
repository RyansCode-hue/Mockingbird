import * as fs from "fs";
import * as path from "path";
import { DEBUGPY, ensureAdapter, spawnStdioAdapter } from "./adapters";
import type { Connection } from "./session";
import type { RunDebug } from "../../shared/types";

/** What it takes to debug one service: the adapter to talk to and the configuration to launch. */
export interface DebugTarget {
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
  ctx: { cwd: string; env: Record<string, string>; command: string; expand: (s: string) => string; onProgress?: (msg: string) => void; debugRoot?: string }
): Promise<DebugTarget> {
  let debug = service.debug;
  let pre: string[] = [];
  const notes: string[] = [];
  const env = { ...ctx.env };
  if (!debug) {
    const inferred = inferPython(ctx.command);
    if (!inferred) throw new Error(`Mockingbird can't tell how to debug ${service.name} from its command — add a "debug" section to its run setup`);
    debug = inferred.debug;
    pre = inferred.pre;
    Object.assign(env, inferred.env);
    if (inferred.droppedReload) notes.push("--reload is off while debugging: a reloader restarts the process the debugger is attached to. Restart to pick up changes.");
    if (pre.length) notes.push(`These run first, in the same terminal: ${pre.join(" && ")}`);
  }
  if (debug.type === "python") {
    const pythonRel = debug.python ? ctx.expand(debug.python) : "python3";
    const python = pythonRel.includes("/") ? path.resolve(ctx.cwd, pythonRel) : pythonRel;
    if (python.includes("/") && !fs.existsSync(python)) {
      throw new Error(`${service.name}: Python isn't at ${pythonRel} in this worktree — run Prepare to create the virtualenv`);
    }
    const dir = await ensureAdapter(DEBUGPY, ctx.onProgress, ctx.debugRoot);
    return {
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
  throw new Error(`Debugging "${debug.type}" services is coming in the next stage of Run and Debug`);
}
