import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { RUN_DIR } from "./runProfile";

/**
 * Lets a worktree run a repository's Docker Compose stack without editing the
 * repo. Compose files here pin container names, publish fixed ports and mount
 * absolute ~/Code/<repo> paths — so a second copy would take over the first's
 * containers, or a worktree would silently run the main checkout's code. A
 * generated override (passed as a second -f) points mounts and env files at
 * the worktree, and for side-by-side slots renames containers and explicitly
 * named volumes and shifts published ports. Needs Compose 2.24+ for !override.
 */

export interface ComposeConfig {
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string; external?: boolean }>;
}

interface ComposeService {
  container_name?: string;
  env_file?: { path: string; required?: boolean }[];
  ports?: { target: number; published?: string | number; host_ip?: string; protocol?: string; mode?: string }[];
  volumes?: { type: string; source?: string; target: string; read_only?: boolean; [k: string]: unknown }[];
}

/** Where debugpy is mounted inside a container being debugged; the app finds it through MOCKINGBIRD_DEBUGPY. */
export const DEBUGPY_IN_CONTAINER = "/opt/mockingbird/debugpy";

/** The compose project for a repo's slot: its own containers, network and default volumes. */
export function composeProject(repo: string, slot: number): string {
  return `mb-${path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-s${slot}`;
}

/**
 * A path under the main checkout, moved to the same place in the worktree. The
 * checkout can be spelled more than one way (Compose reports /tmp, git the
 * resolved /private/tmp), so every spelling is tried.
 */
function moveInto(p: string, mains: string[], worktree: string): string {
  for (const main of mains) {
    if (main === worktree) return p;
    if (p === main) return worktree;
    if (p.startsWith(main + path.sep)) return worktree + p.slice(main.length);
  }
  return p;
}

/**
 * The override for one worktree in one slot, as YAML. Only what changes is
 * written: mounts and env files that point into the main checkout (any slot),
 * and in slots above 0 container names, explicitly named volumes and published
 * ports (shifted by slot × step).
 */
export function buildOverride(
  config: ComposeConfig,
  opts: {
    main: string | string[];
    worktree: string;
    slot: number;
    step: number;
    project: string;
    /** Debugging Python in this compose service: mount debugpy and publish its port on loopback. */
    debugpy?: { service: string; dir: string; port: number };
  }
): string {
  const { worktree, slot, step, project } = opts;
  const main = Array.isArray(opts.main) ? opts.main : [opts.main];
  const services: Record<string, Record<string, unknown>> = {};
  for (const [name, svc] of Object.entries(config.services ?? {})) {
    const out: Record<string, unknown> = {};
    if (slot > 0 && svc.container_name) out.container_name = `${svc.container_name}-s${slot}`;
    const vols = svc.volumes ?? [];
    const dbg = opts.debugpy?.service === name ? opts.debugpy : undefined;
    const extraVol = dbg ? [{ type: "bind", source: dbg.dir, target: DEBUGPY_IN_CONTAINER, read_only: true }] : [];
    if (vols.some((v) => v.type === "bind" && v.source && moveInto(v.source, main, worktree) !== v.source)) {
      out.volumes = tag([...vols.map((v) => (v.type === "bind" && v.source ? { ...v, source: moveInto(v.source, main, worktree) } : v)), ...extraVol]);
    } else if (extraVol.length) out.volumes = extraVol; // lists merge: this adds to the service's own
    const envs = svc.env_file ?? [];
    if (envs.some((e) => moveInto(e.path, main, worktree) !== e.path)) {
      out.env_file = tag(envs.map((e) => ({ ...e, path: moveInto(e.path, main, worktree) })));
    }
    const ports = svc.ports ?? [];
    const extraPort = dbg ? [{ target: 5678, published: String(dbg.port), host_ip: "127.0.0.1", protocol: "tcp" }] : [];
    if (slot > 0 && ports.some((p) => p.published !== undefined && p.published !== "")) {
      out.ports = tag([
        ...ports.map((p) => (p.published === undefined || p.published === "" ? p : { ...p, published: String(Number(p.published) + slot * step) })),
        ...extraPort,
      ]);
    } else if (extraPort.length) out.ports = extraPort;
    if (dbg) out.environment = { MOCKINGBIRD_DEBUGPY: DEBUGPY_IN_CONTAINER };
    if (Object.keys(out).length) services[name] = out;
  }
  const volumes: Record<string, { name: string }> = {};
  if (slot > 0) {
    for (const [key, v] of Object.entries(config.volumes ?? {})) {
      // a volume given its own name is shared by every project — copies would write one database
      if (v.name && !v.external && v.name !== `${project}_${key}`) volumes[key] = { name: `${v.name}-s${slot}` };
    }
  }
  return toYaml({ services, ...(Object.keys(volumes).length ? { volumes } : {}) });
}

const TAG = Symbol("override");
const tag = (list: unknown[]) => ({ [TAG]: true, list });

/** Block-style mappings, flow-style (JSON) values; a tagged list is written `!override [...]`. */
function toYaml(obj: Record<string, unknown>, indent = ""): string {
  let out = "";
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && (v as any)[TAG]) out += `${indent}${JSON.stringify(k)}: !override ${JSON.stringify((v as any).list)}\n`;
    else if (v && typeof v === "object" && !Array.isArray(v)) out += `${indent}${JSON.stringify(k)}:\n${toYaml(v as Record<string, unknown>, indent + "  ") || `${indent}  {}\n`}`;
    else out += `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}\n`;
  }
  return out;
}

/**
 * The compose file as Compose itself reads it — `~` and relative paths
 * resolved — but with env files left as paths: their values (secrets) are
 * never read into Mockingbird.
 */
export function composeConfig(docker: string, opts: { cwd: string; file: string; project: string; env: NodeJS.ProcessEnv }): Promise<ComposeConfig> {
  return new Promise((resolve, reject) =>
    execFile(
      docker,
      ["compose", "-p", opts.project, "-f", opts.file, "config", "--format", "json", "--no-env-resolution"],
      { cwd: opts.cwd, env: opts.env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`docker compose config: ${(stderr || err.message).trim()}`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("docker compose config didn't return JSON"));
        }
      }
    )
  );
}

/** Write the override where `docker compose -f` can read it; returns its path. */
export function writeOverride(project: string, yaml: string): string {
  const dir = path.join(RUN_DIR, "overrides");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${project}.yml`);
  fs.writeFileSync(file, `# Written by Mockingbird for this run — regenerated on every start.\n${yaml}`);
  return file;
}
