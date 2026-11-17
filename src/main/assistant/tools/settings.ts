import type { QuietHours } from "../../../shared/types";
import type { AssistantDeps, AssistantSettingChange, AssistantSettings } from "../deps";
import { defineTool, type AssistantTool } from "../registry";

/**
 * Settings (docs/assistant.md → Ability groups): the few the Assistant may read and change, each change direct with
 * Undo and rule-able. SETTING_KEYS is the whole of it: every other setting is refused by name, and phone alerts are
 * only turned on or off once they're set up in Settings (no handle is ever read, set or given).
 */

type Deps = Pick<AssistantDeps, "settingsSeen" | "changeSetting">;

/** The settings set_setting changes, and nothing else. */
export const SETTING_KEYS = ["notifications", "notifyFinished", "quietHours", "phoneAlerts"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

const isSettingKey = (k: unknown): k is SettingKey => (SETTING_KEYS as readonly unknown[]).includes(k);

const HHMM = "^([01][0-9]|2[0-3]):[0-5][0-9]$";
const WORDS: Record<SettingKey, string> = { notifications: "notifications", notifyFinished: "finished alerts", quietHours: "quiet hours", phoneAlerts: "phone alerts" };

type SetArgs = { setting: string; on: boolean; from?: string; to?: string };

const ONLY = `Only ${SETTING_KEYS.join(", ")} can be changed here; the rest are the user's to change in Settings`;

/** Setting `key` as it is in `s`, as the change that would set it so. */
function changeOf(key: SettingKey, s: AssistantSettings): AssistantSettingChange | null {
  switch (key) {
    case "notifications":
      return { key, on: s.notifications };
    case "notifyFinished":
      return { key, on: s.notifyFinished };
    case "quietHours":
      return s.quietHours ? { key, value: { ...s.quietHours } } : null;
    case "phoneAlerts":
      return { key, on: s.phoneAlerts.enabled };
  }
}

/** The change `a` asks for against settings `s`, or why it can't be made. */
function wanted(a: SetArgs, s: AssistantSettings): { change: AssistantSettingChange } | { refused: string } {
  if (!isSettingKey(a.setting)) return { refused: ONLY };
  const key = a.setting;
  if (key !== "quietHours" && (a.from !== undefined || a.to !== undefined)) return { refused: "from and to are quiet hours' times only" };
  if (key === "phoneAlerts" && !s.phoneAlerts.setUp) return { refused: "Phone alerts aren't set up: the user sets them up in Settings → Phone alerts first" };
  let change: AssistantSettingChange;
  if (key === "quietHours") {
    const from = a.from ?? s.quietHours?.from;
    const to = a.to ?? s.quietHours?.to;
    if (!from || !to) return { refused: "Say when quiet hours start and end (from and to, as HH:MM)" };
    if (from === to) return { refused: "Quiet hours can't start and end at the same time" };
    const value: QuietHours = { enabled: a.on, from, to };
    change = { key, value };
  } else change = { key, on: a.on };
  if (JSON.stringify(change) === JSON.stringify(changeOf(key, s))) return { refused: `${WORDS[key][0].toUpperCase()}${WORDS[key].slice(1)} are ${describe(change)} already` };
  return { change };
}

function describe(c: AssistantSettingChange): string {
  if (c.key === "quietHours") return c.value.enabled ? `on, ${c.value.from} to ${c.value.to}` : "off";
  return c.on ? "on" : "off";
}

export function settingTools(d: Deps): AssistantTool[] {
  return [
    defineTool<Record<string, never>>({
      name: "get_settings",
      tier: "read",
      description:
        "The settings the Assistant can see and change: notifications on or off, finished alerts (a notification when a session finishes its turn), " +
        "quiet hours (on or off, from and to), and phone alerts (whether they're set up, and on or off). No other setting is given.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      label: () => "Read the settings",
      run: () => ({ text: JSON.stringify(d.settingsSeen()) }),
    }),
    defineTool<SetArgs>({
      name: "set_setting",
      tier: "direct",
      rule: true,
      description:
        "Turn one setting on or off: notifications, notifyFinished (finished alerts), quietHours (with from and to as HH:MM, needed the first time), " +
        "or phoneAlerts (only once the user has set them up). Every other setting is refused. The user can Undo it. Can be a standing rule's action.",
      inputSchema: {
        type: "object",
        properties: {
          setting: { type: "string", enum: SETTING_KEYS, description: "Which setting" },
          on: { type: "boolean", description: "true: on" },
          from: { type: "string", pattern: HHMM, description: "Quiet hours only: when they start, HH:MM" },
          to: { type: "string", pattern: HHMM, description: "Quiet hours only: when they end, HH:MM" },
        },
        required: ["setting", "on"],
        additionalProperties: false,
      },
      label: (a) => (isSettingKey(a.setting) ? `Turn ${WORDS[a.setting]} ${a.on ? "on" : "off"}` : `Change ${String(a.setting).slice(0, 40)}`),
      describe: (a) => ({
        line: isSettingKey(a.setting)
          ? `Turn ${WORDS[a.setting]} ${a.on ? "on" : "off"}${a.from || a.to ? `, ${a.from ?? "as set"} to ${a.to ?? "as set"}` : ""}`
          : `Change ${String(a.setting).slice(0, 40)}`,
      }),
      check: (a) => {
        const w = wanted(a, d.settingsSeen());
        return "refused" in w ? w.refused : null;
      },
      run: (a) => {
        const before = d.settingsSeen();
        const w = wanted(a, before);
        if ("refused" in w) throw new Error(w.refused);
        const key = w.change.key;
        const was = changeOf(key, before);
        d.changeSetting(w.change);
        const same = () => JSON.stringify(changeOf(key, d.settingsSeen())) === JSON.stringify(w.change);
        return {
          text: `Turned ${WORDS[key]} ${describe(w.change)}.`,
          stillUndoable: same,
          undo: () => {
            if (!same()) throw new Error(`${WORDS[key]} were changed again since`);
            // quiet hours never set before go back to off at the times just given
            const back: AssistantSettingChange = was ?? { key: "quietHours", value: { ...(w.change as { value: QuietHours }).value, enabled: false } };
            d.changeSetting(back);
            return `Put ${WORDS[key]} back ${describe(back)}`;
          },
        };
      },
    }),
  ];
}
