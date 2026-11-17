/**
 * A message's text as it may be pasted into an agent's prompt: lines and tabs
 * kept, every other control character gone — ESC above all, so nothing in it
 * can end the bracketed paste (ESC [ 201 ~) and go on as keys typed into the
 * pane, and no carriage return can press Enter inside it. C1 controls go
 * too (0x9b is a one-byte CSI to a terminal that reads 8-bit controls).
 * What an Assistant card warns of a payload is read on this, the text typed.
 */
export function pasteText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
