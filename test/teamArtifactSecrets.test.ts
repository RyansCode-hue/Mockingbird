import { describe, expect, it } from "vitest";
import { until } from "../src/main/team/loopback";
import { items, sides } from "./artifactSides";

/** What room agents may not read stays that way, however it's copied, written or added. */

describe("a copy of a note agents may not read", () => {
  it("stays unreadable to them on every member, whatever it's called", async () => {
    const { roomId, sides: [ryan, nick] } = await sides(["Ryan", "Nick"]);
    const env = ryan.arts.addNote(roomId, ".env", "TOKEN=hunter2");
    const renamed = ryan.arts.addNote(roomId, "creds.pem", "x");
    ryan.arts.rename(roomId, renamed.id, "harmless");
    await until(() => items(nick.m.team.room(roomId)).length === 2 && items(nick.m.team.room(roomId))[1].name === "harmless", "Nick to have them");
    const copies = [nick.arts.saveNote(roomId, env.id, "TOKEN=hunter3", env.id, "copy") as { copy: string }, nick.arts.saveNote(roomId, renamed.id, "y", renamed.id, "copy") as { copy: string }];
    await until(() => items(ryan.m.team.room(roomId)).length === 4, "Ryan to have the copies");
    for (const { copy } of copies) {
      nick.arts.rename(roomId, copy, "plain notes");
      await until(() => items(ryan.m.team.room(roomId)).find((a) => a.id === copy)?.name === "plain notes", "the rename to arrive");
      for (const s of [ryan, nick]) {
        const rec = items(s.m.team.room(roomId)).find((a) => a.id === copy)!;
        expect(rec).toMatchObject({ kind: "note", wasSecret: true });
        expect(s.arts.blockedReason(roomId, rec)).toMatch(/named like a secret file/);
      }
    }
    // a copy of an ordinary note is an ordinary note
    const spec = ryan.arts.addNote(roomId, "Spec", "plain");
    const plain = ryan.arts.saveNote(roomId, spec.id, "plainer", spec.id, "copy") as { copy: string };
    expect(ryan.arts.blockedReason(roomId, items(ryan.m.team.room(roomId)).find((a) => a.id === plain.copy)!)).toBeNull();
  });
});
