import type { Terminal } from "@xterm/xterm";

/** A terminal kept for the life of the window, so leaving and coming back keeps its scrollback. */
export interface CachedTerm {
  term: Terminal;
  /** The saved output has been handed to xterm: live output may be written after it. */
  replayed: boolean;
  /** xterm has parsed the saved output, so what it emits from now on answers live output. */
  ready: boolean;
}

/**
 * Replay a terminal's saved output, then let live output follow it.
 *
 * The main process appends each chunk to its buffer and sends it in the same
 * step, so a chunk that arrives before the buffer does is already inside it
 * (the pump drops it) and every later one isn't (the pump writes it). xterm
 * parses writes in the order they're made, so live output may follow as soon
 * as the replay is queued. Input waits for `ready`: while xterm parses the
 * replay it answers the queries in that history, and those answers must not
 * reach the program.
 */
export function replay(e: CachedTerm, saved: Promise<string>, current: () => boolean, prepare: (s: string) => string = (s) => s): Promise<void> {
  return saved.then(
    (buf) => {
      if (!current()) return; // disposed while in flight
      e.replayed = true;
      const text = buf ? prepare(buf) : "";
      if (text) e.term.write(text, () => (e.ready = true));
      else e.ready = true;
    },
    (err: unknown) => {
      if (!current()) return;
      console.error("[mockingbird] scrollback replay failed", err);
      // live output and input still work; say why the history is missing
      e.term.write(`\x1b[2m[earlier output couldn't be loaded: ${err instanceof Error ? err.message : String(err)}]\x1b[0m\r\n`);
      e.replayed = e.ready = true;
    }
  );
}

// every path a human's input takes into xterm: physical keys, IME composition,
// dictation/autofill (input events), and paste
const INPUT_EVENTS = ["keydown", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend", "paste"];

/**
 * Note when the user last typed into a terminal, so what xterm sends right
 * after counts as theirs (inputGuard.ts). Needs the terminal opened; once.
 */
export function trackUserInput(e: { term: Terminal; lastInput: number; inputWired?: boolean }): void {
  const area = e.term.textarea;
  if (e.inputWired || !area) return;
  e.inputWired = true;
  for (const ev of INPUT_EVENTS) area.addEventListener(ev, () => (e.lastInput = Date.now()), true);
}

/**
 * One subscription for a kind of terminal output, feeding every cached
 * terminal whether or not it's on screen (a hidden one would otherwise miss
 * output and look frozen on return). Returns the function that wires it, once.
 */
export function dataPump<E extends CachedTerm>(
  subscribe: (cb: (id: string, data: string) => void) => void,
  entries: ReadonlyMap<string, E>,
  write: (e: E, data: string) => void
): () => void {
  let wired = false;
  return () => {
    if (wired) return;
    wired = true;
    subscribe((id, data) => {
      const e = entries.get(id);
      if (e?.replayed) write(e, data);
    });
  };
}
