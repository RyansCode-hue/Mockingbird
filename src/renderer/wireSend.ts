import { isErr, type IpcResult } from "../shared/types";
import type { SendReply } from "../shared/wires";

/** What a person's Send along a wire goes through (the send popover gives the real calls). */
export interface WireSendSteps {
  /** Main's wires:send or wires:sendAgain, `start` saying a stopped other end may be started. */
  send: (start: boolean) => Promise<IpcResult<SendReply>>;
  /** Whether starting the other end is worth its cost (useCostGate's resume, which may ask). */
  costOk: () => Promise<boolean>;
}

/**
 * Send along a wire as a person does. Main is asked first without starting anything; when it answers that the other
 * end is stopped, the cost of starting it is asked about, and only once that's agreed is it sent again, starting it.
 * Main's last answer, or undefined when the cost was declined (nothing was sent or counted).
 */
export async function sendAlongWire(d: WireSendSteps): Promise<IpcResult<SendReply> | undefined> {
  const first = await d.send(false);
  if (isErr(first) || !("refused" in first) || !first.start) return first;
  if (!(await d.costOk())) return undefined;
  return d.send(true);
}
