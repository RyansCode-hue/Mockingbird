import { describe, expect, it } from "vitest";
import { NO_READ_NOTES, noteCleared, noteDismissed, noteFailed } from "../src/renderer/readNotes";

describe("the status bar's notes of failed reads", () => {
  it("keeps one for each source: one read failing never overwrites another's", () => {
    const n = noteFailed(noteFailed(NO_READ_NOTES, "closed", "Couldn't read closed: x"), "gone", "Couldn't read gone: y");
    expect(n.shown).toEqual({ closed: "Couldn't read closed: x", gone: "Couldn't read gone: y" });
  });

  it("takes a source's note off when it's read, leaving the others", () => {
    const n = noteFailed(noteFailed(NO_READ_NOTES, "closed", "x"), "gone", "y");
    expect(noteCleared(n, "closed").shown).toEqual({ gone: "y" });
    expect(noteCleared(n, "nothing")).toBe(n);
  });

  it("keeps a dismissed note away while its source fails with the same words, as a retry would bring it back", () => {
    const shown = noteFailed(NO_READ_NOTES, "closed", "x");
    const gone = noteDismissed(shown, "closed");
    expect(gone.shown).toEqual({});
    expect(noteFailed(gone, "closed", "x").shown).toEqual({});
  });

  it("shows it again when the failure's different: that's news", () => {
    const gone = noteDismissed(noteFailed(NO_READ_NOTES, "closed", "x"), "closed");
    const other = noteFailed(gone, "closed", "z");
    expect(other.shown).toEqual({ closed: "z" });
    expect(other.dismissed).toEqual({});
  });

  it("shows it again when it fails after a success", () => {
    const gone = noteDismissed(noteFailed(NO_READ_NOTES, "closed", "x"), "closed");
    const read = noteCleared(gone, "closed");
    expect(read).toEqual(NO_READ_NOTES);
    expect(noteFailed(read, "closed", "x").shown).toEqual({ closed: "x" });
  });

  it("dismisses only what's shown, and only that source's", () => {
    const n = noteFailed(noteFailed(NO_READ_NOTES, "closed", "x"), "gone", "y");
    expect(noteDismissed(n, "nothing")).toBe(n);
    expect(noteDismissed(n, "closed").shown).toEqual({ gone: "y" });
  });

  it("takes any name for a source, those of an object's own included", () => {
    const n = noteDismissed(noteFailed(NO_READ_NOTES, "constructor", "x"), "constructor");
    expect(n.shown).toEqual({});
    expect(noteFailed(n, "toString", "y").shown).toEqual({ toString: "y" });
  });
});
