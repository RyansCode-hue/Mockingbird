import { ASSISTANT_MODELS, assistantModelOf } from "../../../shared/assistant";
import { externalUrlAllowed } from "../../../shared/links";
import { IDLE_MINUTES_CHOICES, normalizeHandle, phoneSettings, type PhoneAlertSettings } from "../../../shared/phoneAlerts";
import { plainLine } from "../../../shared/team/agentText";
import { OPTIONAL_TABS, type MessageMode, type QuietHours, type Settings } from "../../../shared/types";
import type { AssistantDeps } from "../deps";
import { cardSaw } from "./sessions";
import { defineTool, type AssistantTool, type ToolCard } from "../registry";

/**
 * Settings (docs/assistant.md → Ability groups). SETTINGS_TABLE classifies every setting, one row each (phone alerts'
 * parts one row each), and is the whole of what these tools read and change:
 * - direct: a view or notification setting: set_setting changes it at once, with an Undo, and a standing rule may;
 * - confirm: it changes what agents may do without asking, what runs as the user, or what reaches past this Mac:
 *   change_setting puts it on a card, and only the user's Do it changes it;
 * - read: shown, and changed only where the app changes it (its own Settings section, or its own tool);
 * - never: neither shown nor changed (credentials paths, where phone alerts go).
 * A setting the table doesn't name can't be added without a row: the type requires one for every key of Settings, and
 * test/assistantSettings.test.ts checks the interface's keys against it.
 */

type Deps = Pick<AssistantDeps, "settings" | "changeSettings">;

export type SettingTier = "direct" | "confirm" | "read" | "never";

/** A setting's name in the table: a key of Settings, or a part of phone alerts (their on/off is `phoneAlerts`). */
export type SettingKey = keyof Settings | `phoneAlerts.${Exclude<keyof PhoneAlertSettings, "enabled">}`;

export interface SettingRow {
  tier: SettingTier;
  /** What it is, in plain words: "notifications". */
  words: string;
  /** Its value's form, for the model. */
  form?: string;
  /** Why it's on a card, read only or never shown. */
  why?: string;
  /** Its value now: what get_settings shows, set_setting compares and an Undo puts back. Every row but a never one's. */
  get?(s: Settings): unknown;
  /** The patch that makes it `v`, or why `v` can't be it. Direct and confirm rows only. */
  put?(v: unknown, s: Settings): Partial<Settings> | Refused;
  /** Its card in the danger color: what it names runs as the user, or reaches past this Mac. */
  danger?: boolean;
  /** Its words are plural: "notifications are on". */
  plural?: boolean;
}

/** Why a value can't be a setting's. */
export type Refused = { refused: string };
export const isRefused = (x: unknown): x is Refused => !!x && typeof (x as Refused).refused === "string";

/** Which row covers each part of phone alerts: the table's rows for them, every part named. */
export const PHONE_ROWS: Record<keyof PhoneAlertSettings, SettingKey> = {
  enabled: "phoneAlerts",
  handle: "phoneAlerts.handle",
  idleMinutes: "phoneAlerts.idleMinutes",
  finished: "phoneAlerts.finished",
  replies: "phoneAlerts.replies",
};

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const no = (refused: string): Refused => ({ refused });

/** A setting that's on or off. */
const onOff = (words: string, patch: (on: boolean, s: Settings) => Partial<Settings>) => (v: unknown, s: Settings) =>
  typeof v === "boolean" ? patch(v, s) : no(`${cap(words)} is on (true) or off (false)`);

/** A line of text at most `max` long, with nothing but printable characters. */
function line(v: unknown, words: string, max: number): string | Refused {
  if (typeof v !== "string" || !v.trim()) return no(`${cap(words)} is text`);
  const t = v.trim();
  if (t.length > max) return no(`${cap(words)} is at most ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(t)) return no(`${cap(words)} is one line, with no control characters`);
  return t;
}

/** A folder or program's path: absolute, or from ~. */
function pathLine(v: unknown, words: string): string | Refused {
  const t = line(v, words, 500);
  if (typeof t !== "string") return t;
  return t.startsWith("/") || t.startsWith("~/") ? t : no(`${cap(words)} is a path from / or ~/`);
}

const phone = (s: Settings) => phoneSettings(s.phoneAlerts);
const phonePatch = (s: Settings, part: Partial<PhoneAlertSettings>): Partial<Settings> => ({ phoneAlerts: { ...phone(s), ...part } });
const cap = (t: string) => `${t[0].toUpperCase()}${t.slice(1)}`;

export const SETTINGS_TABLE: Record<SettingKey, SettingRow> = {
  // ---- direct: what shows and what notifies --------------------------------------------------
  notifications: { tier: "direct", words: "notifications", plural: true, form: "on or off", get: (s) => s.notifications, put: onOff("notifications", (on) => ({ notifications: on })) },
  notifyFinished: {
    tier: "direct",
    words: "finished alerts",
    plural: true,
    form: "on or off: a notification when a session finishes its turn",
    get: (s) => s.notifyFinished !== false,
    put: onOff("finished alerts", (on) => ({ notifyFinished: on })),
  },
  quietHours: {
    tier: "direct",
    words: "quiet hours",
    plural: true,
    form: "on or off, from and to as HH:MM: no notifications between them",
    get: (s) => (s.quietHours ? { enabled: s.quietHours.enabled, from: s.quietHours.from, to: s.quietHours.to } : null),
    put: (v, s) => {
      // quiet hours never set before are put back as off, at the times just given
      if (v === null) return s.quietHours ? { quietHours: { ...s.quietHours, enabled: false } } : no("Quiet hours were never set");
      if (!isObject(v) || typeof v.enabled !== "boolean") return no("Quiet hours are on or off, from and to");
      if (typeof v.from !== "string" || typeof v.to !== "string" || !HHMM.test(v.from) || !HHMM.test(v.to)) return no("Say when quiet hours start and end (from and to, as HH:MM)");
      if (v.from === v.to) return no("Quiet hours can't start and end at the same time");
      const value: QuietHours = { enabled: v.enabled, from: v.from, to: v.to };
      return { quietHours: value };
    },
  },
  phoneAlerts: {
    tier: "direct",
    words: "phone alerts",
    plural: true,
    form: "on or off, once the user has set them up in Settings → Phone alerts",
    get: (s) => phone(s).enabled,
    put: (v, s) => {
      if (typeof v !== "boolean") return no("Phone alerts are on (true) or off (false)");
      if (v && normalizeHandle(phone(s).handle) === null) return no("Phone alerts aren't set up: the user sets them up in Settings → Phone alerts first");
      return phonePatch(s, { enabled: v });
    },
  },
  "phoneAlerts.idleMinutes": {
    tier: "direct",
    words: "phone alerts' away time",
    form: `minutes without input before the Mac counts as away: ${IDLE_MINUTES_CHOICES.join(", ")}`,
    get: (s) => phone(s).idleMinutes,
    put: (v, s) => ((IDLE_MINUTES_CHOICES as readonly unknown[]).includes(v) ? phonePatch(s, { idleMinutes: v as number }) : no(`The away time is one of ${IDLE_MINUTES_CHOICES.join(", ")} minutes`)),
  },
  "phoneAlerts.finished": {
    tier: "direct",
    words: "phone alerts for finished turns",
    plural: true,
    form: "on or off: a text when a session finishes its turn, not only when it waits on you",
    get: (s) => phone(s).finished,
    put: onOff("phone alerts for finished turns", (on, s) => phonePatch(s, { finished: on })),
  },
  hiddenTabs: {
    tier: "direct",
    words: "the hidden tabs",
    plural: true,
    form: `the top bar's tabs turned off: a list of ${OPTIONAL_TABS.join(", ")}`,
    get: (s) => [...(s.hiddenTabs ?? [])],
    put: (v) => {
      if (!Array.isArray(v) || v.some((t) => !OPTIONAL_TABS.includes(t))) return no(`The hidden tabs are a list of ${OPTIONAL_TABS.join(", ")}`);
      return { hiddenTabs: OPTIONAL_TABS.filter((t) => v.includes(t)) };
    },
  },
  assistantModel: {
    tier: "direct",
    words: "the Assistant's model",
    form: `${ASSISTANT_MODELS.map((m) => `${m.id} (${m.note})`).join(" or ")}: from the next question`,
    get: (s) => assistantModelOf(s),
    put: (v) => (ASSISTANT_MODELS.some((m) => m.id === v) ? { assistantModel: v as Settings["assistantModel"] } : no(`The Assistant's model is ${ASSISTANT_MODELS.map((m) => m.id).join(" or ")}`)),
  },

  // ---- confirm: what agents may do unasked, what runs as the user, what reaches past this Mac --------
  agentMessagesSubmit: {
    tier: "confirm",
    words: "sending agents' messages at once",
    form: "on or off",
    why: "On, a message one agent sends another is sent and acted on at once, without waiting in its prompt for you",
    get: (s) => s.agentMessagesSubmit !== false,
    put: onOff("sending agents' messages at once", (on) => ({ agentMessagesSubmit: on })),
  },
  agentMessagesByGroup: {
    tier: "confirm",
    words: "agents' messages by group",
    form: 'each group\'s key to "send" (sent at once) or "prompt" (waits for you); the whole list',
    why: "Per group, whether a message an agent sends its sessions is acted on at once, without you seeing it first",
    get: (s) => ({ ...(s.agentMessagesByGroup ?? {}) }),
    put: (v) => {
      if (!isObject(v) || Object.keys(v).length > 100) return no('Agents\' messages by group is each group\'s key to "send" or "prompt"');
      const out: [string, MessageMode][] = [];
      for (const [k, m] of Object.entries(v)) {
        if (!k.trim() || k.length > 161 || (m !== "send" && m !== "prompt")) return no(`“${plainLine(k, 80)}” isn't a group's key with "send" or "prompt"`);
        out.push([k, m]);
      }
      // own properties whatever the keys are named (a "__proto__" one included)
      return { agentMessagesByGroup: Object.fromEntries(out) };
    },
  },
  "phoneAlerts.replies": {
    tier: "confirm",
    words: "phone replies",
    plural: true,
    form: "on or off",
    why: "On, what you reply from your phone answers sessions' prompts and is typed into them, while you're away (it needs Full Disk Access)",
    get: (s) => phone(s).replies,
    put: onOff("phone replies", (on, s) => phonePatch(s, { replies: on })),
  },
  debriefs: {
    tier: "confirm",
    words: "debriefs",
    plural: true,
    form: "enabled (on or off), morning and wrapUp as HH:MM; any of them",
    why: "On, Mockingbird starts a debrief session on its own each weekday, which reads a digest of your day's sessions",
    get: (s) => ({ enabled: s.debriefs.enabled, morning: s.debriefs.morning, wrapUp: s.debriefs.wrapUp }),
    put: (v, s) => {
      if (!isObject(v) || Object.keys(v).some((k) => !["enabled", "morning", "wrapUp"].includes(k))) return no("Debriefs are enabled, morning and wrapUp");
      if (v.enabled !== undefined && typeof v.enabled !== "boolean") return no("Debriefs' enabled is on (true) or off (false)");
      for (const k of ["morning", "wrapUp"] as const) if (v[k] !== undefined && (typeof v[k] !== "string" || !HHMM.test(v[k] as string))) return no(`Debriefs' ${k} is a time, HH:MM`);
      return { debriefs: { ...s.debriefs, ...(v as Partial<Settings["debriefs"]>) } };
    },
  },
  repoRoots: {
    tier: "confirm",
    words: "the repository folders",
    plural: true,
    form: "a list of folders, each from / or ~/",
    why: "They're where Mockingbird looks for repositories, and offers to start sessions",
    get: (s) => [...s.repoRoots],
    put: (v) => {
      if (!Array.isArray(v) || !v.length || v.length > 30) return no("The repository folders are a list of 1 to 30 folders");
      const out: string[] = [];
      for (const p of v) {
        const t = pathLine(p, "a repository folder");
        if (typeof t !== "string") return t;
        out.push(t);
      }
      return { repoRoots: [...new Set(out)] };
    },
  },
  claudeBin: {
    tier: "confirm",
    words: "the Claude Code program",
    form: 'a path, or "claude" to find it on the PATH',
    why: "Every Claude session from now on runs this program, as you",
    danger: true,
    get: (s) => s.claudeBin,
    put: (v) => {
      const t = v === "claude" ? v : pathLine(v, "the Claude Code program");
      return typeof t === "string" ? { claudeBin: t } : t;
    },
  },
  codexBin: {
    tier: "confirm",
    words: "the Codex program",
    form: 'a path, or "codex" to find it on the PATH',
    why: "Every Codex session from now on runs this program, as you",
    danger: true,
    get: (s) => s.codexBin,
    put: (v) => {
      const t = v === "codex" ? v : pathLine(v, "the Codex program");
      return typeof t === "string" ? { codexBin: t } : t;
    },
  },
  updateSource: {
    tier: "confirm",
    words: "where updates come from",
    form: "the folder of Mockingbird's clone, from / or ~/, or null to find it under the repository folders",
    why: "Update pulls, builds and installs Mockingbird from this folder",
    danger: true,
    get: (s) => s.updateSource ?? null,
    put: (v) => {
      if (v === null) return { updateSource: null };
      const t = pathLine(v, "where updates come from");
      return typeof t === "string" ? { updateSource: t } : t;
    },
  },
  teamName: {
    tier: "confirm",
    words: "your name in team rooms",
    form: "a name, at most 60 characters",
    why: "Teammates in every room see it",
    get: (s) => s.teamName ?? null,
    put: (v) => {
      const t = line(v, "your name in team rooms", 60);
      return typeof t === "string" ? { teamName: t } : t;
    },
  },
  signalingUrl: {
    tier: "confirm",
    words: "the team rooms' signaling address",
    form: "an https address",
    why: "New team rooms connect through it, and their invites carry it",
    danger: true,
    get: (s) => s.signalingUrl ?? null,
    put: (v) => {
      const t = line(v, "the signaling address", 300);
      if (typeof t !== "string") return t;
      return externalUrlAllowed(t) ? { signalingUrl: t } : no("The signaling address is an https address");
    },
  },
  roomSessionsInline: {
    tier: "confirm",
    words: "running room sessions inline",
    form: "on or off",
    why: "It changes how this Mac's team room sessions run, and so what teammates' copies of them show",
    get: (s) => s.roomSessionsInline !== false,
    put: onOff("running room sessions inline", (on) => ({ roomSessionsInline: on })),
  },

  // ---- read: changed where the app changes them ------------------------------------------------
  setupDone: { tier: "read", words: "first-run setup done", why: "The first-run setup sets it", get: (s) => !!s.setupDone },
  presets: {
    tier: "read",
    words: "the presets",
    why: "Made and changed in Settings → Presets: their kickoffs are typed as written",
    get: (s) => (s.presets ?? []).map((p) => ({ name: p.name, launch: p.launch, ...(p.group ? { group: p.group } : {}) })),
  },
  pipelineTemplates: {
    tier: "read",
    words: "the saved templates",
    why: "Saved with Save as template: list_templates lists them",
    get: (s) => ({ saved: Array.isArray(s.pipelineTemplates) ? s.pipelineTemplates.length : 0 }),
  },
  roomsUnsandboxed: {
    tier: "read",
    words: "rooms without their sandbox",
    why: "Each room's sandbox is switched with set_room_sandbox, on a card",
    get: (s) => (Array.isArray(s.roomsUnsandboxed) ? [...s.roomsUnsandboxed] : []),
  },

  // ---- never: neither shown nor changed ----------------------------------------------------------
  workTrackerPath: { tier: "never", words: "WorkTracker's folder", why: "It leads to where your Azure DevOps token is kept" },
  "phoneAlerts.handle": { tier: "never", words: "where phone alerts go", why: "Set up in Settings → Phone alerts only, never read or changed here" },
};

export const SETTING_KEYS = Object.keys(SETTINGS_TABLE) as SettingKey[];
export const keysOfTier = (tier: SettingTier): SettingKey[] => SETTING_KEYS.filter((k) => SETTINGS_TABLE[k].tier === tier);
const DIRECT = keysOfTier("direct");
const CONFIRM = keysOfTier("confirm");

const rowOf = (key: unknown): SettingRow | null => (typeof key === "string" && Object.hasOwn(SETTINGS_TABLE, key) ? SETTINGS_TABLE[key as SettingKey] : null);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A value as a step or a card says it: on or off, quiet hours' times, a list, or the value. */
export function shown(v: unknown, max = 120): string {
  if (typeof v === "boolean") return v ? "on" : "off";
  if (v === null || v === undefined) return "not set";
  if (Array.isArray(v)) return v.length ? plainLine(v.map(String).join(", "), max) : "none";
  if (isObject(v) && typeof v.enabled === "boolean" && typeof v.from === "string") return v.enabled ? `on, ${v.from} to ${v.to}` : "off";
  if (isObject(v)) return plainLine(JSON.stringify(v), max) || "none";
  return typeof v === "string" ? `“${plainLine(v, max)}”` : String(v);
}

/** Why setting `key` isn't one `tool` changes, pointing at the way it is changed. */
function notHere(key: string, row: SettingRow | null, tool: "set_setting" | "change_setting"): string {
  if (!row) return `There's no setting ${JSON.stringify(plainLine(key, 60))}: get_settings lists them`;
  if (row.tier === "never") return `${cap(row.words)} is never read or changed by the Assistant: ${row.why}`;
  if (row.tier === "read") return `${cap(row.words)} isn't changed here: ${row.why}`;
  return row.tier === "confirm" && tool === "set_setting"
    ? `${cap(row.words)} isn't changed at once: ${row.why}. change_setting puts it on a card for the user`
    : `${cap(row.words)} is changed at once with set_setting, with an Undo`;
}

type SetArgs = { setting: string; on?: boolean; value?: unknown; from?: string; to?: string };
type ChangeArgs = { setting: string; value: unknown };

/** "are" or "is" for row `row`'s words, or "were" and "was". */
const be = (row: SettingRow, past = false): string => (row.plural ? (past ? "were" : "are") : past ? "was" : "is");

/** The value set_setting's arguments ask for setting `key` (`row`), against settings `s`; or why there's none. */
function askedFor(key: string, row: SettingRow, a: SetArgs, s: Settings): { value: unknown } | Refused {
  if (key !== "quietHours" && (a.from !== undefined || a.to !== undefined)) return no("from and to are quiet hours' times only");
  if (key === "quietHours" && a.value === undefined) {
    if (a.on === undefined) return no("Say whether quiet hours are on (on: true or false)");
    const now = row.get!(s) as QuietHours | null;
    return { value: { enabled: a.on, from: a.from ?? now?.from, to: a.to ?? now?.to } };
  }
  const value = a.value !== undefined ? a.value : a.on;
  return value === undefined ? no("Say what to set it to: on (true or false), or value") : { value };
}

/** A change to one setting: its row, what it is now and the patch that changes it. */
interface Planned {
  row: SettingRow;
  before: unknown;
  patch: Partial<Settings>;
}

/** What setting `key` to `value` would change, against settings `s`; or why it can't be set so by a `tier` tool. */
function planned(key: string, value: unknown, s: Settings, tier: "direct" | "confirm"): Planned | Refused {
  const row = rowOf(key);
  if (!row || row.tier !== tier) return no(notHere(key, row, tier === "direct" ? "set_setting" : "change_setting"));
  const patch = row.put!(value, s);
  if (isRefused(patch)) return patch;
  const before = row.get!(s);
  if (same(row.get!({ ...s, ...patch }), before)) return no(`${cap(row.words)} ${be(row)} ${shown(before)} already`);
  return { row, before, patch };
}

/** What set_setting's call `a` changes, against settings `s`. */
function setPlan(a: SetArgs, s: Settings): Planned | Refused {
  const row = rowOf(a.setting);
  if (!row || row.tier !== "direct") return no(notHere(a.setting, row, "set_setting"));
  const v = askedFor(a.setting, row, a, s);
  return isRefused(v) ? v : planned(a.setting, v.value, s, "direct");
}

const settingList = (keys: readonly string[]) => keys.join(", ");

export function settingTools(d: Deps): AssistantTool[] {
  /** What each change_setting card showed the setting as. */
  const changeSaw = cardSaw<string>();

  return [
    defineTool<Record<string, never>>({
      name: "get_settings",
      tier: "read",
      description:
        "Mockingbird's settings: each one's value, what it is, and how it changes: at once with an Undo (set_setting), on a card the user confirms (change_setting), " +
        "or only in the app (read only). Credentials paths and where phone alerts go are never shown.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      label: () => "Read the settings",
      run: () => {
        const s = d.settings();
        const settings: Record<string, unknown> = {};
        const notShown: Record<string, string> = {};
        for (const key of SETTING_KEYS) {
          const row = SETTINGS_TABLE[key];
          if (row.tier === "never" || !row.get) {
            notShown[key] = `${cap(row.words)}: ${row.why ?? "never shown"}`;
            continue;
          }
          settings[key] = {
            value: row.get(s),
            ...(key === "phoneAlerts" ? { setUp: normalizeHandle(phone(s).handle) !== null } : {}),
            changes: row.tier === "direct" ? "set_setting" : row.tier === "confirm" ? "change_setting" : "read only",
            is: row.words,
            ...(row.form ? { form: row.form } : {}),
            ...(row.why ? { why: row.why } : {}),
          };
        }
        return { text: JSON.stringify({ settings, notShown }) };
      },
    }),

    defineTool<SetArgs>({
      name: "set_setting",
      tier: "direct",
      rule: true,
      description:
        `Change a view or notification setting at once: ${settingList(DIRECT)}. ` +
        "Give on (true or false) for one that's on or off; quiet hours take on with from and to (HH:MM, needed the first time); the rest take value, in the form get_settings says. " +
        "Phone alerts turn on only once the user has set them up. The user can Undo it. Can be a standing rule's action. " +
        "Settings that change what agents may do, or what runs as the user or leaves the Mac, are change_setting's.",
      inputSchema: {
        type: "object",
        properties: {
          setting: { type: "string", enum: DIRECT, description: "Which setting" },
          on: { type: "boolean", description: "true: on" },
          value: { description: "The new value, in the form get_settings says, for a setting that isn't on or off" },
          from: { type: "string", pattern: HHMM.source, description: "Quiet hours only: when they start, HH:MM" },
          to: { type: "string", pattern: HHMM.source, description: "Quiet hours only: when they end, HH:MM" },
        },
        required: ["setting"],
        additionalProperties: false,
      },
      label: (a) => {
        const row = rowOf(a.setting);
        if (!row) return `Change ${plainLine(String(a.setting), 40)}`;
        if (a.on !== undefined && a.value === undefined) return `Turn ${row.words} ${a.on ? "on" : "off"}`;
        return `Set ${row.words} to ${shown(a.value, 60)}`;
      },
      describe: (a) => {
        const row = rowOf(a.setting);
        const times = a.from || a.to ? `, ${a.from ?? "as set"} to ${a.to ?? "as set"}` : "";
        if (!row) return { line: `Change ${plainLine(String(a.setting), 40)}` };
        return { line: a.on !== undefined && a.value === undefined ? `Turn ${row.words} ${a.on ? "on" : "off"}${times}` : `Set ${row.words} to ${shown(a.value)}` };
      },
      check: (a) => {
        const p = setPlan(a, d.settings());
        return isRefused(p) ? p.refused : null;
      },
      run: (a) => {
        const p = setPlan(a, d.settings());
        if (isRefused(p)) throw new Error(p.refused);
        const { row, before, patch } = p;
        d.changeSettings(patch);
        const after = row.get!(d.settings());
        const still = () => same(row.get!(d.settings()), after);
        const verb = (v: unknown) => (typeof v === "boolean" || a.setting === "quietHours" ? `Turned ${row.words} ${shown(v)}` : `Set ${row.words} to ${shown(v)}`);
        return {
          text: `${verb(after)}.`,
          stillUndoable: still,
          undo: () => {
            if (!still()) throw new Error(`${cap(row.words)} ${be(row, true)} changed again since`);
            const back = row.put!(before, d.settings());
            if (isRefused(back)) throw new Error(`It can't be put back: ${back.refused}`);
            d.changeSettings(back);
            return `Put ${row.words} back ${typeof before === "boolean" || a.setting === "quietHours" ? shown(row.get!(d.settings())) : `to ${shown(before)}`}`;
          },
        };
      },
    }),

    defineTool<ChangeArgs>({
      name: "change_setting",
      tier: "confirm",
      description:
        `Change a setting that changes what agents may do without asking, what runs as the user, or what reaches past this Mac: ${settingList(CONFIRM)}. ` +
        "value in the form get_settings says. This puts a card in front of the user; it changes only when they confirm. Never a standing rule's action.",
      inputSchema: {
        type: "object",
        properties: {
          setting: { type: "string", enum: CONFIRM, description: "Which setting" },
          value: { description: "The new value, in the form get_settings says" },
        },
        required: ["setting", "value"],
        additionalProperties: false,
      },
      label: (a) => {
        const row = rowOf(a.setting);
        return row ? `Change ${row.words} to ${shown(a.value, 60)}` : `Change ${plainLine(String(a.setting), 40)}`;
      },
      check: (a) => {
        const p = planned(a.setting, a.value, d.settings(), "confirm");
        return isRefused(p) ? p.refused : null;
      },
      card: (a): ToolCard => {
        const s = d.settings();
        const row = rowOf(a.setting);
        if (!row?.get) return { title: `Change ${plainLine(String(a.setting), 40)}`, detail: notHere(a.setting, row, "change_setting"), warnings: [] };
        const before = row.get(s);
        changeSaw.set(a, JSON.stringify(before));
        const long = typeof a.value !== "boolean" && shown(a.value, 10_000).length > 80;
        return {
          title: `Change ${row.words}`,
          detail: `From ${shown(before)} to ${long ? "the value below" : shown(a.value)}. ${row.why ?? ""}`.trim(),
          warnings: row.danger ? ["Only change it to something you know: a wrong one runs as you, or reaches past this Mac"] : [],
          ...(row.danger ? { danger: true } : {}),
          ...(long ? { body: typeof a.value === "string" ? a.value : JSON.stringify(a.value, null, 2) } : {}),
        };
      },
      // the card says what it changes from: changed since, it's another change
      stillValid: (a) => {
        const saw = changeSaw.get(a);
        const row = rowOf(a.setting);
        return saw === undefined || !row?.get || JSON.stringify(row.get(d.settings())) === saw;
      },
      run: (a) => {
        const p = planned(a.setting, a.value, d.settings(), "confirm");
        if (isRefused(p)) throw new Error(p.refused);
        const { row, patch } = p;
        d.changeSettings(patch);
        return { text: `Changed ${row.words} to ${shown(row.get!(d.settings()))}.` };
      },
    }),
  ];
}
