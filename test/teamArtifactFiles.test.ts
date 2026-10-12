import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { until } from "../src/main/team/loopback";
import { artifactViewer } from "../src/main/team/artifactViewer";
import { ARTIFACT_CHUNK } from "../src/shared/team/artifacts";
import { blobOf, eventually, fileRec, items, randomFile, sides, summaryOf, type Side } from "./artifactSides";

const handlers = (s: Side) => (s.m.team as any).requestHandlers as Map<string, (p: any, ctx: any) => unknown>;

describe("room files between members", () => {
  it("reach a teammate byte-identical, hash-checked, and show as present", async () => {
    // full-size chunks: each answer crosses the wire in many parts
    const { roomId, sides: [ryan, nick], dir } = await sides(["Ryan", "Nick"], { timing: { chunkBytes: ARTIFACT_CHUNK } });
    const src = randomFile(path.join(dir, "src"), "dump.bin", 1_300_000);
    const { added, refused } = await ryan.arts.addFiles(roomId, [src]);
    expect(refused).toEqual([]);
    const id = added[0].id;
    expect(await summaryOf(ryan, roomId, id)).toMatchObject({ kind: "file", name: "dump.bin", size: 1_300_000, local: { state: "present", view: "binary" }, addedByName: "Ryan", agentsBlocked: null });
    await until(() => !!blobOf(nick, roomId, id), "Nick to have the file");
    expect(blobOf(nick, roomId, id)!.equals(fs.readFileSync(src))).toBe(true);
    expect(await summaryOf(nick, roomId, id)).toMatchObject({ local: { state: "present", view: "binary" } });
    expect(nick.logs.some((l) => /fetching room file dump\.bin .* from Ryan$/.test(l))).toBe(true);
  });

  it("come from any member who has them when the adder is offline", async () => {
    const { roomId, net, sides: [ryan, nick, sam], dir } = await sides(["Ryan", "Nick", "Sam"]);
    net.setOnline(nick.m.id, false);
    await until(() => ryan.m.team.presence(roomId).length === 1, "Nick to drop");
    const { added } = await ryan.arts.addFiles(roomId, [randomFile(path.join(dir, "src"), "shot.png", 1000)]);
    const id = added[0].id;
    await until(() => !!blobOf(sam, roomId, id), "Sam to have it");
    net.setOnline(ryan.m.id, false);
    await until(() => sam.m.team.presence(roomId).length === 0, "Ryan to drop");
    net.setOnline(nick.m.id, true);
    await until(() => !!blobOf(nick, roomId, id), "Nick to get it from Sam");
    expect(blobOf(nick, roomId, id)!.equals(blobOf(sam, roomId, id)!)).toBe(true);
    expect(nick.logs.some((l) => /from Sam$/.test(l))).toBe(true);
  });

  it("wait, saying why, while nobody connected has a file", async () => {
    const { roomId, net, sides: [ryan, nick], dir } = await sides(["Ryan", "Nick"]);
    // Ryan drops before a byte moves
    const serve = handlers(ryan).get("artifact.chunk")!;
    handlers(ryan).set("artifact.chunk", () => {
      net.setOnline(ryan.m.id, false);
      throw new Error("gone");
    });
    const { added } = await ryan.arts.addFiles(roomId, [randomFile(path.join(dir, "src"), "a.txt", 10)]);
    const id = added[0].id;
    await eventually(async () => (await summaryOf(nick, roomId, id))?.local?.state === "waiting", "Nick to wait");
    expect((await summaryOf(nick, roomId, id)).local).toEqual({ state: "waiting", problem: "Ryan added it and is offline; no connected teammate has it yet" });
    handlers(ryan).set("artifact.chunk", serve);
    net.setOnline(ryan.m.id, true);
    await until(() => !!blobOf(nick, roomId, id), "Nick to get it once Ryan's back");
  });

  it("say when a teammate's Mockingbird can't share files yet", async () => {
    const { roomId, sides: [ryan, nick], dir } = await sides(["Ryan", "Nick"]);
    handlers(ryan).delete("artifact.chunk");
    handlers(ryan).delete("artifact.have");
    const { added } = await ryan.arts.addFiles(roomId, [randomFile(path.join(dir, "src"), "a.txt", 10)]);
    await eventually(async () => (await summaryOf(nick, roomId, added[0].id))?.local?.state === "failed", "Nick's download to fail");
    expect((await summaryOf(nick, roomId, added[0].id)).local).toEqual({ state: "failed", problem: "Ryan's Mockingbird needs an update to share files" });
  });

  it("throw away a corrupted copy, say so, and fetch from the next member", async () => {
    const { roomId, net, sides: [ryan, nick, sam], dir } = await sides(["Ryan", "Nick", "Sam"]);
    net.setOnline(nick.m.id, false);
    await until(() => ryan.m.team.presence(roomId).length === 1, "Nick to drop");
    const { added } = await ryan.arts.addFiles(roomId, [randomFile(path.join(dir, "src"), "spec.pdf", 200_000)]);
    const id = added[0].id;
    await until(() => !!blobOf(sam, roomId, id), "Sam to have it");
    const blob = ryan.arts.blobPath(roomId, fileRec(ryan, roomId, id).sha256);
    fs.chmodSync(blob, 0o600);
    fs.writeFileSync(blob, crypto.randomBytes(200_000));
    // Nick asks Ryan, the adder, first
    net.partition(nick.m.id, sam.m.id);
    net.setOnline(nick.m.id, true);
    await until(() => nick.logs.some((l) => /what Ryan sent doesn't match the file's hash; it was thrown away/.test(l)), "the bad copy to be refused");
    expect(blobOf(nick, roomId, id)).toBeNull();
    net.partition(nick.m.id, sam.m.id, false);
    await until(() => !!blobOf(nick, roomId, id), "Nick to get a good copy from Sam");
    expect(blobOf(nick, roomId, id)!.equals(blobOf(sam, roomId, id)!)).toBe(true);
    expect(nick.logs.some((l) => /from Sam/.test(l))).toBe(true);
  });

  it("refuse pieces that weren't asked for, keeping nothing of them", async () => {
    const { roomId, sides: [ryan, nick], dir } = await sides(["Ryan", "Nick"]);
    const serve = handlers(ryan).get("artifact.chunk")!;
    let served = 0;
    handlers(ryan).set("artifact.chunk", (p, ctx) => {
      const r = serve(p, ctx) as { offset: number };
      return ++served >= 2 ? { ...r, offset: r.offset + 1 } : r;
    });
    const { added } = await ryan.arts.addFiles(roomId, [randomFile(path.join(dir, "src"), "big.bin", 300_000)]);
    const id = added[0].id;
    await eventually(async () => (await summaryOf(nick, roomId, id))?.local?.state === "failed", "Nick's download to fail");
    expect((await summaryOf(nick, roomId, id)).local).toEqual({ state: "failed", problem: "Ryan sent a piece that wasn't asked for" });
    expect(fs.existsSync(path.join(nick.m.store.dir, roomId, "artifacts", "partial", fileRec(nick, roomId, id).sha256))).toBe(false);
    handlers(ryan).set("artifact.chunk", serve);
    await nick.arts.download(roomId, id);
    await until(() => !!blobOf(nick, roomId, id), "a good copy on retry");
  });

  it("resume a download cut short from what arrived", async () => {
    const { roomId, net, sides: [ryan, nick], dir } = await sides(["Ryan", "Nick"]);
    const serve = handlers(ryan).get("artifact.chunk")!;
    let served = 0;
    handlers(ryan).set("artifact.chunk", (p, ctx) => {
      const r = serve(p, ctx);
      if (++served === 4) net.setOnline(ryan.m.id, false);
      return r;
    });
    const src = randomFile(path.join(dir, "src"), "big.bin", 1024 * 1024);
    const { added } = await ryan.arts.addFiles(roomId, [src]);
    const id = added[0].id;
    await until(() => ryan.m.team.presence(roomId).length === 0, "Ryan to drop mid-transfer");
    const partial = path.join(nick.m.store.dir, roomId, "artifacts", "partial", fileRec(nick, roomId, id).sha256);
    await until(() => fs.existsSync(partial) && fs.statSync(partial).size > 0, "a partial download");
    const got = fs.statSync(partial).size;
    expect(got).toBeLessThan(1024 * 1024);
    net.setOnline(ryan.m.id, true);
    await until(() => !!blobOf(nick, roomId, id), "the rest");
    expect(blobOf(nick, roomId, id)!.equals(fs.readFileSync(src))).toBe(true);
    expect(nick.logs.some((l) => l.includes(`resuming at ${got} bytes`))).toBe(true);
  });

  it("are served only from the room asked about, while live, and only to its members", async () => {
    const { roomId, sides: [ryan, nick], dir } = await sides(["Ryan", "Nick"]);
    const other = ryan.m.team.createRoom({ name: "private", groupKey: "private", signalingUrl: "http://loopback.invalid" });
    const mine = await ryan.arts.addFiles(other.id, [randomFile(path.join(dir, "src"), "mine.txt", 100)]);
    const gone = await ryan.arts.addFiles(roomId, [randomFile(path.join(dir, "src"), "gone.txt", 100)]);
    const goneSha = fileRec(ryan, roomId, gone.added[0].id).sha256;
    ryan.arts.remove(roomId, gone.added[0].id);
    const otherSha = fileRec(ryan, other.id, mine.added[0].id).sha256;
    const ask = (params: unknown, room?: string) => nick.m.team.request(ryan.m.id, "artifact.chunk", params, room ? { roomId: room } : {});
    await expect(ask({ sha256: otherSha, offset: 0, length: 10 }, roomId)).rejects.toThrow(/no such file in this room/);
    await expect(ask({ sha256: otherSha, offset: 0, length: 10 }, other.id)).rejects.toThrow(/not a member of that room/);
    await expect(ask({ sha256: otherSha, offset: 0, length: 10 })).rejects.toThrow(/made for a room/);
    await expect(ask({ sha256: goneSha, offset: 0, length: 10 }, roomId)).rejects.toThrow(/no such file in this room/);
    await expect(ask({ sha256: "../../identity.json", offset: 0, length: 10 }, roomId)).rejects.toThrow(/64 hex/);
    await expect(ask({ sha256: otherSha, offset: 0, length: 2 * 1024 * 1024 }, roomId)).rejects.toThrow(/length/);
    expect(await nick.m.team.request(ryan.m.id, "artifact.have", { sha256s: [otherSha, goneSha] }, { roomId })).toEqual({ have: [] });
  });

  it("are deleted on every member once removed, agents' copies included", async () => {
    const { roomId, sides: [ryan, nick], dir } = await sides(["Ryan", "Nick"]);
    const { added } = await ryan.arts.addFiles(roomId, [randomFile(path.join(dir, "src"), "shot.png", 500)]);
    const id = added[0].id;
    await until(() => !!blobOf(nick, roomId, id), "Nick to have it");
    const rec = fileRec(nick, roomId, id);
    const agentDir = path.join(dir, "wt", ".mockingbird", "artifacts", id);
    expect(fs.existsSync(await nick.arts.copyForAgent(roomId, rec, agentDir, "shot.png"))).toBe(true);
    const blob = (s: Side) => path.join(s.m.store.dir, roomId, "artifacts", "blobs", rec.sha256);
    ryan.arts.remove(roomId, id);
    await until(() => items(nick.m.team.room(roomId)).length === 0, "Nick to see the removal");
    await until(() => !fs.existsSync(blob(ryan)) && !fs.existsSync(blob(nick)), "both copies of the file to go");
    await until(() => !fs.existsSync(agentDir), "the agent's copy to go");
  });

  it("beyond the room's eager budget, wait to be opened", async () => {
    const { roomId, sides: [ryan, nick], dir } = await sides(["Ryan", "Nick"], { eagerBytes: 100 });
    const big = await ryan.arts.addFiles(roomId, [randomFile(path.join(dir, "src"), "big.txt", 5000)]);
    const small = await ryan.arts.addFiles(roomId, [randomFile(path.join(dir, "src"), "small.txt", 50)]);
    await until(() => !!blobOf(nick, roomId, small.added[0].id), "the small one to come by itself");
    expect((await summaryOf(nick, roomId, big.added[0].id)).local).toEqual({ state: "on-demand" });
    expect(await nick.arts.read(roomId, big.added[0].id)).toMatchObject({ view: "missing" });
    await until(() => !!blobOf(nick, roomId, big.added[0].id), "the big one, once opened");
    expect(await nick.arts.read(roomId, big.added[0].id)).toMatchObject({ view: "binary", size: 5000 });
  });
});

describe("leaving a room", () => {
  it("deletes its files and agents' copies here; what the leaver added stays with the others", async () => {
    const { roomId, sides: [ryan, nick], dir } = await sides(["Ryan", "Nick"]);
    const theirs = await nick.arts.addFiles(roomId, [randomFile(path.join(dir, "src"), "nick.png", 300)]);
    const mine = await ryan.arts.addFiles(roomId, [randomFile(path.join(dir, "src"), "ryan.png", 300)]);
    await until(() => !!blobOf(nick, roomId, mine.added[0].id) && !!blobOf(ryan, roomId, theirs.added[0].id), "both to have both");
    const agentDir = path.join(dir, "nick-wt", ".mockingbird", "artifacts", mine.added[0].id);
    await nick.arts.copyForAgent(roomId, fileRec(nick, roomId, mine.added[0].id), agentDir, "ryan.png");
    await nick.m.team.leave(roomId, { ackMs: 500, revokeMs: 500 });
    expect(await nick.arts.roomLeft(roomId)).toEqual([]);
    nick.m.team.forget(roomId);
    expect(fs.existsSync(agentDir)).toBe(false);
    expect(fs.existsSync(path.join(nick.m.store.dir, roomId))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "Nick", "artifact-copies.json"), "utf8"))).toEqual([]);
    await until(() => ryan.m.team.room(roomId)!.members.length === 1, "Ryan to see Nick leave");
    expect(await summaryOf(ryan, roomId, theirs.added[0].id)).toMatchObject({ name: "nick.png", addedByName: "Nick", local: { state: "present" } });
  });
});

describe("Quick Look, Reveal and Save as", () => {
  it("act on copies main makes: read-only and quarantined for viewing, marked as downloaded when saved", async () => {
    const { roomId, sides: [ryan], dir } = await sides(["Ryan"]);
    const shown: string[][] = [];
    let saveTo: string | null = path.join(dir, "out", "saved.pdf");
    fs.mkdirSync(path.dirname(saveTo), { recursive: true });
    const ui = artifactViewer(ryan.arts, {
      previewFile: (p, name) => shown.push(["preview", p, name]),
      showItemInFolder: (p) => shown.push(["reveal", p]),
      saveDialog: async (name) => (shown.push(["save", name]), saveTo),
      openFilesDialog: async () => null,
    });
    const pdf = await ryan.arts.addBytes(roomId, "Q3 report", new Uint8Array(Buffer.from("%PDF-1.7\nhello")));
    const id = pdf.added[0].id;
    expect(await ryan.arts.read(roomId, id)).toEqual({ view: "pdf", mime: "application/pdf", size: 14 });
    await ui.quickLook(roomId, id);
    await ui.reveal(roomId, id);
    const copy = path.join(ryan.m.store.dir, roomId, "artifacts", "view", id, "Q3 report.pdf");
    expect(shown).toEqual([
      ["preview", copy, "Q3 report"],
      ["reveal", copy],
    ]);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o444);
    expect(await ui.saveAs(roomId, id)).toEqual({ path: saveTo });
    expect(shown.at(-1)).toEqual(["save", "Q3 report"]);
    expect(fs.readFileSync(saveTo, "utf8")).toBe("%PDF-1.7\nhello");
    if (process.platform === "darwin") {
      for (const f of [copy, saveTo]) expect(execFileSync("xattr", ["-p", "com.apple.quarantine", f], { encoding: "utf8" })).toMatch(/;Mockingbird;/);
    }
    saveTo = null;
    expect(await ui.saveAs(roomId, id)).toBeNull();
    const note = ryan.arts.addNote(roomId, "Spec", "text");
    await expect(ui.quickLook(roomId, note.id)).rejects.toThrow(/Only files/);
    saveTo = path.join(dir, "out", "spec.md");
    await ui.saveAs(roomId, note.id);
    expect(fs.readFileSync(saveTo, "utf8")).toBe("text");
  });
});

describe("adding to the room", () => {
  it("asks before adding what looks like a secret, and keeps it from agents", async () => {
    const { roomId, sides: [ryan], dir } = await sides(["Ryan"]);
    const env = path.join(dir, "src", ".env");
    fs.mkdirSync(path.dirname(env), { recursive: true });
    fs.writeFileSync(env, "TOKEN=x\n");
    const first = await ryan.arts.addFiles(roomId, [env]);
    expect(first).toEqual({ added: [], refused: [{ name: ".env", reason: expect.stringMatching(/named like a secret file/), needsConfirm: "secret" }] });
    expect(items(ryan.m.team.room(roomId))).toEqual([]);
    expect(fs.readdirSync(path.join(ryan.m.store.dir, roomId, "artifacts", "tmp"))).toEqual([]);
    const pem = new Uint8Array(Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n"));
    expect((await ryan.arts.addBytes(roomId, "notes.txt", pem)).refused[0]).toMatchObject({ needsConfirm: "secret", reason: expect.stringMatching(/private key/) });
    const again = await ryan.arts.addFiles(roomId, [env], true);
    const keyAgain = await ryan.arts.addBytes(roomId, "notes.txt", pem, true);
    expect((await summaryOf(ryan, roomId, again.added[0].id)).agentsBlocked).toMatch(/secret file/);
    expect((await summaryOf(ryan, roomId, keyAgain.added[0].id)).agentsBlocked).toMatch(/private key/);
    // a folder and a missing file are refused, each named
    const r = await ryan.arts.addFiles(roomId, [path.join(dir, "src"), path.join(dir, "nope.txt")]);
    expect(r.refused.map((x) => [x.name, x.reason])).toEqual([
      ["src", expect.stringMatching(/folder/)],
      ["nope.txt", expect.stringMatching(/isn't there/)],
    ]);
  });

  it("adds notes and https links, and refuses other links and control characters", async () => {
    const { roomId, sides: [ryan] } = await sides(["Ryan"]);
    const n = ryan.arts.addNote(roomId, "  Spec ", "line 1\r\nline 2");
    expect(await ryan.arts.read(roomId, n.id)).toMatchObject({ view: "note", text: "line 1\nline 2" });
    expect(n.name).toBe("Spec");
    const l = ryan.arts.addLink(roomId, "https://dev.azure.com/acme/web/_workitems/edit/5110", "");
    expect(await summaryOf(ryan, roomId, l.id)).toMatchObject({ name: "ADO #5110", host: "dev.azure.com", label: "ADO #5110" });
    expect(() => ryan.arts.addLink(roomId, "javascript:alert(1)", "x")).toThrow(/https/);
    expect(() => ryan.arts.addLink(roomId, "https://u:p@example.com", "x")).toThrow(/user name/);
    expect(() => ryan.arts.addNote(roomId, "Bad", "\u001b[2J")).toThrow(/control characters/);
    ryan.arts.rename(roomId, n.id, "Spec v2");
    expect(items(ryan.m.team.room(roomId))[0].name).toBe("Spec v2");
    // the shelf lists newest first
    expect((await ryan.arts.list(roomId)).items.map((i) => i.id)).toEqual([l.id, n.id]);
  });
});

describe("notes edited together", () => {
  it("say when the note changed under an edit, and save over it or beside it as asked", async () => {
    const { roomId, sides: [ryan, nick] } = await sides(["Ryan", "Nick"]);
    const n = ryan.arts.addNote(roomId, "Spec", "v1");
    await until(() => items(nick.m.team.room(roomId)).length === 1, "Nick to have it");
    const r1 = nick.arts.saveNote(roomId, n.id, "Nick's v2", n.id, "save") as { rev: string };
    expect(r1).toEqual({ rev: expect.any(String) });
    await until(() => (items(ryan.m.team.room(roomId))[0] as any).text === "Nick's v2", "Ryan to see it");
    // Ryan was editing from v1
    expect(ryan.arts.saveNote(roomId, n.id, "Ryan's v2", n.id, "save")).toEqual({ stale: { rev: r1.rev, byName: "Nick", at: expect.any(Number) } });
    const copy = ryan.arts.saveNote(roomId, n.id, "Ryan's v2", n.id, "copy") as { copy: string };
    expect(items(ryan.m.team.room(roomId)).find((a) => a.id === copy.copy)).toMatchObject({ name: "Spec (copy)", text: "Ryan's v2" });
    expect(ryan.arts.saveNote(roomId, n.id, "Ryan's v3", n.id, "overwrite")).toEqual({ rev: expect.any(String) });
    expect((items(ryan.m.team.room(roomId))[0] as any).text).toBe("Ryan's v3");
  });

  it("tell the member whose edit crossed another's, after a partition, that theirs became a copy", async () => {
    const { roomId, net, sides: [ryan, nick] } = await sides(["Ryan", "Nick"]);
    const n = ryan.arts.addNote(roomId, "Spec", "v1");
    await until(() => items(nick.m.team.room(roomId)).length === 1, "Nick to have it");
    net.partition(ryan.m.id, nick.m.id);
    await until(() => ryan.m.team.presence(roomId).length === 0, "the partition");
    ryan.arts.saveNote(roomId, n.id, "Ryan's", n.id, "save");
    nick.arts.saveNote(roomId, n.id, "Nick's", n.id, "save");
    net.partition(ryan.m.id, nick.m.id, false);
    await until(() => items(ryan.m.team.room(roomId)).length === 2 && items(nick.m.team.room(roomId)).length === 2, "the merge");
    const copy = items(ryan.m.team.room(roomId))[1];
    const [loser, winner] = copy.addedBy === ryan.m.id ? [ryan, nick] : [nick, ryan];
    const notices = (await loser.arts.list(roomId)).notices;
    expect(notices).toEqual([{ id: `crossed-${copy.id}`, at: expect.any(Number), artifact: copy.id, text: `Your edit of 'Spec' crossed ${winner.m.name}'s; yours is kept as 'Spec (${loser.m.name}'s edit)'` }]);
    expect((await winner.arts.list(roomId)).notices).toEqual([]);
    loser.arts.dismissNotice(roomId, notices[0].id);
    expect((await loser.arts.list(roomId)).notices).toEqual([]);
  });
});
