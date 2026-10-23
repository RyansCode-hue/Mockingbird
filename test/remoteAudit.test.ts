import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { loopbackRoom } from "../src/main/team/loopback";
import { PeerError } from "../src/main/team/transport";
import { RemoteAudit } from "../src/main/team/remoteAudit";
import { auditWords, type AuditEntry } from "../src/shared/team/audit";

const lines = (file: string): AuditEntry[] => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("the audit log of remote actions", () => {
  it("records teammates' agent messages, take-over asks, files fetched and backups sent — sizes and outcomes, never content", async () => {
    const dir = tempDir("audit");
    const { members, roomId } = await loopbackRoom(["Ryan", "Nick"], { dir });
    const [ryan, nick] = members;
    const logs: string[] = [];
    const audit = new RemoteAudit({ file: path.join(dir, "audit.log"), log: (c, e) => logs.push(`${c}: ${e}`), timing: { quietMs: 10_000 } });
    audit.watch(ryan.team);
    // Ryan's Mockingbird answering as the real handlers do
    ryan.team.onRequest("agents.send", (p) => (p.to === "s-closed" ? Promise.reject(new PeerError("it was closed")) : { status: "queued", detail: "queued until its current turn ends", toTitle: "Export API" }));
    ryan.team.onRequest("takeover.ask", () => ({ answer: "kept" }));
    ryan.team.onRequest("artifact.chunk", () => ({ size: 9, offset: 0, data: Buffer.from("top-secret").toString("base64") }));
    const from = { id: "n1", title: "CSV writer", agent: "claude", repo: "backoffice", branch: "5101" };
    const body = "please delete the prod database, password hunter2";
    await nick.team.request(ryan.id, "agents.send", { from, to: "s1", text: body }, { roomId });
    await expect(nick.team.request(ryan.id, "agents.send", { from, to: "s-closed", text: "x" }, { roomId })).rejects.toThrow(/it was closed/);
    await nick.team.request(ryan.id, "takeover.ask", { roomId, sessionId: "s1", askId: "a".repeat(24) }, { roomId });
    const sha = "ab".repeat(32);
    for (let i = 0; i < 3; i++) await nick.team.request(ryan.id, "artifact.chunk", { sha256: sha, offset: 0, length: 10 }, { roomId });
    // a backup of Ryan's session going to Nick (the request Ryan sends); Nick's Mockingbird answers it
    nick.team.onRequest("takeover.snapshot", () => ({ sha: "c".repeat(40) }));
    await ryan.team.request(nick.id, "takeover.snapshot", { roomId, sessionId: "s1", sha: "c".repeat(40), originUrl: "https://x", bundle: Buffer.alloc(3000).toString("base64") }, { roomId });
    audit.flush();
    const file = path.join(dir, "audit.log");
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toMatch(/hunter2|prod database|top-secret|dG9w/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const e = lines(file);
    expect(e.filter((x) => x.kind === "message")).toEqual([
      expect.objectContaining({ member: "Nick", memberId: nick.id, room: "5110", session: "s1", title: "Export API", from: "CSV writer", bytes: Buffer.byteLength(body), outcome: "queued" }),
      expect.objectContaining({ member: "Nick", session: "s-closed", bytes: 1, outcome: "refused: it was closed" }),
    ]);
    expect(e.find((x) => x.kind === "takeover.asked")).toMatchObject({ member: "Nick", session: "s1", outcome: "kept" });
    expect(e.find((x) => x.kind === "artifact.served")).toMatchObject({ member: "Nick", n: 3, bytes: 30 });
    expect(e.find((x) => x.kind === "backup.sent")).toMatchObject({ member: "Nick", session: "s1", n: 1, bytes: 3000 });
    // in words, for Settings
    expect(e.map(auditWords)).toEqual([
      `Nick's agent “CSV writer” messaged “Export API” (${Buffer.byteLength(body)} bytes): queued`,
      "Nick's agent “CSV writer” messaged session s-closed (1 byte): refused: it was closed",
      "Nick asked to continue session s1 on their laptop: kept",
      "Nick fetched a room file from this Mac: 30 bytes",
      "A backup of session s1 went to Nick's Mac (2.9 KB): their agents can read its files and diffs",
    ]);
    expect(logs).toEqual([]);
    audit.stop();
  });

  it("gathers a burst into one entry, and starts a new one after a pause", async () => {
    let clock = 1_000_000;
    const dir = tempDir("audit");
    const audit = new RemoteAudit({ file: path.join(dir, "audit.log"), log: () => {}, now: () => clock, timing: { quietMs: 30, spanMs: 60_000 } });
    const who = { member: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", session: "s1", title: "Export API" };
    for (let i = 0; i < 5; i++) {
      audit.count("input", who, 3);
      clock += 1000;
    }
    // gathered ones show in the recent list before they're written
    expect(audit.recent()).toEqual([expect.objectContaining({ kind: "input", n: 5, bytes: 15, since: 1_000_000, at: 1_004_000 })]);
    await new Promise((r) => setTimeout(r, 80));
    audit.count("input", who, 1);
    audit.flush();
    expect(lines(path.join(dir, "audit.log")).map((x) => [x.n, x.bytes])).toEqual([
      [5, 15],
      [1, 1],
    ]);
  });

  it("is append-only and owner-only, rotating to audit.log.1 past its size; recent() reads both", () => {
    const dir = tempDir("audit");
    const file = path.join(dir, "team", "audit.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ at: 1, kind: "takeover", member: "Nick" })}\n`, { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    let clock = 10;
    const audit = new RemoteAudit({ file, log: () => {}, maxBytes: 400, now: () => clock++ });
    audit.record("typing.asked", { session: "s1", title: "Export API" });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600); // tightened on first write
    expect(lines(file).map((x) => x.kind)).toEqual(["takeover", "typing.asked"]); // what was there stays
    for (let i = 0; i < 6; i++) audit.record("typing.allowed", { session: `s${i}`, title: "Export API" }, { until: null });
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(400);
    const recent = audit.recent(5);
    expect(recent.map((x) => x.session)).toEqual(["s5", "s4", "s3", "s2", "s1"]);
    expect(audit.recent(100).length).toBeGreaterThan(5); // reaching into audit.log.1
  });

  it("says once when it can't write, and doesn't throw at the caller", () => {
    const dir = tempDir("audit");
    const logs: string[] = [];
    const file = path.join(dir, "audit.log");
    fs.symlinkSync(path.join(dir, "elsewhere"), file);
    const audit = new RemoteAudit({ file, log: (c, e) => logs.push(`${c}: ${e}`) });
    audit.record("typing.asked", { session: "s1" });
    audit.record("typing.asked", { session: "s2" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/symbolic link/);
    expect(fs.existsSync(path.join(dir, "elsewhere"))).toBe(false);
  });
});
