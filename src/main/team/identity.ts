import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { MB_DIR } from "../store";
import { isMissing, writeFileAtomic } from "../fileOps";
import { fromBase64Url, joinProofInput, MEMBER_ID_RE, PUBLIC_KEY_RE, roomIdInput, signalingJoinKeyInput, SIGNATURE_RE, toBase64Url } from "../../shared/team/protocol";

/**
 * This install's team identity: an Ed25519 key pair, kept in
 * ~/.mockingbird/team/identity.json (owner-only, never synced). The private
 * key never leaves this module: callers get sign(), not the key, and an
 * Identity prints and serializes as its public half only.
 */

export const TEAM_DIR = path.join(MB_DIR, "team");

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class Identity {
  /** Raw public key, base64url. */
  readonly publicKey: string;
  /** Member id: the public key's fingerprint. */
  readonly id: string;
  readonly #key: crypto.KeyObject;

  constructor(privateKey: crypto.KeyObject) {
    this.#key = privateKey;
    const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
    this.publicKey = toBase64Url(spki.subarray(SPKI_ED25519_PREFIX.length));
    this.id = fingerprintOf(this.publicKey);
  }

  /** An Ed25519 signature over the text's UTF-8 bytes, base64url. */
  sign(data: string | Uint8Array): string {
    return toBase64Url(crypto.sign(null, typeof data === "string" ? Buffer.from(data, "utf8") : data, this.#key));
  }

  toJSON() {
    return { id: this.id, publicKey: this.publicKey };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `Identity(${this.id})`;
  }
}

interface IdentityFile {
  version: 1;
  publicKey: string;
  /** PKCS#8 DER, base64. */
  privateKey: string;
  createdAt: number;
}

/**
 * The install's identity, created on first use. An unreadable identity file
 * throws instead of being replaced: a new key would silently drop this
 * install out of every room it's in.
 */
export function loadIdentity(dir = TEAM_DIR): Identity {
  const file = path.join(dir, "identity.json");
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  if (text === null) {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const id = new Identity(privateKey);
    const record: IdentityFile = {
      version: 1,
      publicKey: id.publicKey,
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      createdAt: Date.now(),
    };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify(record, null, 2), 0o600);
    return id;
  }
  let record: IdentityFile;
  try {
    record = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is unreadable (${(err as Error).message}). Move it aside to start a new team identity — this install would then have to join its rooms again.`);
  }
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) {
    fs.chmodSync(file, 0o600);
    console.warn(`[mockingbird] ${file} was readable by other users (mode ${mode.toString(8)}); it is now owner-only.`);
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: Buffer.from(record.privateKey, "base64"), format: "der", type: "pkcs8" });
  } catch (err) {
    throw new Error(`${file} doesn't hold a usable key (${(err as Error).message}). Move it aside to start a new team identity.`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${file} holds a ${key.asymmetricKeyType} key, not Ed25519`);
  const id = new Identity(key);
  if (record.publicKey && record.publicKey !== id.publicKey) throw new Error(`${file}'s public key doesn't match its private key`);
  return id;
}

const sha256 = (text: string): Buffer => crypto.createHash("sha256").update(text, "utf8").digest();

/** A public key's member id: the first 128 bits of SHA-256 over the raw key, hex. */
export function fingerprintOf(publicKey: string): string {
  if (!PUBLIC_KEY_RE.test(publicKey)) throw new Error("not an Ed25519 public key");
  return crypto.createHash("sha256").update(fromBase64Url(publicKey)).digest("hex").slice(0, 32);
}

/** Whether `sig` is publicKey's signature over the text. Malformed input is false, never a throw. */
export function verifySignature(publicKey: string, data: string | Uint8Array, sig: string): boolean {
  if (!PUBLIC_KEY_RE.test(publicKey) || !SIGNATURE_RE.test(sig)) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, fromBase64Url(publicKey)]), format: "der", type: "spki" });
    return crypto.verify(null, typeof data === "string" ? Buffer.from(data, "utf8") : data, key, fromBase64Url(sig));
  } catch {
    return false; // an undecodable key or signature is simply not a valid signature
  }
}

export const isMemberId = (s: unknown): s is string => typeof s === "string" && MEMBER_ID_RE.test(s);

/** 32 random bytes, base64url: join tokens, room salts. */
export const randomToken = (): string => toBase64Url(crypto.randomBytes(32));
export const randomNonce = (): string => toBase64Url(crypto.randomBytes(16));

/** The room id a creator's key and salt make. */
export const roomIdFor = (creatorPublicKey: string, salt: string): string => toBase64Url(sha256(roomIdInput(creatorPublicKey, salt))).slice(0, 22);

/** What the signaling server checks for a join, derived from the invite token (the server never sees the token). */
export const signalingJoinKey = (token: string): string => toBase64Url(sha256(signalingJoinKeyInput(token)));
/** The hash of the signaling join key the inviter registers with the server. */
export const signalingTokenHash = (token: string): string => toBase64Url(crypto.createHash("sha256").update(signalingJoinKey(token), "utf8").digest());

/** The joiner's proof, for the inviter, that it holds the invite token. */
export function joinProof(token: string, roomId: string, joinerPublicKey: string): string {
  return toBase64Url(crypto.createHmac("sha256", Buffer.from(fromBase64Url(token))).update(joinProofInput(roomId, joinerPublicKey), "utf8").digest());
}

/** Constant-time comparison of two base64url strings. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
