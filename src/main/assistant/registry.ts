import type { ActionDetail, AssistantTier } from "../../shared/assistant";
import type { AssistantDeps } from "./deps";

/**
 * The app Assistant's tools (docs/assistant.md → Plumbing). Each tool's tier is fixed here, in main: the model only
 * names a tool and its arguments, and the service (service.ts) decides what that call may do by the tier. The cards,
 * undo, rules and turn runner use only this registry.
 */

/** The JSON Schema the tools' inputs are written in: the part of it the Assistant's tools use, and validateArgs checks. */
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number | boolean)[];
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

/** A confirm tool's card: the exact target and effect, and what to know before saying yes. */
export interface ToolCard {
  /** "Restart “api-fix”". */
  title: string;
  /** What happens, in one or two plain sentences. */
  detail: string;
  /** Uncommitted changes, unpushed commits, mid-turn, a wider permission mode. */
  warnings: string[];
  /** Shown in the danger color: bypass permissions, deleting a worktree. */
  danger?: boolean;
  /** The text it types, sends or publishes, whole (AssistantCard.body). */
  body?: string;
  /** A standing rule's card: each of its actions (AssistantCard.actions). */
  actions?: ActionDetail[];
}

/** What a call does with exactly its arguments, every payload whole (ActionDetail, its warnings optional). */
export type ToolDetail = Omit<ActionDetail, "warnings"> & { warnings?: string[] };

/**
 * Who a call runs for. A standing rule's run acts with no one looking, so a tool may refuse more for it (typing into a
 * session in a wider permission mode).
 */
export interface CallContext {
  rule: boolean;
}

/** What a tool's run did. */
export interface ToolResult {
  /** What the model is told (a read tool's data, or what changed). */
  text: string;
  /** Direct tools only: puts back what the run changed, and says what it did in a plain line. Throws when it can't. */
  undo?: () => string | Promise<string>;
  /** Whether what the run changed is still as it left it: the step's Undo is offered only while it is. */
  stillUndoable?: () => boolean;
}

/** The session a call acts on, for the activity log. */
export interface ToolTarget {
  session: string;
  title?: string | null;
}

/**
 * One Assistant tool. `args` have passed `inputSchema` (validateArgs) before any of its functions is called.
 *
 * - read: `run` runs and returns data.
 * - direct: `check`, then `run`; a result with `undo` keeps an Undo for ASSISTANT_LIMITS.undoMs while `stillUndoable`.
 * - confirm: the model's call runs nothing: `check` and `card` make a card. The user's Do it checks again, against the
 *   state then, and runs `run`. The card expires after ASSISTANT_LIMITS.cardMs, or as soon as `stillValid` is false.
 */
export interface AssistantTool<A = Record<string, unknown>> {
  /** Its MCP name: lower case, digits and underscores. */
  name: string;
  tier: AssistantTier;
  /** For the model (tools/list). */
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  /** The step's plain line: "Rename “api-fix” to “api”". */
  label(args: A): string;
  /**
   * Rule-able tools: what this call does, with every payload whole and the sessions it names by id, for a rule's card
   * and the sheet's Rules list. Reads state, changes nothing. Without one, the label and its target say it.
   */
  describe?(args: A, ctx: CallContext): ToolDetail;
  /** Why it can't be done now, or null when it can. The service passes `ctx` (rule: a standing rule runs it). */
  check?(args: A, ctx?: CallContext): string | null | Promise<string | null>;
  /** Confirm tools: the card; without one, the card's title and detail are the label. */
  card?(args: A): ToolCard | Promise<ToolCard>;
  run(args: A, ctx?: CallContext): ToolResult | Promise<ToolResult>;
  /** Confirm tools: false once the card's target has changed, which expires the card. */
  stillValid?(args: A): boolean;
  /** The session it acts on, for the activity log. */
  target?(args: A): ToolTarget | null;
  /** Allowed as a standing rule's action. */
  rule?: boolean;
}

/** One ability group's tools (tools/<group>.ts), made with the deps they use. */
export type ToolGroup = (d: AssistantDeps) => AssistantTool[];

/** A tool with its own argument type, as the registry holds it. */
export const defineTool = <A>(t: AssistantTool<A>): AssistantTool => t as unknown as AssistantTool;

/** A tool as tools/list gives it to the model. */
export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean };
}

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TIERS: readonly AssistantTier[] = ["read", "direct", "confirm"];

export class Registry {
  private readonly tools = new Map<string, AssistantTool>();

  /** Throws on a tool the service couldn't hold to its tier: a bad name or tier, a repeated name, a schema that isn't an object's. */
  constructor(tools: readonly AssistantTool[]) {
    for (const t of tools) {
      if (!NAME_RE.test(t.name)) throw new Error(`The Assistant tool name ${JSON.stringify(t.name)} isn't lower case letters, digits and underscores`);
      if (!TIERS.includes(t.tier)) throw new Error(`The Assistant tool ${t.name} has no tier`);
      if (this.tools.has(t.name)) throw new Error(`Two Assistant tools are named ${t.name}`);
      if (t.inputSchema?.type !== "object") throw new Error(`The Assistant tool ${t.name}'s input schema isn't an object's`);
      if (t.tier !== "confirm" && (t.card || t.stillValid)) throw new Error(`The Assistant tool ${t.name} has a card but isn't a confirm tool`);
      this.tools.set(t.name, t);
    }
  }

  get(name: string): AssistantTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  list(): AssistantTool[] {
    return [...this.tools.values()];
  }

  /** What tools/list answers. */
  mcpTools(): McpToolSchema[] {
    return this.list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.tier === "read" ? { annotations: { readOnlyHint: true } } : {}) }));
  }
}

/** The registry of `groups`' tools, made with `d`. */
export function buildRegistry(d: AssistantDeps, groups: readonly ToolGroup[]): Registry {
  return new Registry(groups.flatMap((g) => g(d)));
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Why `value` doesn't fit `schema`, naming where (`at`), or null when it does. */
export function validateArgs(schema: JsonSchema, value: unknown, at = "arguments"): string | null {
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) return `${at} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  switch (schema.type) {
    case "object": {
      if (!isObject(value)) return `${at} must be an object`;
      const props = schema.properties ?? {};
      for (const key of schema.required ?? []) if (value[key] === undefined) return `${at}.${key} is required`;
      for (const [key, v] of Object.entries(value)) {
        // own properties only: `__proto__` and `constructor` would otherwise find Object.prototype's, and pass unchecked
        const sub = Object.hasOwn(props, key) ? props[key] : undefined;
        if (!sub) {
          if (schema.additionalProperties === false) return `${at}.${key} isn't an argument this tool takes`;
          continue;
        }
        const why = validateArgs(sub, v, `${at}.${key}`);
        if (why) return why;
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${at} must be a string`;
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${at} must be at least ${schema.minLength} characters`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${at} must be at most ${schema.maxLength} characters`;
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) return `${at} isn't in the expected form`;
      return null;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${at} must be a number`;
      if (schema.type === "integer" && !Number.isInteger(value)) return `${at} must be a whole number`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be at most ${schema.maximum}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${at} must be true or false`;
    case "array": {
      if (!Array.isArray(value)) return `${at} must be a list`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${at} must have at least ${schema.minItems} items`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at} must have at most ${schema.maxItems} items`;
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const why = validateArgs(schema.items, value[i], `${at}[${i}]`);
          if (why) return why;
        }
      }
      return null;
    }
    default:
      return null;
  }
}
