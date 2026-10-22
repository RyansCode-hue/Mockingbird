import type { KeySealer } from "./identity";

/**
 * The team key's seal in the app: Electron's safeStorage, which encrypts with
 * a key the macOS Keychain keeps for Mockingbird ("Mockingbird Safe Storage",
 * the item Chromium's own storage uses). Only an app with Mockingbird's code
 * signature reads that item without macOS asking; a copy of identity.json is
 * ciphertext. Chosen over a generic-password item written with the `security`
 * CLI: such an item trusts /usr/bin/security, so any process running as the
 * user could read it back without a prompt.
 *
 * Anywhere but macOS safeStorage may fall back to a fixed key, so it isn't
 * used there (the key stays in the owner-only file, with a warning).
 */

/** What safeStorage offers that sealing needs (Electron's `safeStorage`). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(sealed: Buffer): string;
}

export function safeStorageSealer(safe: SafeStorageLike, platform: NodeJS.Platform = process.platform): KeySealer {
  return {
    name: "safeStorage",
    unavailable() {
      if (platform !== "darwin") return "the macOS Keychain isn't available on this system";
      try {
        return safe.isEncryptionAvailable() ? null : "the macOS Keychain isn't available to Mockingbird (safeStorage reports no encryption)";
      } catch (err) {
        return `the macOS Keychain couldn't be reached (${(err as Error).message})`;
      }
    },
    // safeStorage seals strings: the key's DER goes in as base64
    seal: (plain) => safe.encryptString(plain.toString("base64")),
    open: (sealed) => Buffer.from(safe.decryptString(sealed), "base64"),
  };
}
