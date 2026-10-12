import { describe, expect, it } from "vitest";
import { until } from "../src/main/team/loopback";
import { items, sides } from "./artifactSides";
import { assistantArtifacts } from "../src/main/team/artifactTools";

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

const PEM = "deploy key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n";

describe("a note holding a private key", () => {
  it("is added or saved only once the person confirms", async () => {
    const { roomId, sides: [ryan] } = await sides(["Ryan"]);
    expect(ryan.arts.newNote(roomId, "Deploy", PEM)).toEqual({ needsConfirm: "secret", reason: expect.stringMatching(/^It holds a private key/) });
    expect(items(ryan.m.team.room(roomId))).toEqual([]);
    const added = ryan.arts.newNote(roomId, "Deploy", PEM, true) as { id: string };
    expect(items(ryan.m.team.room(roomId)).map((a) => a.id)).toEqual([added.id]);
    // a save that brings one in asks; one that keeps it doesn't
    const spec = ryan.arts.addNote(roomId, "Spec", "plain");
    expect(ryan.arts.saveNote(roomId, spec.id, `plain\n${PEM}`, spec.id, "save")).toEqual({ needsConfirm: "secret", reason: expect.any(String) });
    const saved = ryan.arts.saveNote(roomId, spec.id, `plain\n${PEM}`, spec.id, "save", true) as { rev: string };
    expect(saved.rev).toEqual(expect.any(String));
    expect(ryan.arts.saveNote(roomId, spec.id, `plainer\n${PEM}`, saved.rev, "save")).toEqual({ rev: expect.any(String) });
    expect(ryan.arts.saveNote(roomId, added.id, PEM, added.id, "copy")).toMatchObject({ needsConfirm: "secret" });
  });

  it("is withheld from agents and @assistant", async () => {
    const { roomId, sides: [ryan, nick] } = await sides(["Ryan", "Nick"]);
    const key = ryan.arts.newNote(roomId, "Deploy", PEM, true) as { id: string };
    await until(() => items(nick.m.team.room(roomId)).length === 1, "Nick to have it");
    const rec = items(nick.m.team.room(roomId))[0];
    expect(nick.arts.blockedReason(roomId, rec)).toBe("It holds a private key: agents never read it");
    expect((await nick.arts.list(roomId)).items[0].agentsBlocked).toMatch(/private key/);
    const section = (await assistantArtifacts(roomId, [key.id]))!;
    expect(section).toContain("(withheld: It holds a private key");
    expect(section).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
  });
});
