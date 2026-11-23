import * as path from "path";
import type { AssistantModel, AssistantTurn } from "../src/shared/assistant";
import type { AuditEntry } from "../src/shared/team/audit";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/types";
import type { AssistantDeps } from "../src/main/assistant/deps";
import type { AlertSender } from "../src/main/phone/sender";
import { Registry, type AssistantTool } from "../src/main/assistant/registry";
import { RuleEngine, type RuleLimits } from "../src/main/assistant/ruleEngine";
import { RuleBook, type RulesStore } from "../src/main/assistant/rules";
import { tempDir } from "./helpers";
import { AssistantService, type AssistantServiceDeps, type McpReply } from "../src/main/assistant/service";
import type { AssistantLimits, SpawnRequest } from "../src/main/assistant/turns";

/** A turn's model, as a test writes it: it calls the turn's tools by name, and answers its reply. */
export type Model = (call: (op: string, args?: Record<string, unknown>) => Promise<McpReply>, r: SpawnRequest) => Promise<string>;

export interface HarnessOptions {
  /** Claude Code's binary; null: it isn't installed. */
  bin?: string | null;
  world?: Pick<AssistantDeps, "sessions" | "groups" | "rooms"> & Partial<Pick<AssistantDeps, "heldPlans">>;
  rules?: RulesStore;
  /** Actions only rules take (the rules engine's notify and text_me). */
  ruleOnly?: readonly AssistantTool[];
  limits?: Partial<AssistantLimits>;
  spawnGraceMs?: number;
  /** Replaces the fake spawn, which runs the current `model`. */
  spawn?: (r: SpawnRequest) => Promise<string>;
  /** Replaces the activity log the test reads as `audit`. */
  audit?: AssistantServiceDeps["audit"];
  /** Where the thread is kept (thread.ts ThreadFile over a file in this test file's HOME); in memory only when absent. */
  thread?: AssistantServiceDeps["thread"];
  /** The model Settings → Assistant names. */
  model?: () => AssistantModel;
}

/** The Assistant service over `tools`, with a clock, the activity log and main's log the test can read. */
export function harness(tools: AssistantTool[], o: HarnessOptions = {}) {
  const audit: (Pick<AuditEntry, "kind"> & Partial<AuditEntry>)[] = [];
  const log: string[] = [];
  const spawned: SpawnRequest[] = [];
  let emits = 0;
  let clock = 1_000_000;
  let bin = o.bin === undefined ? "/opt/bin/claude" : o.bin;
  let model: Model = async () => "OK";
  const svc: AssistantService = new AssistantService({
    registry: new Registry(tools),
    claudeBin: async () => bin,
    spawn:
      o.spawn ??
      ((r) => {
        spawned.push(r);
        return model((op, args = {}) => svc.mcpCall(r.identity, op, args), r);
      }),
    world: o.world ?? { sessions: () => [], groups: () => [], rooms: () => [] },
    audit: o.audit ?? { record: (kind, who, more) => void audit.push({ kind, ...who, ...more } as AuditEntry) },
    emit: () => void emits++,
    log: (context, err) => void log.push(`${context}: ${err instanceof Error ? err.message : String(err)}`),
    rules: o.rules,
    thread: o.thread,
    model: o.model,
    ruleOnly: o.ruleOnly,
    now: () => clock,
    limits: o.limits,
    spawnGraceMs: o.spawnGraceMs,
  });

  /** Wait until turn `id` has finished; its view then. */
  const finished = async (id: string): Promise<AssistantTurn> => {
    for (let i = 0; i < 400; i++) {
      const t = (await svc.view()).turns.find((x) => x.id === id);
      if (t && (t.state === "done" || t.state === "error")) return t;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`turn ${id} didn't finish`);
  };

  /** Ask `text`, its model being `m`, and wait for the turn to finish. */
  const turn = async (text: string, m: Model): Promise<AssistantTurn> => {
    model = m;
    const r = await svc.ask(text);
    if ("error" in r) throw new Error(r.error);
    return finished(r.turnId);
  };

  return {
    svc,
    audit,
    log,
    spawned,
    turn,
    finished,
    emits: () => emits,
    setModel: (m: Model) => void (model = m),
    tick: (ms: number) => void (clock += ms),
    setBin: (b: string | null) => void (bin = b),
    card: async (id: string) => (await svc.view()).cards.find((c) => c.id === id)!,
    step: async (id: string) => (await svc.view()).turns.flatMap((t) => t.steps).find((s) => s.id === id)!,
  };
}

/** A tool whose every function is the test's, defaulting to a plain one. */
export function fakeTool(over: Partial<AssistantTool> & Pick<AssistantTool, "name" | "tier">): AssistantTool & { runs: Record<string, unknown>[] } {
  const runs: Record<string, unknown>[] = [];
  return {
    description: `${over.name} for tests`,
    inputSchema: { type: "object", properties: { session: { type: "string" } }, additionalProperties: false },
    label: (a) => `${over.name} ${String(a.session ?? "")}`.trim(),
    run: (a) => {
      runs.push(a);
      return { text: `${over.name} ran` };
    },
    ...over,
    runs,
  } as AssistantTool & { runs: Record<string, unknown>[] };
}

/**
 * Standing rules over a rules file in this test file's HOME, watching `world`: what's notified and texted, and what's
 * logged, the test reads. No sender is a development build's; tick() and the clock are the test's.
 */
export function rulesFor(world: Pick<AssistantDeps, "sessions" | "groups">, o: { file?: string; sender?: AlertSender | null; settings?: () => Settings; kept?: (id: string) => boolean; limits?: Partial<RuleLimits> } = {}) {
  const notified: { title: string; body: string }[] = [];
  const log: string[] = [];
  let clock = 1_000_000;
  const file = o.file ?? path.join(tempDir("rules"), "assistant-rules.json");
  const book = new RuleBook({ file, log: (c, e) => void log.push(`${c}: ${e instanceof Error ? e.message : String(e)}`), now: () => clock });
  const engine = new RuleEngine({
    book,
    world,
    sessionKept: o.kept ?? ((id) => world.sessions().some((s) => s.id === id)),
    settings: o.settings ?? (() => DEFAULT_SETTINGS),
    notify: (title, body) => void notified.push({ title, body }),
    sender: o.sender ?? null,
    log: (c, e) => void log.push(`${c}: ${e instanceof Error ? e.message : String(e)}`),
    info: (line) => void log.push(line),
    now: () => clock,
    limits: o.limits,
  });
  return { file, book, engine, notified, log, now: () => clock, setNow: (t: number) => void (clock = t), tick: (ms: number) => void (clock += ms) };
}
