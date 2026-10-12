import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { loopbackRoom, until } from "../src/main/team/loopback";
import "../src/main/team/artifactEvents";
import "../src/main/team/chat";
import { conflictName } from "../src/main/team/artifactEvents";
import { isSecretFileName } from "../src/main/secrets";
import { artifactRef, MAX_ARTIFACTS, MAX_ARTIFACT_FILE, MAX_NOTE_TEXT, type ArtifactAdd, type ArtifactRecord } from "../src/shared/team/artifacts";
import type { RoomState } from "../src/shared/team/types";

const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);
const file = (over: Partial<Extract<ArtifactAdd, { kind: "file" }>> = {}): ArtifactAdd => ({ kind: "file", name: "shot.png", size: 10, sha256: SHA, mime: "image/png", ...over });
const items = (room: RoomState | undefined): ArtifactRecord[] => room?.ext.artifacts?.items ?? [];

async function room(names = ["Ryan", "Nick"]) {
  return loopbackRoom(names, { dir: tempDir("artifacts") });
}

describe("artifact events", () => {
  it("refuse every malformed or oversized body before it's stored", async () => {
    const { roomId, members } = await room(["Ryan"]);
    const t = members[0].team;
    const bad: [unknown, RegExp][] = [
      [{ kind: "video", name: "x" }, /kind/],
      [{ ...file(), name: "" }, /name/],
      [{ ...file(), name: " padded" }, /name/],
      [{ ...file(), name: "x".repeat(201) }, /name/],
      [{ ...file(), name: "bell\u0007" }, /control/],
      [{ ...file(), size: MAX_ARTIFACT_FILE + 1 }, /size/],
      [{ ...file(), size: -1 }, /size/],
      [{ ...file(), size: 1.5 }, /size/],
      [{ ...file(), sha256: "A".repeat(64) }, /sha256/],
      [{ ...file(), sha256: "../../etc/passwd" }, /sha256/],
      [{ ...file(), mime: "text/html; charset=utf-8" }, /mime/],
      [{ kind: "note", name: "n", text: "x".repeat(MAX_NOTE_TEXT + 1) }, /text/],
      [{ kind: "note", name: "n", text: "esc \u001b[31m" }, /control/],
      [{ kind: "repo", name: "r", origin: "https://ryan:token@github.com/acme/app.git", path: "a.ts", commit: COMMIT }, /origin/],
      [{ kind: "repo", name: "r", origin: "https://github.com/acme/app.git?token=x", path: "a.ts", commit: COMMIT }, /origin/],
      [{ kind: "repo", name: "r", origin: "https://github.com/acme/app.git", path: "/etc/passwd", commit: COMMIT }, /path/],
      [{ kind: "repo", name: "r", origin: "https://github.com/acme/app.git", path: "src/../../x", commit: COMMIT }, /path/],
      [{ kind: "repo", name: "r", origin: "https://github.com/acme/app.git", path: "src\u0000x", commit: COMMIT }, /path/],
      [{ kind: "repo", name: "r", origin: "https://github.com/acme/app.git", path: "a.ts", commit: "abc1234" }, /commit/],
      [{ kind: "repo", name: "r", origin: "https://github.com/acme/app.git", path: "a.ts", commit: COMMIT, lines: [5, 2] }, /lines/],
      [{ kind: "repo", name: "r", origin: "https://github.com/acme/app.git", path: "a.ts", commit: COMMIT, lines: [0, 2] }, /lines/],
      [{ kind: "link", name: "l", url: "http://example.com" }, /https/],
      [{ kind: "link", name: "l", url: "javascript:alert(1)" }, /https/],
      [{ kind: "link", name: "l", url: "https://user:pw@example.com/" }, /user name/],
      [{ kind: "link", name: "l", url: `https://example.com/${"x".repeat(2000)}` }, /url/],
    ];
    for (const [body, err] of bad) expect(() => t.publish(roomId, "artifact.add", body as ArtifactAdd), JSON.stringify(body).slice(0, 80)).toThrow(err);
    const id = t.publish(roomId, "artifact.add", file()).id;
    const badUpdates: [unknown, RegExp][] = [
      [{ id: "short" }, /id/],
      [{ id }, /changes the name or the text/],
      [{ id, text: "new" }, /revision/],
      [{ id, name: "x", base: id }, /base goes with text/],
      [{ id, name: "" }, /name/],
    ];
    for (const [body, err] of badUpdates) expect(() => t.publish(roomId, "artifact.update", body as any)).toThrow(err);
    expect(() => t.publish(roomId, "artifact.remove", { id: "../x" } as any)).toThrow(/id/);
    expect(items(t.room(roomId))).toHaveLength(1);
  });

  it("add, rename, edit and remove the same on every member; anything after a removal changes nothing", async () => {
    const { roomId, members } = await room();
    const [ryan, nick] = members;
    const note = ryan.team.publish(roomId, "artifact.add", { kind: "note", name: "Spec", text: "v1" });
    const link = ryan.team.publish(roomId, "artifact.add", { kind: "link", name: "ADO 5110", url: "https://dev.azure.com/acme/web/_workitems/edit/5110" });
    const repo = nick.team.publish(roomId, "artifact.add", { kind: "repo", name: "x.ts:2–4", origin: "https://github.com/acme/app.git", path: "src/x.ts", commit: COMMIT, lines: [2, 4] });
    await until(() => items(nick.team.room(roomId)).length === 3 && items(ryan.team.room(roomId)).length === 3, "both to have three");
    nick.team.publish(roomId, "artifact.update", { id: note.id, text: "v2", base: note.id });
    nick.team.publish(roomId, "artifact.update", { id: link.id, name: "Work item" });
    await until(() => items(ryan.team.room(roomId)).find((a) => a.id === note.id)?.kind === "note" && (items(ryan.team.room(roomId)).find((a) => a.id === note.id) as any).text === "v2", "Ryan to see Nick's edit");
    const n = items(ryan.team.room(roomId)).find((a) => a.id === note.id)!;
    expect(n).toMatchObject({ rev: expect.not.stringMatching(note.id), updatedBy: nick.id, addedBy: ryan.id });
    ryan.team.publish(roomId, "artifact.remove", { id: repo.id });
    ryan.team.publish(roomId, "artifact.update", { id: repo.id, name: "back from the dead" });
    await until(() => items(nick.team.room(roomId)).length === 2, "Nick to see the removal");
    await until(() => items(nick.team.room(roomId)).find((a) => a.id === link.id)?.name === "Work item", "the rename");
    expect(items(nick.team.room(roomId))).toEqual(items(ryan.team.room(roomId)));
    expect(items(nick.team.room(roomId)).map((a) => a.id)).toEqual([note.id, link.id]);
  });

  it("stop at the room's limit, the same on every member", async () => {
    const { roomId, members } = await room(["Ryan"]);
    const t = members[0].team;
    for (let i = 0; i < MAX_ARTIFACTS + 3; i++) t.publish(roomId, "artifact.add", { kind: "link", name: `l${i}`, url: `https://example.com/${i}` });
    expect(items(t.room(roomId))).toHaveLength(MAX_ARTIFACTS);
    expect(items(t.room(roomId)).at(-1)!.name).toBe(`l${MAX_ARTIFACTS - 1}`);
  });

  it("keep a secret-named artifact secret whatever it's renamed to", async () => {
    const { roomId, members } = await room(["Ryan"]);
    const t = members[0].team;
    const env = t.publish(roomId, "artifact.add", file({ name: ".env", mime: "text/plain" }));
    const plain = t.publish(roomId, "artifact.add", file({ name: "notes.txt", mime: "text/plain" }));
    t.publish(roomId, "artifact.update", { id: env.id, name: "env.txt" });
    t.publish(roomId, "artifact.update", { id: plain.id, name: "prod.pem" });
    t.publish(roomId, "artifact.update", { id: plain.id, name: "notes again.txt" });
    const byId = new Map(items(t.room(roomId)).map((a) => [a.id, a]));
    expect(byId.get(env.id)).toMatchObject({ name: "env.txt", wasSecret: true });
    expect(byId.get(plain.id)).toMatchObject({ name: "notes again.txt", wasSecret: true });
  });

  it("turn an edit that crossed another into a copy, identically on both sides of a partition", async () => {
    const { roomId, members, net } = await room();
    const [ryan, nick] = members;
    const spec = ryan.team.publish(roomId, "artifact.add", { kind: "note", name: "Spec", text: "v1" });
    await until(() => items(nick.team.room(roomId)).length === 1, "Nick to have the note");
    net.partition(ryan.id, nick.id);
    await until(() => ryan.team.presence(roomId).length === 0, "the partition");
    ryan.team.publish(roomId, "artifact.update", { id: spec.id, text: "Ryan's v2", base: spec.id });
    nick.team.publish(roomId, "artifact.update", { id: spec.id, text: "Nick's v2", base: spec.id });
    net.partition(ryan.id, nick.id, false);
    await until(() => items(ryan.team.room(roomId)).length === 2 && items(nick.team.room(roomId)).length === 2, "both to have the copy");
    expect(items(ryan.team.room(roomId))).toEqual(items(nick.team.room(roomId)));
    const [orig, copy] = items(ryan.team.room(roomId)) as any[];
    expect(orig.id).toBe(spec.id);
    expect(copy.conflictOf).toBe(spec.id);
    // whichever edit sorts first in the room's order wins; the other is kept as its author's copy
    const winner = orig.updatedBy === ryan.id ? "Ryan" : "Nick";
    const loser = winner === "Ryan" ? "Nick" : "Ryan";
    expect(orig.text).toBe(`${winner}'s v2`);
    expect(copy).toMatchObject({ kind: "note", name: `Spec (${loser}'s edit)`, text: `${loser}'s v2` });
  });

  it("name crossing copies within the name limit", () => {
    expect(conflictName("Spec", "Nick")).toBe("Spec (Nick's edit)");
    expect(conflictName("x".repeat(200), "Nick")).toHaveLength(200);
    expect(conflictName("x".repeat(200), "Nick").endsWith(" (Nick's edit)")).toBe(true);
  });
});

describe("chat messages naming artifacts", () => {
  it("carry the live ones they name; an older body without the field is unchanged", async () => {
    const { roomId, members } = await room();
    const [ryan, nick] = members;
    const a = ryan.team.publish(roomId, "artifact.add", { kind: "note", name: "Spec", text: "v1" });
    const plain = ryan.team.publish(roomId, "chat.message", { text: "hello", mentions: [] });
    const ref = ryan.team.publish(roomId, "chat.message", { text: `see ${artifactRef(a.id, "Spec")}`, mentions: [], artifacts: [a.id] });
    await until(() => (nick.team.room(roomId)?.ext.chat?.entries.length ?? 0) >= 3, "Nick to have both messages");
    const entries = nick.team.room(roomId)!.ext.chat!.entries;
    expect(entries.find((e) => e.id === plain.id)).not.toHaveProperty("artifacts");
    expect(entries.find((e) => e.id === ref.id)!.artifacts).toEqual([a.id]);
    expect(() => ryan.team.publish(roomId, "chat.message", { text: "x", mentions: [], artifacts: ["nope"] })).toThrow(/artifact id/);
    expect(() => ryan.team.publish(roomId, "chat.message", { text: "x", mentions: [], artifacts: Array(21).fill(a.id) })).toThrow(/up to 20/);
    expect(() => ryan.team.publish(roomId, "chat.message", { text: "x", mentions: [], artifacts: "x" as any })).toThrow(/list/);
  });
});

describe("secret names", () => {
  it("match the secret file list by the last path segment, ignoring case", () => {
    for (const n of [".env", ".ENV", ".env.local", "prod.env", "server.pem", "id.KEY", "cert.pfx", "x.p12", "ado.pat", "my_pat.txt", "azure-pat.txt", "pat.txt", "credentials.json", "secrets.json", "local.settings.json", "some/dir/.env", "C:\\x\\.env"]) expect(isSecretFileName(n), n).toBe(true);
    for (const n of ["env.txt", "notes.md", "src/env.ts", "keys.ts", "patterns.txt", "settings.json", "credentials.ts", "", "  "]) expect(isSecretFileName(n), n).toBe(false);
  });
});
