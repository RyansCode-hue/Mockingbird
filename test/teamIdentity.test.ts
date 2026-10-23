import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { fingerprintOf, joinProof, loadIdentity, roomIdFor, sameSecret, signalingJoinKey, signalingTokenHash, verifySignature, randomToken, TEAM_DIR } from "../src/main/team/identity";
import { canonicalJson, decodeInvite, encodeInvite, envelopeProblem, formatFingerprint, fromBase64Url, InviteError, ReplayGuard, sdpFingerprint, signalingSocketUrl, signalPayload, toBase64Url, TEAM_PROTOCOL, type SignedEnvelope, type UnsignedEnvelope } from "../src/shared/team/protocol";

describe("team identity", () => {
  it("is created once, owner-only, under ~/.mockingbird/team, and read back the same", () => {
    expect(TEAM_DIR.startsWith(path.join(process.env.HOME!, ".mockingbird"))).toBe(true);
    const dir = path.join(tempDir("id"), "team");
    const a = loadIdentity(dir);
    const file = path.join(dir, "identity.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const b = loadIdentity(dir);
    expect(b.id).toBe(a.id);
    expect(b.publicKey).toBe(a.publicKey);
    expect(a.id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.id).toBe(fingerprintOf(a.publicKey));
    expect(formatFingerprint(a.id)).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  });

  it("never shows its private key when printed or serialized", () => {
    const dir = path.join(tempDir("id"), "team");
    const id = loadIdentity(dir);
    const { privateKey } = JSON.parse(fs.readFileSync(path.join(dir, "identity.json"), "utf8"));
    expect(privateKey.length).toBeGreaterThan(40);
    expect(JSON.stringify(id)).toBe(JSON.stringify({ id: id.id, publicKey: id.publicKey }));
    expect(util.inspect(id, { showHidden: true, depth: 5 })).not.toContain(privateKey);
    expect(util.inspect(id)).toBe(`Identity(${id.id})`);
    expect(Object.keys(id)).not.toContain("privateKey");
  });

  it("npm run team:fingerprint prints the same fingerprint the app uses, creating the identity the same way", () => {
    // runs under this test file's throwaway HOME (inherited), never the real one
    const run = () => execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/team-fingerprint.mjs")], { encoding: "utf8", env: { ...process.env } });
    const file = path.join(TEAM_DIR, "identity.json");
    fs.rmSync(file, { force: true });
    const first = run();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const id = loadIdentity(TEAM_DIR);
    expect(first).toContain(`This Mockingbird's team fingerprint: ${formatFingerprint(id.id)}`);
    expect(first).toContain("(new:");
    expect(first).toContain(`cd signaling && echo "${formatFingerprint(id.id)}" | npx wrangler secret put ALLOWED_CREATORS`);
    expect(first).not.toContain(JSON.parse(fs.readFileSync(file, "utf8")).privateKey);
    // run again: the same identity, not a new one
    const second = run();
    expect(second).toContain(formatFingerprint(id.id));
    expect(second).toContain("(from ");
  }, 30_000);

  it("tightens a key file other users could read", () => {
    const dir = path.join(tempDir("id"), "team");
    loadIdentity(dir);
    fs.chmodSync(path.join(dir, "identity.json"), 0o644);
    loadIdentity(dir);
    expect(fs.statSync(path.join(dir, "identity.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses an unreadable key file instead of quietly making a new identity", () => {
    const dir = path.join(tempDir("id"), "team");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "identity.json"), "{ not json");
    expect(() => loadIdentity(dir)).toThrow(/unreadable.*Move it aside/);
    expect(fs.readFileSync(path.join(dir, "identity.json"), "utf8")).toBe("{ not json");
  });

  it("signs, and verification fails for a tampered message, another key, or garbage", () => {
    const a = loadIdentity(path.join(tempDir("a"), "team"));
    const b = loadIdentity(path.join(tempDir("b"), "team"));
    const sig = a.sign("hello room");
    expect(verifySignature(a.publicKey, "hello room", sig)).toBe(true);
    expect(verifySignature(a.publicKey, "hello room!", sig)).toBe(false);
    expect(verifySignature(b.publicKey, "hello room", sig)).toBe(false);
    expect(verifySignature("short", "hello room", sig)).toBe(false);
    expect(verifySignature(a.publicKey, "hello room", "A".repeat(86))).toBe(false);
  });
});

describe("signed signaling envelopes", () => {
  const a = () => loadIdentity(path.join(tempDir("a"), "team"));
  const envelope = (from: ReturnType<typeof a>, to: string, body: unknown, ts = Date.now()): SignedEnvelope => {
    const u: UnsignedEnvelope = { v: TEAM_PROTOCOL, roomId: "r".repeat(22), from: from.id, to, type: "offer", body, ts, nonce: toBase64Url(new Uint8Array(16).map((_, i) => i)) };
    return { ...u, sig: from.sign(signalPayload(u)) };
  };

  it("verify against the sender's key; any change to what's signed breaks it", () => {
    const ryan = a();
    const nick = a();
    const env = envelope(ryan, nick.id, { epoch: "e1", sdp: "v=0\r\na=fingerprint:sha-256 AB:CD\r\n" });
    expect(envelopeProblem(env)).toBeNull();
    expect(verifySignature(ryan.publicKey, signalPayload(env), env.sig)).toBe(true);
    // a body that went through JSON in another key order still verifies
    const reordered = { ...env, body: JSON.parse(JSON.stringify({ sdp: (env.body as any).sdp, epoch: "e1" })) };
    expect(verifySignature(ryan.publicKey, signalPayload(reordered), env.sig)).toBe(true);
    for (const tampered of [
      { ...env, body: { epoch: "e1", sdp: "v=0\r\na=fingerprint:sha-256 EF:01\r\n" } },
      { ...env, to: ryan.id },
      { ...env, ts: env.ts + 1 },
      { ...env, type: "answer" as const },
      { ...env, roomId: "s".repeat(22) },
    ]) {
      expect(verifySignature(ryan.publicKey, signalPayload(tampered), env.sig)).toBe(false);
    }
    expect(verifySignature(nick.publicKey, signalPayload(env), env.sig)).toBe(false);
  });

  it("a replay guard refuses a repeated nonce and anything outside the window", () => {
    const g = new ReplayGuard(120_000);
    const now = 1_000_000_000;
    expect(g.check("a", now, "n1", now)).toBe("ok");
    expect(g.check("a", now, "n1", now + 1000)).toBe("replayed");
    expect(g.check("b", now, "n1", now + 1000)).toBe("ok"); // nonces are per sender
    expect(g.check("a", now - 121_000, "n2", now)).toBe("stale");
    expect(g.check("a", now + 121_000, "n3", now)).toBe("stale");
    // a nonce is forgotten only once it's too old to be accepted anyway
    expect(g.check("a", now + 200_000, "n1", now + 200_000)).toBe("ok");
  });

  it("canonical JSON sorts keys at every level and refuses what JSON can't carry", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(() => canonicalJson({ x: NaN })).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });

  it("base64url round-trips bytes", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
    expect(toBase64Url(bytes)).not.toMatch(/[+/=]/);
  });

  it("finds the one SHA-256 DTLS fingerprint a description pins", () => {
    expect(sdpFingerprint("v=0\r\na=fingerprint:sha-256 AB:CD:EF\r\na=setup:actpass\r\n")).toBe("abcdef");
    expect(sdpFingerprint("a=fingerprint:sha-256 AB:CD\r\na=fingerprint:sha-256 ab:cd\r\n")).toBe("abcd"); // the same one per media section
    expect(() => sdpFingerprint("v=0\r\n")).toThrow(/no DTLS fingerprint/);
    expect(() => sdpFingerprint("a=fingerprint:sha-256 AB\r\na=fingerprint:sha-256 CD\r\n")).toThrow(/more than one/);
    expect(() => sdpFingerprint("a=fingerprint:sha-1 AB:CD\r\n")).toThrow(/unsupported/);
  });

  it("turns the Settings URL into the room's WebSocket URL", () => {
    expect(signalingSocketUrl("https://mb-signal.ryan.workers.dev", "r".repeat(22))).toBe(`wss://mb-signal.ryan.workers.dev/rooms/${"r".repeat(22)}`);
    expect(signalingSocketUrl("http://127.0.0.1:8787/", "r".repeat(22))).toBe(`ws://127.0.0.1:8787/rooms/${"r".repeat(22)}`);
    expect(() => signalingSocketUrl("ftp://x", "r".repeat(22))).toThrow(/https/);
  });
});

describe("invite codes", () => {
  const invite = { roomId: "AbCdEfGhIjKlMnOpQrStUv", url: "https://mb-signal.ryan.workers.dev", token: randomToken(), inviter: "0123456789abcdef0123456789abcdef", name: "#5110 Donor entities" };

  it("round-trip, even wrapped over lines", () => {
    const code = encodeInvite(invite);
    expect(code).toMatch(/^MBR1-[A-Za-z0-9_-]+$/);
    expect(decodeInvite(code)).toEqual(invite);
    expect(decodeInvite(`  ${code.slice(0, 30)}\n${code.slice(30)}  `)).toEqual(invite);
  });

  it("say what's wrong with a bad code", () => {
    expect(() => decodeInvite("hello")).toThrow(InviteError);
    expect(() => decodeInvite("hello")).toThrow(/isn't a Mockingbird room code/);
    expect(() => decodeInvite(encodeInvite(invite).replace("MBR1-", "MBR2-"))).toThrow(/newer Mockingbird/);
    expect(() => decodeInvite(`MBR1-${toBase64Url(new TextEncoder().encode(JSON.stringify({ r: "x" })))}`)).toThrow(/damaged/);
    expect(() => decodeInvite("MBR1-%%%")).toThrow(/isn't a Mockingbird room code/);
  });

  it("derive the signaling join key, its hash and the inviter's proof from the token alone", () => {
    const t = randomToken();
    expect(signalingJoinKey(t)).not.toContain(t);
    expect(signalingTokenHash(t)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signalingTokenHash(t)).not.toBe(signalingJoinKey(t));
    const pk = loadIdentity(path.join(tempDir("j"), "team")).publicKey;
    expect(sameSecret(joinProof(t, invite.roomId, pk), joinProof(t, invite.roomId, pk))).toBe(true);
    expect(sameSecret(joinProof(t, invite.roomId, pk), joinProof(randomToken(), invite.roomId, pk))).toBe(false);
    expect(roomIdFor(pk, t)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(roomIdFor(pk, t)).toBe(roomIdFor(pk, t));
  });
});
