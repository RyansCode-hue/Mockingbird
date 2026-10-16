import { describe, expect, it } from "vitest";
import { readPref, writePref, type PrefStore } from "../src/renderer/prefs";
import { LAST_SEEN_KEY, justUpdated, seenNow, versionLabel } from "../src/renderer/whatsNewModel";

/** One launch as main.tsx runs it: decide, record what's seen now, and return what the top bar shows. */
function launch(store: PrefStore, current: string, outcome: { ok: boolean; to: string } | null = null) {
  const last = readPref<string | null>(LAST_SEEN_KEY, null, store);
  let updated = justUpdated(current, last, outcome);
  const seen = seenNow(current, last, updated);
  if (seen) writePref(LAST_SEEN_KEY, seen, store);
  const opened = updated;
  return {
    label: () => versionLabel(current, updated),
    opened,
    dismiss: () => {
      if (updated) writePref(LAST_SEEN_KEY, current, store);
      updated = false;
    },
  };
}

const memory = (): PrefStore => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

describe("What's new after an update", () => {
  it("is an update only when the last version seen is older, or, with none seen, when an in-app update just landed on it", () => {
    expect(justUpdated("1.4.11", "1.4.10")).toBe(true);
    expect(justUpdated("1.5.0", "1.4.10")).toBe(true);
    expect(justUpdated("1.4.11", "1.4.11")).toBe(false);
    expect(justUpdated("1.4.10", "1.4.11")).toBe(false); // a downgrade
    expect(justUpdated("1.4.11", null)).toBe(false); // a first install
    expect(justUpdated("1.4.11", null, { ok: true, to: "1.4.11" })).toBe(true);
    expect(justUpdated("1.4.11", null, { ok: false, to: "1.4.11" })).toBe(false);
    expect(justUpdated("1.4.10", null, { ok: true, to: "1.4.11" })).toBe(false); // the installer didn't land it
    expect(justUpdated("", "1.4.10")).toBe(false);
  });

  it("records the version at once unless an update's notes wait to be dismissed", () => {
    expect(seenNow("1.4.11", null, false)).toBe("1.4.11");
    expect(seenNow("1.4.11", "1.4.11", false)).toBeNull();
    expect(seenNow("1.4.11", "1.4.10", true)).toBeNull();
    expect(seenNow("1.4.10", "1.4.11", false)).toBe("1.4.10");
  });

  it("labels the version \"Updated to\" and opens the notes once, until they're dismissed, then \"v\" until the next update", () => {
    const store = memory();
    // a first install is no update
    const first = launch(store, "1.4.10");
    expect(first.label()).toBe("v1.4.10");
    expect(first.opened).toBe(false);
    // the first launch on 1.4.11
    const updated = launch(store, "1.4.11");
    expect(updated.label()).toBe("Updated to 1.4.11");
    expect(updated.opened).toBe(true);
    // quitting without dismissing shows it again next launch
    expect(launch(store, "1.4.11").label()).toBe("Updated to 1.4.11");
    const again = launch(store, "1.4.11");
    again.dismiss();
    expect(again.label()).toBe("v1.4.11");
    // and it stays that way
    const later = launch(store, "1.4.11");
    expect(later.label()).toBe("v1.4.11");
    expect(later.opened).toBe(false);
    // until the next update
    expect(launch(store, "1.4.12").label()).toBe("Updated to 1.4.12");
  });

  it("knows an update from before What's new existed by the update's own outcome", () => {
    const store = memory();
    const l = launch(store, "1.4.11", { ok: true, to: "1.4.11" });
    expect(l.label()).toBe("Updated to 1.4.11");
    l.dismiss();
    expect(launch(store, "1.4.11").label()).toBe("v1.4.11");
  });
});
