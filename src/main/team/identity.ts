import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { MB_DIR } from "../store";
import { isMissing } from "../fileOps";
import { fromBase64Url, joinProofInput, MEMBER_ID_RE, PUBLIC_KEY_RE, roomIdInput, signalingJoinKeyInput, SIGNATURE_RE, toBase64Url } from "../../shared/team/protocol";

/**
 * This install's team identity: an Ed25519 key pair, kept in
 * ~/.mockingbird/team/identity.json (owner-only, never synced), the private
 * key sealed by the macOS Keychain where the app can (loadIdentity). The
 * private key never leaves this module: callers get sign(), not the key, and
 * an Identity prints and serializes as its public half only.
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

/**
 * identity.json. Version 1 holds the private key in plain base64; version 2
 * holds it sealed by a KeySealer (Electron's safeStorage: encrypted with a key
 * the macOS Keychain keeps for this app), so a copy of the file — from a
 * backup, a disk image, another account — isn't enough to act as this member.
 * Both carry the public key, so the fingerprint can be read without the
 * private key (npm run team:fingerprint).
 */
interface IdentityFileV1 {
  version: 1;
  publicKey: string;
  /** PKCS#8 DER, base64. */
  privateKey: string;
  createdAt: number;
}
interface IdentityFileV2 {
  version: 2;
  publicKey: string;
  /** The PKCS#8 DER private key, sealed by `by`, base64. */
  sealed: { by: string; key: string };
  createdAt: number;
  sealedAt: number;
}
type IdentityFile = IdentityFileV1 | IdentityFileV2;

/**
 * Seals the private key at rest. In the app this is Electron's safeStorage
 * (src/main/team/keyStore.ts); tests use a fake, and scripts none (they read
 * only the public key, or create a plain file the app seals on its next start).
 */
export interface KeySealer {
  /** What seals, recorded in the file ("safeStorage"). */
  readonly name: string;
  /** Why sealing can't be used right now (no Keychain), or null when it can. */
  unavailable(): string | null;
  seal(plain: Buffer): Buffer;
  /** Throws when it can't (the Keychain refused, the key changed). */
  open(sealed: Buffer): Buffer;
}

export interface LoadIdentityOptions {
  /** Seal the key with this; without one, a plain (version 1) file is used as it is. */
  sealer?: KeySealer | null;
  /** Said once per load when the key stays in plain text though a sealer was given (Keychain unavailable, or the move failed). */
  warn?: (message: string) => void;
}

/**
 * The install's identity, created on first use. An unreadable identity file
 * throws instead of being replaced: a new key would silently drop this
 * install out of every room it's in.
 *
 * With a sealer, a plain key is moved into the sealed form, keeping the same
 * key (and so the same fingerprint: no room has to be joined again): sealed,
 * opened again and compared before the file is replaced, then read back from
 * disk and compared once more. Until all of that holds, the plain file stays
 * — and if the read-back fails after the replace, the plain file is put back.
 * When sealing isn't available the plain file keeps working, with a warning.
 * A sealed file that can't be opened throws: the key is still there, for a
 * later start with the Keychain back.
 */
export function loadIdentity(dir = TEAM_DIR, opts: LoadIdentityOptions = {}): Identity {
  const file = path.join(dir, "identity.json");
  const sealer = opts.sealer ?? null;
  const why = sealer ? sealer.unavailable() : null;
  const warn = (m: string) => opts.warn?.(m);
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  if (text === null) {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const id = new Identity(privateKey);
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (sealer && !why) {
      try {
        writeKeyFile(file, sealedRecord(sealer, der, id, Date.now()));
        return id;
      } catch (err) {
        warn(`The new team key couldn't be sealed with ${sealer.name} (${(err as Error).message}), so it's kept in ${file}, owner-only.`);
      }
    } else if (sealer) warn(`The team key is kept in ${file}, owner-only: ${why}.`);
    writeKeyFile(file, { version: 1, publicKey: id.publicKey, privateKey: der.toString("base64"), createdAt: Date.now() });
    return id;
  }
  const record = parseRecord(file, text);
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) {
    fs.chmodSync(file, 0o600);
    console.warn(`[mockingbird] ${file} was readable by other users (mode ${mode.toString(8)}); it is now owner-only.`);
  }
  if (record.version === 2) {
    if (!sealer) throw new Error(`${file} holds the team key sealed with ${record.sealed.by}, which only the Mockingbird app can open`);
    if (why) throw new Error(`The team key in ${file} is sealed with ${record.sealed.by}, which isn't available: ${why}. It's kept as it is — start Mockingbird again once the Keychain is available.`);
    let der: Buffer;
    try {
      der = sealer.open(Buffer.from(record.sealed.key, "base64"));
    } catch (err) {
      throw new Error(`The team key in ${file} couldn't be opened with ${record.sealed.by} (${(err as Error).message}). It's kept as it is: allow Mockingbird to use its Keychain item and start it again.`);
    }
    return identityOf(file, der, record.publicKey);
  }
  const der = Buffer.from(record.privateKey, "base64");
  const id = identityOf(file, der, record.publicKey);
  if (!sealer) return id;
  if (why) {
    warn(`The team key stays in ${file}, owner-only: ${why}.`);
    return id;
  }
  moveIntoSealer(file, sealer, der, id, record, warn);
  return id;
}

/** A plain key file's key, sealed in its place: verified before the plain file goes, and the plain one put back if the read-back fails. */
function moveIntoSealer(file: string, sealer: KeySealer, der: Buffer, id: Identity, plain: IdentityFileV1, warn: (m: string) => void): void {
  let sealed: IdentityFileV2;
  try {
    sealed = sealedRecord(sealer, der, id, plain.createdAt);
  } catch (err) {
    warn(`The team key couldn't be sealed with ${sealer.name} (${(err as Error).message}), so it stays in ${file}, owner-only.`);
    return;
  }
  try {
    writeKeyFile(file, sealed);
    const back = parseRecord(file, fs.readFileSync(file, "utf8"));
    if (back.version !== 2) throw new Error("the file read back isn't the sealed one");
    const opened = sealer.open(Buffer.from(back.sealed.key, "base64"));
    if (!opened.equals(der) || identityOf(file, opened, back.publicKey).id !== id.id) throw new Error("the key read back isn't the same key");
    console.log(`[mockingbird] the team key moved from plain text in ${file} into ${sealer.name}; the fingerprint is unchanged (${id.id})`);
  } catch (err) {
    try {
      writeKeyFile(file, plain);
    } catch (restore) {
      // the key is still in memory and this run goes on with it; the next start needs one of the two files
      throw new Error(`Moving the team key into ${sealer.name} failed (${(err as Error).message}) and the plain key couldn't be put back in ${file} (${(restore as Error).message})`);
    }
    warn(`Moving the team key into ${sealer.name} failed (${(err as Error).message}), so it stays in ${file}, owner-only.`);
  }
}

/** The sealed record of a key, checked by opening it again before anything is written. */
function sealedRecord(sealer: KeySealer, der: Buffer, id: Identity, createdAt: number): IdentityFileV2 {
  const box = sealer.seal(der);
  if (!sealer.open(box).equals(der)) throw new Error("the sealed key didn't open to the same key");
  return { version: 2, publicKey: id.publicKey, sealed: { by: sealer.name, key: box.toString("base64") }, createdAt, sealedAt: Date.now() };
}

function parseRecord(file: string, text: string): IdentityFile {
  let record: any;
  try {
    record = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is unreadable (${(err as Error).message}). Move it aside to start a new team identity — this install would then have to join its rooms again.`);
  }
  if (record?.version === 2) {
    if (typeof record.publicKey !== "string" || !PUBLIC_KEY_RE.test(record.publicKey) || typeof record.sealed?.key !== "string" || typeof record.sealed?.by !== "string") {
      throw new Error(`${file} doesn't hold a usable sealed key. Move it aside to start a new team identity.`);
    }
    return record as IdentityFileV2;
  }
  if (typeof record?.privateKey !== "string") throw new Error(`${file} doesn't hold a usable key. Move it aside to start a new team identity.`);
  return record as IdentityFileV1;
}

function identityOf(file: string, der: Buffer, publicKey: string | undefined): Identity {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch (err) {
    throw new Error(`${file} doesn't hold a usable key (${(err as Error).message}). Move it aside to start a new team identity.`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${file} holds a ${key.asymmetricKeyType} key, not Ed25519`);
  const id = new Identity(key);
  if (publicKey && publicKey !== id.publicKey) throw new Error(`${file}'s public key doesn't match its private key`);
  return id;
}

/** identity.json replaced in one step, owner-only from the moment it exists. */
function writeKeyFile(file: string, record: IdentityFile): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * This install's member id and public key, without opening the private key:
 * what npm run team:fingerprint prints. A missing file is created as the app
 * would without the Keychain (plain: the app seals it when it next starts).
 */
export function readPublicIdentity(dir = TEAM_DIR): { id: string; publicKey: string } {
  const file = path.join(dir, "identity.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (!isMissing(err)) throw err;
    return loadIdentity(dir).toJSON();
  }
  const record = parseRecord(file, text);
  if (record.version === 1) return loadIdentity(dir).toJSON();
  return { id: fingerprintOf(record.publicKey), publicKey: record.publicKey };
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
