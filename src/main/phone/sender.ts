import { execFile } from "child_process";

/**
 * How an alert reaches the phone. MessagesSender is the real one; tests and
 * development builds use others, so nothing but the installed app ever
 * sends an iMessage.
 */
export interface AlertSender {
  /** Resolves once Messages took it; rejects with SendError saying why not. */
  send(handle: string, text: string): Promise<void>;
}

export type SendProblem = "automation-denied" | "not-signed-in" | "timeout" | "failed";

export class SendError extends Error {
  constructor(
    readonly problem: SendProblem,
    message: string
  ) {
    super(message);
  }
}

/**
 * The AppleScript that sends. The handle and the text arrive as arguments
 * (`on run argv`), never spliced into the script, so nothing in either can
 * become AppleScript.
 */
export const SEND_SCRIPT = [
  "on run argv",
  "set theHandle to item 1 of argv",
  "set theText to item 2 of argv",
  'tell application "Messages"',
  "set theService to 1st account whose service type = iMessage",
  "set theBuddy to participant theHandle of theService",
  "send theText to theBuddy",
  "end tell",
  "end run",
];

/** osascript's failure in plain words, and what kind it is. */
export function sendProblem(stderr: string, killed = false): SendError {
  const e = stderr.trim();
  if (killed) return new SendError("timeout", "Messages didn't answer within 20 seconds");
  if (/-1743\b|not authori[sz]ed to send apple events|not allowed to send keystrokes/i.test(e)) {
    return new SendError("automation-denied", "Mockingbird isn't allowed to control Messages. Allow it in System Settings → Privacy & Security → Automation → Mockingbird → Messages.");
  }
  if (/-1728\b|-1719\b|can.t get account|can.t get (?:1st|first) account|service type/i.test(e)) {
    return new SendError("not-signed-in", "Messages isn't signed in to iMessage on this Mac. Open Messages → Settings → iMessage and sign in.");
  }
  return new SendError("failed", `Messages couldn't send it: ${e.replace(/^\d+:\d+: execution error: /, "").slice(0, 300) || "osascript failed without saying why"}`);
}

export type RunFile = (file: string, args: string[], opts: { timeout: number }, cb: (err: (Error & { killed?: boolean; code?: unknown }) | null, stdout: string, stderr: string) => void) => unknown;

/** Sends through the Messages app with osascript. macOS asks once whether Mockingbird may control Messages. */
export class MessagesSender implements AlertSender {
  constructor(private run: RunFile = execFile as unknown as RunFile) {}

  send(handle: string, text: string): Promise<void> {
    const args = [...SEND_SCRIPT.flatMap((line) => ["-e", line]), handle, text];
    return new Promise((resolve, reject) => {
      this.run("/usr/bin/osascript", args, { timeout: 20_000 }, (err, _out, stderr) => {
        if (!err) return resolve();
        reject(sendProblem(String(stderr ?? "") || err.message, !!err.killed));
      });
    });
  }
}

/** A development build's sender: says what it would have sent, and sends nothing. */
export class DryRunSender implements AlertSender {
  constructor(private log: (line: string) => void) {}

  async send(handle: string, text: string): Promise<void> {
    this.log(`phone alerts (development build, not sent) to ${handle.replace(/^(.).*(@.*|.{2})$/, "$1…$2")}: ${JSON.stringify(text)}`);
    throw new SendError("failed", "Not sent: a development build of Mockingbird never sends iMessages. The installed app does.");
  }
}
