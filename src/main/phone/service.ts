import type { PhoneStatus } from "../../shared/phoneAlerts";
import type { Settings } from "../../shared/types";
import type { SessionManager } from "../sessions";
import { AwayDetector, type IdleMonitor } from "./away";
import { ChatDb } from "./chatDb";
import { PhoneAlerts, type PhoneAlertsDeps } from "./phoneAlerts";
import { DryRunSender, MessagesSender } from "./sender";

/** System Settings panes for the two permissions phone alerts need. */
export const PRIVACY_PANES = {
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  fullDiskAccess: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
} as const;

export interface PhoneService {
  alerts: PhoneAlerts;
  away: AwayDetector;
  stop(): void;
}

/**
 * Phone alerts as the app runs them. Only the installed app sends iMessages
 * and reads Messages: a development build (npm start, a worktree's dev
 * instance) logs what it would have sent and never opens chat.db.
 */
export function startPhoneService(o: {
  packaged: boolean;
  monitor: IdleMonitor;
  sessions: Pick<SessionManager, "list" | "write" | "deliverAgentMessage" | "setPhoneNote">;
  settings: () => Settings;
  audit: PhoneAlertsDeps["audit"];
  log: (context: string, err: unknown) => void;
  notify: (title: string, body: string) => void;
  onChanged: (s: PhoneStatus) => void;
}): PhoneService {
  const away = new AwayDetector({ monitor: o.monitor, idleMinutes: () => o.settings().phoneAlerts?.idleMinutes ?? 10 });
  const alerts = new PhoneAlerts({
    settings: o.settings,
    away: () => away.state(),
    sender: o.packaged ? new MessagesSender() : new DryRunSender((line) => console.log(line)),
    replies: o.packaged ? new ChatDb() : null,
    sessions: {
      list: () => o.sessions.list(),
      write: (id, data) => o.sessions.write(id, data),
      deliver: (id, text) => o.sessions.deliverAgentMessage(id, text, true),
      note: (id, text) => o.sessions.setPhoneNote(id, text),
    },
    audit: o.audit,
    log: o.log,
    info: (line) => console.log(line),
    warn: o.notify,
    onChanged: o.onChanged,
    dev: !o.packaged,
  });
  const off = away.onChange((a) => alerts.awayChanged(a));
  alerts.settingsChanged();
  return {
    alerts,
    away,
    stop() {
      off();
      alerts.stop();
    },
  };
}
