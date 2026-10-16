import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { CHANGELOG, CHANGE_KIND_LABEL, COMING_NEXT, releaseOf, shortDate } from "../src/shared/changelog";
import { isNewer } from "../src/shared/versions";

describe("the changelog", () => {
  it("has an entry for package.json's version: a version bump adds its changelog entry in the same commit", () => {
    expect(releaseOf(pkg.version), `src/shared/changelog.ts has no entry for ${pkg.version}`).not.toBeNull();
    expect(CHANGELOG[0].version).toBe(pkg.version);
  });

  it("lists each version once, newest first, with a real date that never goes forward down the list", () => {
    const versions = CHANGELOG.map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < CHANGELOG.length; i++) {
      const [newer, older] = [CHANGELOG[i - 1], CHANGELOG[i]];
      expect(isNewer(older.version, newer.version), `${newer.version} should come before ${older.version}`).toBe(true);
      expect(newer.date >= older.date, `${newer.version} (${newer.date}) is dated before ${older.version} (${older.date})`).toBe(true);
    }
    for (const r of CHANGELOG) {
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(r.date))).toBe(false);
    }
  });

  it("keeps each version to a short list of one-line, user-facing changes of a known kind", () => {
    for (const r of CHANGELOG) {
      expect(r.items.length, r.version).toBeGreaterThan(0);
      expect(r.items.length, r.version).toBeLessThanOrEqual(8);
      for (const c of r.items) {
        expect(Object.keys(CHANGE_KIND_LABEL)).toContain(c.kind);
        expect(c.text.trim()).toBe(c.text);
        expect(c.text).not.toMatch(/\n/);
        expect(c.text.length, c.text).toBeLessThanOrEqual(110);
        // docs, tests and internal changes stay out
        expect(c.text).not.toMatch(/\b(README|AGENTS\.md|vitest|e2e|refactor)\b/i);
      }
    }
  });

  it("goes back to 1.0.0 and covers every 1.4 release", () => {
    expect(CHANGELOG.at(-1)?.version).toBe("1.0.0");
    for (let n = 0; n <= 10; n++) expect(releaseOf(`1.4.${n}`), `1.4.${n}`).not.toBeNull();
  });

  it("has a handful of coming-next items, each a title and a line", () => {
    expect(COMING_NEXT.length).toBeGreaterThanOrEqual(4);
    expect(COMING_NEXT.length).toBeLessThanOrEqual(8);
    for (const c of COMING_NEXT) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.text.length).toBeGreaterThan(0);
    }
  });

  it("writes a date as day and month, read as a calendar day", () => {
    expect(shortDate("2026-10-14")).toBe("14 Oct");
    expect(shortDate("2026-01-01")).toBe("1 Jan");
    expect(shortDate("not a date")).toBe("not a date");
  });
});
