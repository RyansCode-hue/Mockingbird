import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as pty from "node-pty";
import { describe, expect, it } from "vitest";
import { buildOverride, composeConfig, composeProject } from "../src/main/composeOverride";
import { RunManager, type RunProc, type Spawn } from "../src/main/run";
import { expand, loadProfile, mainCheckout, parseEnvFile, saveProfile, slotPorts, startOrder, validateProfile } from "../src/main/runProfile";
import type { RunProfile } from "../src/shared/types";
import { git, makeRepo, tempDir } from "./helpers";

const web = (extra: Partial<RunProfile> = {}): RunProfile =>
  validateProfile(
    {
      services: [
        { name: "api", cwd: "backend", command: "uvicorn app:app --port ${port:api}", ports: [{ name: "api", base: 8000, url: "http://localhost:${port:api}/docs" }], ready: { port: "api" } },
        { name: "web", cwd: "frontend", command: "vite --port ${port:web}", env: { API_URL: "http://localhost:${port:api}" }, ports: [{ name: "web", base: 5173, url: "http://localhost:${port}" }], dependsOn: ["api"] },
      ],
      ...extra,
    },
    "/repo"
  );

describe("run profiles", () => {
  it("accept a sensible setup and fill in ports per slot", () => {
    const p = web();
    expect(slotPorts(p, 0)).toEqual(new Map([["api", 8000], ["web", 5173]]));
    expect(slotPorts(p, 2)).toEqual(new Map([["api", 8020], ["web", 5193]]));
    const ctx = { ports: slotPorts(p, 1), slot: 1, worktree: "/wt" };
    expect(expand("vite --port ${port:web} # ${slot} ${worktree}", ctx)).toBe("vite --port 5183 # 1 /wt");
    expect(() => expand("${port:nope}", ctx)).toThrow(/names a port no service defines/);
  });

  it("start dependencies first and refuse loops", () => {
    expect(startOrder(web().services).map((s) => s.name)).toEqual(["api", "web"]);
    expect(() =>
      validateProfile({ services: [{ name: "a", command: "x", dependsOn: ["b"] }, { name: "b", command: "y", dependsOn: ["a"] }] }, "/r")
    ).toThrow(/loop \(a → b → a\)|loop \(b → a → b\)/);
  });

  it("say exactly what's wrong with a bad setup", () => {
    expect(() => validateProfile({ services: [] }, "/r")).toThrow(/services must list at least one/);
    expect(() => validateProfile({ services: [{ name: "a b", command: "x" }] }, "/r")).toThrow(/services\[0\]\.name/);
    expect(() => validateProfile({ services: [{ name: "a", command: "x", cwd: "../elsewhere" }] }, "/r")).toThrow(/inside the repository/);
    expect(() => validateProfile({ services: [{ name: "a", command: "x", ports: [{ name: "p", base: 70000 }] }] }, "/r")).toThrow(/base port/);
    expect(() => validateProfile({ services: [{ name: "a", command: "x", dependsOn: ["ghost"] }] }, "/r")).toThrow(/"ghost"/);
    expect(() => validateProfile({ services: [{ name: "a", kind: "compose" }] }, "/r")).toThrow(/compose\.file/);
    expect(() => validateProfile({ services: [{ name: "a", command: "x" }], prepare: { copy: ["/etc/passwd"] } }, "/r")).toThrow(/inside the repository/);
  });

  it("are saved per main checkout and shared by its worktrees", async () => {
    const repo = makeRepo();
    const wt = path.join(tempDir("wt"), "w");
    git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    expect(await mainCheckout(wt)).toBe(fs.realpathSync(repo));
    expect(await mainCheckout(repo)).toBe(fs.realpathSync(repo));
    const main = await mainCheckout(wt);
    saveProfile({ services: [{ name: "a", command: "echo" }] }, main);
    expect(loadProfile(main)?.services[0].name).toBe("a");
    expect(loadProfile("/nowhere")).toBeNull();
  });

  it("read env files the way shells and dotenv write them", () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x y\'\nD=plain # note\n\nbad line\n')).toEqual({ A: "1", B: "two words", C: "x y", D: "plain" });
  });
});

describe("compose overrides", () => {
  const config = {
    services: {
      app: {
        container_name: "atticus-snipper-app",
        env_file: [{ path: "/Users/me/Code/snip/infra/etc/app-loc.env" }],
        ports: [{ target: 8080, published: "58080", protocol: "tcp" }, { target: 9, protocol: "tcp" }],
        volumes: [
          { type: "bind", source: "/Users/me/Code/snip/src/app-svr", target: "/home/app" },
          { type: "bind", source: "/Users/me/elsewhere", target: "/x" },
          { type: "volume", source: "data", target: "/data" },
        ],
      },
      red: { container_name: "atticus-snipper-red" },
    },
    volumes: { data: { name: "mb-snip-s1_data" }, pg: { name: "onesheet-pgdata" }, ext: { name: "shared", external: true } },
  };
  const opts = { main: "/Users/me/Code/snip", worktree: "/Users/me/Code/worktrees/snip/feat", project: "mb-snip-s1", step: 10 };

  it("point a worktree's mounts and env files at the worktree, even in slot 0", () => {
    const y = buildOverride(config, { ...opts, slot: 0 });
    expect(y).toContain('"source":"/Users/me/Code/worktrees/snip/feat/src/app-svr"');
    expect(y).toContain('"source":"/Users/me/elsewhere"');
    expect(y).toContain('"env_file": !override [{"path":"/Users/me/Code/worktrees/snip/feat/infra/etc/app-loc.env"}]');
    expect(y).not.toContain("container_name");
    expect(y).not.toContain('"ports"');
  });

  it("give side-by-side slots their own container names, ports and named volumes", () => {
    const y = buildOverride(config, { ...opts, slot: 1 });
    expect(y).toContain('"container_name": "atticus-snipper-app-s1"');
    expect(y).toContain('"container_name": "atticus-snipper-red-s1"');
    expect(y).toContain('"published":"58090"');
    expect(y).toContain('"pg":\n    "name": "onesheet-pgdata-s1"');
    expect(y).not.toContain("mb-snip-s1_data-s1"); // the project already scopes default volume names
    expect(y).not.toContain('"shared-s1"'); // external volumes are the user's
  });

  it("change nothing for the main checkout in slot 0", () => {
    expect(buildOverride(config, { ...opts, worktree: opts.main, slot: 0 })).toBe('"services":\n  {}\n');
  });

  it("name compose projects per repo and slot", () => {
    expect(composeProject("/Users/me/Code/Atticus Snipper", 2)).toBe("mb-atticus-snipper-s2");
  });

  // Docker Desktop keeps the compose plugin under the real home's ~/.docker; tests run with a throwaway HOME
  const dockerEnv = { ...process.env, DOCKER_CONFIG: path.join(os.userInfo().homedir, ".docker") };
  const hasDocker = (() => {
    try {
      execFileSync("docker", ["compose", "version"], { stdio: "ignore", env: dockerEnv });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasDocker)("are accepted by Docker Compose itself", async () => {
    const main = tempDir("compose-main");
    const wt = tempDir("compose-wt");
    for (const root of [main, wt]) {
      fs.mkdirSync(path.join(root, "etc"), { recursive: true });
      fs.writeFileSync(path.join(root, "etc", "app.env"), "SECRET=never-read\n");
    }
    fs.writeFileSync(
      path.join(main, "compose.yaml"),
      `services:\n  app:\n    image: alpine\n    container_name: fixed-app\n    env_file: ${main}/etc/app.env\n    ports: ["58080:8080"]\n    volumes: ["${main}/etc:/cfg"]\n`
    );
    const project = "mb-test-s1";
    const cfg = await composeConfig("docker", { cwd: main, file: "compose.yaml", project, env: dockerEnv });
    expect(JSON.stringify(cfg)).not.toContain("never-read"); // env files stay paths
    const override = path.join(main, "override.yml");
    fs.writeFileSync(override, buildOverride(cfg, { main: [fs.realpathSync(main), main], worktree: fs.realpathSync(wt), slot: 1, step: 10, project }));
    const merged = JSON.parse(
      execFileSync("docker", ["compose", "-p", project, "-f", "compose.yaml", "-f", override, "config", "--format", "json", "--no-env-resolution"], { cwd: main, encoding: "utf8", env: dockerEnv })
    ).services.app;
    expect(merged.container_name).toBe("fixed-app-s1");
    expect(merged.ports.map((p: any) => p.published)).toEqual(["58090"]);
    expect(merged.volumes[0].source).toBe(path.join(fs.realpathSync(wt), "etc"));
    expect(merged.env_file[0].path).toBe(path.join(fs.realpathSync(wt), "etc", "app.env"));
  });
});

/** A fake terminal process: records how it was started, exits when signalled. */
function fakeSpawner() {
  const procs: { command: string; cwd: string; env: Record<string, string>; proc: RunProc; exit: (code: number) => void; data: (d: string) => void }[] = [];
  let pid = 1000;
  const spawn: Spawn = (command, opts) => {
    let onExit: (e: { exitCode: number }) => void = () => {};
    let onData: (d: string) => void = () => {};
    const proc: RunProc = { pid: ++pid, onData: (cb) => (onData = cb), onExit: (cb) => (onExit = cb), write: () => {}, resize: () => {} };
    procs.push({ command, ...opts, proc, exit: (code) => onExit({ exitCode: code }), data: (d) => onData(d) });
    return proc;
  };
  return { procs, spawn };
}

function manager(profile: RunProfile, extra: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) {
  const f = fakeSpawner();
  const busy = new Set<number>();
  const killed: [number, string][] = [];
  const m = new RunManager({
    spawn: f.spawn,
    emit: () => {},
    baseEnv: () => ({ PATH: "/usr/bin" }),
    docker: async () => "docker",
    runShell: async () => ({ code: 0, out: "" }),
    inUse: async (port) => busy.has(port),
    listeners: async (port) => (busy.has(port) ? [{ pid: 4242, command: "python" }] : []),
    kill: (pid, sig) => {
      killed.push([pid, sig]);
      const p = f.procs.find((x) => x.proc.pid === -pid);
      if (p) p.exit(143);
    },
    profileFor: () => profile,
    mainOf: async () => "/repo",
    readyTimeoutMs: 2000,
    ...extra,
  });
  return { m, ...f, busy, killed };
}

describe("running a worktree's services", () => {
  it("starts dependencies first, waits for them, and fills in ports and env", async () => {
    const t = manager(web());
    const run = t.m.start("/wt/a", { mode: "swap" });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.procs.map((p) => p.command)).toEqual(["uvicorn app:app --port 8000"]); // web waits for api's port
    t.busy.add(8000);
    const r = await run;
    expect(r).toMatchObject({ slot: 0, started: ["api", "web"] });
    expect(t.procs[1].command).toBe("vite --port 5173");
    expect(t.procs[1].cwd).toBe("/wt/a/frontend");
    expect(t.procs[1].env).toMatchObject({ API_URL: "http://localhost:8000", PATH: "/usr/bin", MOCKINGBIRD_RUN: "web" });
    expect(t.m.states().find((s) => s.service === "web")?.ports).toEqual([{ name: "web", port: 5173, url: "http://localhost:5173" }]);
    expect(t.m.states().find((s) => s.service === "api")?.ports[0].url).toBe("http://localhost:8000/docs");
  });

  it("reports a port someone else holds instead of taking it, and only stops what it reported", async () => {
    const t = manager(validateProfile({ services: [{ name: "api", command: "x", ports: [{ name: "api", base: 8000 }] }] }, "/repo"));
    t.busy.add(8000);
    expect(await t.m.start("/wt/a", { mode: "swap" })).toEqual({ slot: 0, blocked: [{ port: 8000, service: "api", pid: 4242, command: "python" }] });
    expect(t.procs).toHaveLength(0);
    expect(() => t.m.stopListeners("/wt/a", [1])).toThrow(/wasn't one reported/);
    t.m.stopListeners("/wt/a", [4242]);
    expect(t.killed).toEqual([[4242, "SIGTERM"]]);
  });

  it("swap mode stops the other worktree first; side by side gives each its own slot", async () => {
    const p = validateProfile({ services: [{ name: "api", command: "serve ${port:api}", ports: [{ name: "api", base: 8000 }] }] }, "/repo");
    const t = manager(p);
    await t.m.start("/wt/a", { mode: "swap" });
    await t.m.start("/wt/b", { mode: "swap" });
    expect(t.killed).toContainEqual([-t.procs[0].proc.pid, "SIGTERM"]); // a's whole process group
    expect(t.m.states().filter((s) => s.status === "running").map((s) => [s.worktree, s.slot])).toEqual([["/wt/b", 0]]);

    const r = await t.m.start("/wt/c", { mode: "side" });
    expect(r).toMatchObject({ slot: 1, started: ["api"] });
    expect(t.procs.at(-1)!.command).toBe("serve 8010");
    expect((await t.m.start("/wt/d", { mode: "side" })) as any).toMatchObject({ slot: 2 });
  });

  it("marks a service that exits on its own as failed, and doesn't start what depends on it", async () => {
    const t = manager(web());
    const run = t.m.start("/wt/a", { mode: "swap" });
    await new Promise((r) => setTimeout(r, 50));
    t.procs[0].exit(1);
    expect(await run).toMatchObject({ slot: 0, started: ["api"] });
    expect(t.m.states()[0]).toMatchObject({ status: "failed", exitCode: 1, error: "Exited with code 1" });
    expect(t.procs).toHaveLength(1);
  });

  it("stops dependents along with what they depend on", async () => {
    const t = manager(web());
    const run = t.m.start("/wt/a", { mode: "swap" });
    await new Promise((r) => setTimeout(r, 50));
    t.busy.add(8000);
    await run;
    await t.m.stop("/wt/a", ["api"]);
    expect(t.m.states().map((s) => s.status)).toEqual(["stopped", "stopped"]);
    expect(t.killed.map(([pid]) => -pid)).toEqual([t.procs[1].proc.pid, t.procs[0].proc.pid]); // web, then api
  });

  it("stops a service by its id, for a log whose session has closed", async () => {
    const t = manager(validateProfile({ services: [{ name: "api", command: "x" }] }, "/repo"));
    const r = (await t.m.start("/wt/a", { mode: "swap" })) as { ids: string[] };
    await t.m.stopById(r.ids[0]);
    expect(t.m.states()[0].status).toBe("stopped");
    await expect(t.m.stopById("nope")).rejects.toThrow(/isn't known/);
  });

  it("says which env file is missing and how to get it", async () => {
    const t = manager(validateProfile({ services: [{ name: "api", command: "x", envFiles: ["backend/.env"] }] }, "/repo"));
    await expect(t.m.start("/nope", { mode: "swap" })).rejects.toThrow(/env file backend\/\.env is missing.*Prepare/);
  });
});

describe("running real processes", () => {
  const realSpawn: Spawn = (command, opts) => pty.spawn("/bin/sh", ["-c", command], { name: "xterm-256color", cols: 120, rows: 30, cwd: opts.cwd, env: opts.env });

  it("stops the whole process group, children included", async () => {
    const dir = tempDir("run-real");
    const p = validateProfile(
      {
        services: [
          {
            name: "srv",
            // a server that also forks a child, like uvicorn --reload or dotnet run
            command: `node -e "require('child_process').spawn('sleep',['300'],{stdio:'ignore'}); require('http').createServer((q,s)=>s.end('ok')).listen(\${port:srv}, () => console.log('listening'))"`,
            ports: [{ name: "srv", base: 47310 }],
            ready: { port: "srv" },
          },
        ],
      },
      dir
    );
    const m = new RunManager({
      spawn: realSpawn,
      emit: () => {},
      baseEnv: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
      docker: async () => "docker",
      runShell: async () => ({ code: 0, out: "" }),
      profileFor: () => p,
      mainOf: async () => dir,
    });
    const r = await m.start(dir, { mode: "side" });
    expect(r).toMatchObject({ started: ["srv"] });
    const st = m.states()[0];
    expect(st.status).toBe("running");
    const group = execFileSync("pgrep", ["-g", String(st.pid)], { encoding: "utf8" }).trim().split("\n");
    expect(group.length).toBeGreaterThanOrEqual(2); // the shell's server and its sleep child
    await m.stop(dir);
    expect(m.states()[0].status).toBe("stopped");
    let left = "";
    try {
      left = execFileSync("pgrep", ["-g", String(st.pid)], { encoding: "utf8" });
    } catch {
      /* pgrep exits 1 when nothing matches: all gone */
    }
    expect(left.trim()).toBe("");
  }, 20_000);
});

describe("preparing a worktree", () => {
  it("copies the gitignored files it lacks from the main checkout, keeping ones it has", async () => {
    const { copyPrepared, globToRegex } = await import("../src/main/runPrepare");
    const main = tempDir("prep-main");
    const wt = tempDir("prep-wt");
    for (const [f, c] of Object.entries({ "backend/.env": "A=1", "frontend/.env": "B=2", "infra/app/etc/app-loc.env": "C=3", "node_modules/x/.env": "no", "src/.certs/key.pem": "k" })) {
      fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true });
      fs.writeFileSync(path.join(main, f), c);
    }
    fs.mkdirSync(path.join(wt, "frontend"), { recursive: true });
    fs.writeFileSync(path.join(wt, "frontend/.env"), "B=mine");
    const r = copyPrepared(main, wt, ["**/.env", "infra/*/etc/app-loc.env", "src/.certs", "missing.env"]);
    expect(r.copied.sort()).toEqual(["backend/.env", "infra/app/etc/app-loc.env", "src/.certs"]);
    expect(r.kept).toEqual(["frontend/.env"]);
    expect(r.missing).toEqual(["missing.env"]);
    expect(fs.readFileSync(path.join(wt, "frontend/.env"), "utf8")).toBe("B=mine");
    expect(fs.existsSync(path.join(wt, "node_modules"))).toBe(false); // never walked into
    expect(fs.readFileSync(path.join(wt, "src/.certs/key.pem"), "utf8")).toBe("k");
    expect(() => copyPrepared(main, wt, ["../../etc/passwd"])).toThrow(/inside the repository/);
    expect(globToRegex("**/.env").test(".env")).toBe(true);
    expect(globToRegex("a/*.env").test("a/b/c.env")).toBe(false);
  });

  it("runs only the setup commands whose result is missing", async () => {
    const { setupCommand } = await import("../src/main/runPrepare");
    const wt = tempDir("prep-cmd");
    fs.mkdirSync(path.join(wt, "frontend/node_modules"), { recursive: true });
    const prepare = { commands: [{ cwd: "frontend", command: "npm ci", ifMissing: "node_modules" }, { cwd: "backend", command: "python3 -m venv .venv", ifMissing: ".venv" }] };
    expect(setupCommand(wt, prepare)).toBe("(cd 'backend' && python3 -m venv .venv)");
    fs.mkdirSync(path.join(wt, "backend/.venv"), { recursive: true });
    expect(setupCommand(wt, prepare)).toBeNull();
  });
});

describe("drafting a run setup", () => {
  it("asks Claude with read-only tools from the main checkout and validates its reply", async () => {
    const { draftProfile } = await import("../src/main/runDraft");
    const repo = makeRepo({ ".gitignore": "backend/.env\n", "README.md": "uvicorn" });
    fs.mkdirSync(path.join(repo, "backend"));
    fs.writeFileSync(path.join(repo, "backend/.env"), "SECRET=x");
    let seen = { cmd: "", input: "", cwd: "" };
    const reply = { services: [{ name: "api", cwd: "backend", command: ".venv/bin/uvicorn app:app --port ${port:api}", ports: [{ name: "api", base: 8000 }] }], prepare: { copy: ["backend/.env"] } };
    const r = await draftProfile(repo, "/bin/claude", async (cmd, input, o) => {
      seen = { cmd, input, cwd: o.cwd };
      return { code: 0, out: JSON.stringify({ result: "```json\n" + JSON.stringify(reply) + "\n```", is_error: false }) };
    }, {});
    expect("profile" in r && r.profile.services[0].name).toBe("api");
    expect(seen.cmd).toContain("--tools Read Grep Glob");
    expect(seen.cmd).toContain("--no-session-persistence");
    expect(seen.cmd).toContain("--disallowedTools 'Read(**/.env)'");
    expect(seen.cwd).toBe(repo);
    expect(seen.input).toContain("backend/.env"); // offered as a file to carry into worktrees
    expect(seen.input).not.toContain("SECRET=x"); // names only, never contents

    const bad = await draftProfile(repo, "/bin/claude", async () => ({ code: 0, out: JSON.stringify({ result: '{"services":[]}' }) }), {});
    expect(bad).toMatchObject({ error: expect.stringMatching(/at least one service/), raw: '{"services":[]}' });
  });
});
