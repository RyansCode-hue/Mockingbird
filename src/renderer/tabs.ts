/** The top bar's tabs and their names (Settings names the optional ones too). */
export type Tab = "sessions" | "dashboard" | "worktracker" | "collaborate" | "settings";
export const TAB_LABELS: Record<Tab, string> = {
  sessions: "Sessions",
  dashboard: "Dashboard",
  worktracker: "WorkTracker",
  collaborate: "Council",
  settings: "Settings",
};
