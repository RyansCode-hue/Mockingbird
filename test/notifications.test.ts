import { describe, expect, it } from "vitest";
import { inQuietHours, shouldNotify, toolsLostNotice } from "../src/main/notifications";
import type { Settings } from "../src/shared/types";

const at = (h: number, m = 0) => new Date(2026, 9, 4, h, m);
const base = { notifications: true } as Settings;

describe("notification controls", () => {
  it("knows quiet hours, including a span past midnight", () => {
    const night = { enabled: true, from: "18:00", to: "08:00" };
    expect(inQuietHours(night, at(22))).toBe(true);
    expect(inQuietHours(night, at(7, 59))).toBe(true);
    expect(inQuietHours(night, at(8))).toBe(false);
    expect(inQuietHours(night, at(12))).toBe(false);
    const lunch = { enabled: true, from: "12:00", to: "13:00" };
    expect(inQuietHours(lunch, at(12, 30))).toBe(true);
    expect(inQuietHours(lunch, at(13))).toBe(false);
    expect(inQuietHours({ ...night, enabled: false }, at(22))).toBe(false);
    expect(inQuietHours({ enabled: true, from: "25:00", to: "08:00" }, at(2))).toBe(false); // nonsense never silences
  });
  it("lets a session be muted, and finished turns be left out", () => {
    expect(shouldNotify({ settings: base, kind: "waiting", now: at(12) })).toBe(true);
    expect(shouldNotify({ settings: base, session: { muted: true }, kind: "waiting", now: at(12) })).toBe(false);
    expect(shouldNotify({ settings: { ...base, notifyFinished: false }, kind: "finished", now: at(12) })).toBe(false);
    expect(shouldNotify({ settings: { ...base, notifyFinished: false }, kind: "waiting", now: at(12) })).toBe(true);
    expect(shouldNotify({ settings: { ...base, quietHours: { enabled: true, from: "18:00", to: "08:00" } }, kind: "waiting", now: at(23) })).toBe(false);
    expect(shouldNotify({ settings: { ...base, notifications: false }, kind: "waiting", now: at(12) })).toBe(false);
  });
  it("names the pane that lost its Mockingbird tools and says why, as its tool server gave it", () => {
    expect(toolsLostNotice({ title: "Filter orgs", why: "its token file is gone, as it is once the launch it was made for has ended" })).toEqual({
      title: "Filter orgs lost its Mockingbird tools",
      body: "Its token file is gone, as it is once the launch it was made for has ended. Messages and wires won't work from that agent.",
    });
  });
});
