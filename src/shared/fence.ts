/** Six random bytes as hex: a fence's nonce, from the Web Crypto both main and the window have. */
const nonce = (): string => [...globalThis.crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * `text` between `<tag-nonce>` and `</tag-nonce>` lines, the nonce made now and checked against `text`: nothing written
 * before this call can close the fence and go on as Mockingbird's words.
 */
export function fence(tag: string, text: string, makeNonce: () => string = nonce): string {
  for (let i = 0; i < 8; i++) {
    const n = makeNonce();
    if (!text.includes(`${tag}-${n}`)) return `<${tag}-${n}>\n${text}\n</${tag}-${n}>`;
  }
  throw new Error("couldn't make a fence the text doesn't hold");
}
