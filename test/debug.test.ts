import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as pty from "node-pty";
import { PassThrough } from "stream";
import { describe, expect, it } from "vitest";
import { DapConnection, FrameParser, frame } from "../src/main/dap/client";
import { DebugManager } from "../src/main/dap/session";
import { debugTargetFor, inferPython, shellWords } from "../src/main/dap/targets";
import { RunManager, type Spawn } from "../src/main/run";
import { validateProfile } from "../src/main/runProfile";
import { tempDir } from "./helpers";

describe("the DAP wire format", () => {
  it("frames messages and reassembles them however the bytes arrive", () => {
    const a = frame({ seq: 1, type: "event", event: "initialized" });
    const b = frame({ seq: 2, type: "event", event: "output", body: { output: "héllo\n" } });
    const all = Buffer.concat([a, b]);
    const p = new FrameParser();
    const got = [];
    for (let i = 0; i < all.length; i += 7) got.push(...p.push(all.subarray(i, i + 7)));
    expect(got.map((m) => m.event)).toEqual(["initialized", "output"]);
    expect(got[1].body.output).toBe("héllo\n");
  });

  it("matches responses to requests, surfaces failures, and answers the adapter's own requests", async () => {
    const toAdapter = new PassThrough();
    const fromAdapter = new PassThrough();
    const c = new DapConnection(fromAdapter, toAdapter);
    const sent: any[] = [];
    const p = new FrameParser();
    toAdapter.on("data", (d) => sent.push(...p.push(d)));
    const ok = c.request("threads");
    const bad = c.request("evaluate", { expression: "x" });
    await new Promise((r) => setImmediate(r));
    fromAdapter.write(frame({ seq: 9, type: "response", request_seq: sent[1].seq, command: "evaluate", success: false, message: "name 'x' is not defined" }));
    fromAdapter.write(frame({ seq: 10, type: "response", request_seq: sent[0].seq, command: "threads", success: true, body: { threads: [{ id: 1, name: "main" }] } }));
    await expect(ok).resolves.toEqual({ threads: [{ id: 1, name: "main" }] });
    await expect(bad).rejects.toThrow(/not defined/);
    c.reverse = async (cmd, args) => ({ processId: cmd === "runInTerminal" ? args.args.length : 0 });
    fromAdapter.write(frame({ seq: 11, type: "request", command: "runInTerminal", arguments: { args: ["a", "b"] } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.at(-1)).toMatchObject({ type: "response", request_seq: 11, success: true, body: { processId: 2 } });
    const pending = c.request("next", { threadId: 1 });
    fromAdapter.end();
    await expect(pending).rejects.toThrow(/closed the connection/);
  });
});

describe("reading a Python service's command for the debugger", () => {
  it("splits words like a shell", () => {
    expect(shellWords(`a "b c" 'd e' f\\ g ""`)).toEqual(["a", "b c", "d e", "f g", ""]);
  });

  it("finds the venv's Python and the tool, keeps earlier steps, and drops --reload", () => {
    expect(inferPython("PYTHONPATH=. .venv/bin/alembic upgrade head && PYTHONPATH=. .venv/bin/uvicorn app.main:app --reload --port 8010")).toEqual({
      debug: { type: "python", python: ".venv/bin/python", module: "uvicorn", args: ["app.main:app", "--port", "8010"] },
      env: { PYTHONPATH: "." },
      pre: ["PYTHONPATH=. .venv/bin/alembic upgrade head"],
      droppedReload: true,
    });
    expect(inferPython("python3 -m http.server 8000")?.debug).toMatchObject({ python: "python3", module: "http.server", args: ["8000"] });
    expect(inferPython("venv/bin/python manage.py runserver")?.debug).toMatchObject({ python: "venv/bin/python", program: "manage.py", args: ["runserver"] });
    expect(inferPython("npm run dev")).toBeNull();
  });
});

// the real adapter, cached between test runs so it's downloaded once
const cache = path.join(os.tmpdir(), "mockingbird-test-debug-cache");

describe("debugging a real Python program", () => {
  it("stops at a breakpoint, shows locals, evaluates, steps, and runs to the end", async () => {
    const dir = fs.realpathSync(tempDir("dbg-py"));
    fs.writeFileSync(
      path.join(dir, "app.py"),
      ["def add(a, b):", "    total = a + b", "    return total", "", 'print("result", add(2, 3), flush=True)', ""].join("\n")
    );
    const events: any[] = [];
    const dbg = new DebugManager({ emit: (ch, ...args) => events.push([ch, ...args]), breakpointsDir: path.join(dir, ".bp") });
    await dbg.setBreakpoints(dir, "app.py", [2]);
    const spawn: Spawn = (command, o) => pty.spawn("/bin/sh", ["-c", command], { name: "xterm-256color", cols: 120, rows: 30, cwd: o.cwd, env: o.env });
    const profile = validateProfile({ services: [{ name: "app", command: "python3 app.py" }] }, dir);
    const runs = new RunManager({
      spawn,
      emit: (ch, ...args) => events.push([ch, ...args]),
      baseEnv: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir }),
      docker: async () => "docker",
      runShell: async () => ({ code: 0, out: "" }),
      profileFor: () => profile,
      mainOf: async () => dir,
      debugger: dbg,
      debugTarget: (s, ctx) => debugTargetFor(s, { ...ctx, debugRoot: cache }),
    });

    const stoppedAt = async () => {
      for (let i = 0; i < 200; i++) {
        const e = events.filter((x) => x[0] === "debug:stopped").pop();
        if (e && !e.seen) {
          e.seen = true;
          return e[2];
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`never stopped: ${JSON.stringify(events.filter((x) => x[0] === "debug:output").map((x) => x[3]))}`);
    };

    const r = (await runs.start(dir, { mode: "side", debug: ["app"] })) as { ids: string[] };
    const sessionId = runs.states()[0].debug!;
    expect(sessionId).toMatch(/^dbg-/);
    const first = await stoppedAt();
    expect(first.frame).toMatchObject({ path: path.join(dir, "app.py"), line: 2, name: "add" });

    const scopes = await dbg.scopes(sessionId, first.frame.id);
    const locals = await dbg.variables(sessionId, scopes[0].ref);
    expect(locals.filter((v) => ["a", "b"].includes(v.name)).map((v) => `${v.name}=${v.value}`)).toEqual(["a=2", "b=3"]);
    expect((await dbg.evaluate(sessionId, "a * 10 + b", first.frame.id, "repl")).result).toBe("23");

    await dbg.control(sessionId, "next", first.threadId);
    const second = await stoppedAt();
    expect(second.frame.line).toBe(3);
    const after = await dbg.variables(sessionId, (await dbg.scopes(sessionId, second.frame.id))[0].ref);
    expect(after.find((v) => v.name === "total")?.value).toBe("5");

    await dbg.control(sessionId, "continue", second.threadId);
    for (let i = 0; i < 100 && runs.states()[0].status !== "stopped"; i++) await new Promise((res) => setTimeout(res, 100));
    expect(runs.states()[0].status).toBe("stopped");
    expect(runs.buffer(r.ids[0])).toContain("result 5"); // the program's own output is in its log, like any service
  }, 120_000);
});

describe("reading a Node service's command for the debugger", () => {
  it("debugs a dev server's page in the browser, and other Node programs under Node", async () => {
    const { inferNode } = await import("../src/main/dap/targets");
    const vite = tempDir("vite-app");
    fs.writeFileSync(path.join(vite, "vite.config.ts"), "export default {}");
    expect(inferNode("npm run dev -- --port 5183 --strictPort", vite, "http://localhost:5183")).toEqual({ type: "chrome", url: "http://localhost:5183" });
    expect(inferNode("npx vite --port 5173", tempDir("x"), "http://localhost:5173")).toEqual({ type: "chrome", url: "http://localhost:5173" });
    expect(inferNode("node src/app.js --flag", tempDir("y"), undefined)).toEqual({ type: "node", program: "src/app.js", args: ["--flag"] });
    expect(inferNode("PORT=3000 npm run dev", tempDir("z"), undefined)).toEqual({ type: "node", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"] });
    expect(inferNode("dotnet run", tempDir("w"), undefined)).toBeNull();
    expect(inferNode('node -e "console.log(1)"', tempDir("v"), undefined)).toEqual({ type: "node", runtimeExecutable: "node", runtimeArgs: ["-e", "console.log(1)"] });
  });
});

describe("debugging real JavaScript", () => {
  const debugRun = (dir: string, profile: any, events: any[], extra: object = {}) => {
    const dbg = new DebugManager({ emit: (ch, ...a) => events.push([ch, ...a]), breakpointsDir: path.join(dir, ".bp") });
    const spawn: Spawn = (command, o) => pty.spawn("/bin/sh", ["-c", command], { name: "xterm-256color", cols: 120, rows: 30, cwd: o.cwd, env: o.env });
    const runs = new RunManager({
      spawn,
      emit: (ch, ...a) => events.push([ch, ...a]),
      baseEnv: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir }),
      docker: async () => "docker",
      runShell: async () => ({ code: 0, out: "" }),
      profileFor: () => validateProfile(profile, dir),
      mainOf: async () => dir,
      debugger: dbg,
      debugTarget: (s, ctx) => debugTargetFor(s, { ...ctx, debugRoot: cache, ...extra }),
    });
    return { dbg, runs };
  };
  const stopped = async (events: any[]) => {
    for (let i = 0; i < 300; i++) {
      const e = events.find((x) => x[0] === "debug:stopped" && !x.seen);
      if (e) {
        e.seen = true;
        return e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`never stopped: ${JSON.stringify(events.filter((x) => x[0] === "debug:output").map((x) => x[3])).slice(0, 600)}`);
  };

  it("stops a Node program at a breakpoint and reads its variables", async () => {
    const dir = fs.realpathSync(tempDir("dbg-node"));
    fs.writeFileSync(path.join(dir, "app.js"), ["function add(a, b) {", "  const total = a + b;", "  return total;", "}", 'console.log("sum", add(4, 5));', ""].join("\n"));
    const events: any[] = [];
    const { dbg, runs } = debugRun(dir, { services: [{ name: "app", command: "node app.js" }] }, events);
    await dbg.setBreakpoints(dir, "app.js", [2]);
    const r = (await runs.start(dir, { mode: "side", debug: ["app"] })) as { ids: string[] };
    const e = await stopped(events);
    expect(e[2].frame).toMatchObject({ path: path.join(dir, "app.js"), line: 2, name: expect.stringMatching(/add$/) });
    const locals = await dbg.variables(e[1], (await dbg.scopes(e[1], e[2].frame.id))[0].ref);
    expect(locals.filter((v) => ["a", "b"].includes(v.name)).map((v) => `${v.name}=${v.value}`).sort()).toEqual(["a=4", "b=5"]);
    await dbg.control(e[1], "continue", e[2].threadId);
    const plain = () => runs.buffer(r.ids[0]).replace(/\x1b\[[0-9;]*m/g, ""); // node colours the 9
    for (let i = 0; i < 100 && !plain().includes("sum 9"); i++) await new Promise((res) => setTimeout(res, 100));
    expect(plain()).toContain("sum 9");
    await runs.stopAll();
    await dbg.stopAll();
  }, 120_000);

  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  it.skipIf(!fs.existsSync(chrome))("opens a dev server's page in Chrome and stops at a breakpoint in its script", async () => {
    const dir = fs.realpathSync(tempDir("dbg-web"));
    fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><html><body><script src="main.js"></script></body></html>');
    fs.writeFileSync(path.join(dir, "main.js"), ["function greet(name) {", "  const message = 'hello ' + name;", "  document.title = message;", "}", "setTimeout(() => greet('mockingbird'), 500);", ""].join("\n"));
    const server = `node -e "const fs=require('fs'),p=require('path');require('http').createServer((q,s)=>{const f=p.join(process.cwd(),q.url==='/'?'index.html':q.url);fs.readFile(f,(e,d)=>{s.writeHead(e?404:200,{'Content-Type':f.endsWith('.js')?'text/javascript':'text/html'});s.end(d)})}).listen(\${port:web})"`;
    const events: any[] = [];
    const { dbg, runs } = debugRun(
      dir,
      { services: [{ name: "web", command: server, ports: [{ name: "web", base: 47410, url: "http://localhost:${port}/" }], ready: { port: "web" }, debug: { type: "chrome", url: "http://localhost:${port:web}/" } }] },
      events,
      { browserArgs: ["--headless=new", "--use-mock-keychain", "--password-store=basic"] }
    );
    await dbg.setBreakpoints(dir, "main.js", [2]);
    try {
      await runs.start(dir, { mode: "side", debug: ["web"] });
      const e = await stopped(events);
      expect(e[2].frame).toMatchObject({ line: 2, name: expect.stringMatching(/greet$/) });
      expect(e[2].frame.path).toBe(path.join(dir, "main.js")); // mapped back to the file on disk
      const r = await dbg.evaluate(e[1], "name.toUpperCase()", e[2].frame.id, "repl");
      expect(r.result).toContain("MOCKINGBIRD");
    } finally {
      // a failed run must not leave a headless Chrome behind
      await runs.stopAll();
      await dbg.stopAll();
    }
  }, 120_000);
});
