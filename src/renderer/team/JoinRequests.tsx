import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import { userLeft } from "../keyArm";
import { settled } from "../settled";
import { isErr } from "../../shared/types";
import type { JoinAnswerOutcome, JoinRequestSummary, PendingJoinSummary, TeamRoomSummary, TeamStatus } from "../../shared/team/types";

/**
 * Joining a room needs its admin (docs/team-rooms.md → Joining): the admin's
 * prompt (JoinRequestPrompt, mounted in main.tsx, one at a time), the
 * requests listed under each room in Settings → Team so a missed prompt can
 * be answered later (RoomJoinRequests), and what the joiner and an inviter
 * who isn't the admin are told while they wait.
 */

export const OLD_WORKER_APPROVE =
  "Your signaling Worker is older: it lets someone with a code connect to it before you accept them (they get nothing of the room). Update it (cd signaling && npx wrangler deploy) to also hold joiners at the door.";

/** Requests this install answers, as the admin, across rooms, oldest first. */
export function adminRequests(status: TeamStatus | { error: string } | null): { request: JoinRequestSummary; room: TeamRoomSummary }[] {
  if (!status || isErr(status)) return [];
  return status.rooms.flatMap((room) => (room.requests ?? []).filter((r) => r.role === "admin" && r.state === "waiting").map((request) => ({ request, room }))).sort((a, b) => a.request.at - b.request.at);
}

/** Accept or decline, with what went wrong (or what the Worker couldn't do) as text. */
async function answer(r: JoinRequestSummary, accept: boolean): Promise<{ error?: string; outcome?: JoinAnswerOutcome }> {
  const out: JoinAnswerOutcome | { error: string } = await settled(window.mb.teamAnswerJoin(r.roomId, r.id, accept), accept ? `Couldn't accept ${r.name}` : `Couldn't decline ${r.name}`);
  return isErr(out) ? { error: out.error } : { outcome: out };
}

/** "Invited by Sam" / "With your code". */
const invitedLine = (r: JoinRequestSummary, self: string | undefined) => (r.inviter === self ? "with your code" : `invited by ${r.inviterName}`);

/**
 * The admin's prompt: "Nick wants to join #5101", with Nick's fingerprint to
 * check with him out of band, who invited him, Accept / Decline. Later leaves
 * it in Settings → Team.
 */
export function JoinRequestPrompt({
  request: r,
  room,
  self,
  stillAsked,
  onLater,
  onDone,
}: {
  request: JoinRequestSummary;
  room: TeamRoomSummary;
  self?: string;
  /** The request is still waiting (not answered from Settings → Team, not expired). */
  stillAsked: boolean;
  onLater: () => void;
  /**
   * It's gone: `left` when the user left it by a press or Esc (keyArm.ts's `userLeft`, read as they did, before an
   * answer is waited for), not by Enter and not by the request going from under it.
   */
  onDone: (left: boolean) => void;
}) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState("");
  const [declined, setDeclined] = useState<JoinAnswerOutcome | null>(null);
  useEffect(() => {
    if (!stillAsked && !busy && !declined) onDone(false);
  }, [stillAsked, busy, declined, onDone]);
  const go = async (accept: boolean) => {
    const left = userLeft();
    setBusy(accept ? "accept" : "decline");
    setError("");
    const out = await answer(r, accept);
    if (out.error) {
      setBusy(null);
      return setError(out.error);
    }
    // declined, and the Worker couldn't drop them at the door: said before the prompt goes
    if (!accept && out.outcome?.worker) setDeclined(out.outcome);
    setBusy(null);
    if (accept || !out.outcome?.worker) onDone(left);
  };
  if (declined) {
    return (
      <Modal className="modal team-dlg join-ask" onClose={() => onDone(userLeft())}>
        <h3>You declined {declined.name}</h3>
        <ul className="team-effects">
          <li>They're told, and get nothing of {room.name}. The code they used is used up.</li>
          <li className="warn">{declined.worker}</li>
        </ul>
        <div className="row">
          <button className="primary" onClick={() => onDone(userLeft())}>
            Close
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal className="modal team-dlg join-ask" onClose={busy ? undefined : onLater} closeOnBackdrop={false}>
      <h3>
        {r.name} wants to join {room.name}
      </h3>
      <div className="sub-h">
        {r.inviter === self ? "They used your invite code." : `${r.inviterName} invited them.`} You're the room's admin, so it's yours to accept: they'd see its sessions, chat and plan, and could type
        into its sessions.
      </div>
      <div className="join-fp">
        <span className="join-fp-label">{r.name}'s fingerprint</span>
        <code className="team-fp">{r.fingerprint}</code>
      </div>
      <div className="fp-note join-check">
        Before accepting, check it with {r.name} another way (a call, a message): it's what their Settings → Team shows as “This Mockingbird's fingerprint”. A code that leaked would
        show someone else's.
      </div>
      {room.workerApprove === false && <div className="fp-note warn">{OLD_WORKER_APPROVE}</div>}
      {error && <div className="err">{error}</div>}
      <div className="row">
        <button className="outline" disabled={!!busy} onClick={onLater} title="Answer later from Settings → Team">
          Later
        </button>
        <span style={{ flex: 1 }} />
        <button className="outline danger-btn" disabled={!!busy} onClick={() => go(false)}>
          {busy === "decline" ? "Declining…" : "Decline"}
        </button>
        <button className="primary" disabled={!!busy} onClick={() => go(true)}>
          {busy === "accept" ? "Accepting…" : "Accept"}
        </button>
      </div>
    </Modal>
  );
}

/** Settings → Team, under a room: requests waiting for this install (the admin) to answer, and ones it passed on to the admin. */
export function RoomJoinRequests({ room, self }: { room: TeamRoomSummary; self?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; warn: boolean } | null>(null);
  const requests = room.requests ?? [];
  if (!requests.length) return null;
  const go = async (r: JoinRequestSummary, accept: boolean) => {
    setBusy(r.id);
    const out = await answer(r, accept);
    setBusy(null);
    if (out.error) setNote({ id: r.id, text: out.error, warn: true });
    else if (out.outcome?.worker) setNote({ id: r.id, text: out.outcome.worker, warn: true });
  };
  return (
    <div className="join-requests">
      <div className="set-row-title">Asking to join</div>
      {requests.map((r) => (
        <div key={`${r.id}:${r.at}`} className="join-request">
          <div className="join-request-text">
            <span className="team-member-name">
              <b>{r.name}</b> · {invitedLine(r, self)}
            </span>
            <code className="team-fp">{r.fingerprint}</code>
            <span className={`join-request-state ${r.problem ? "warn" : ""}`}>{requestState(r)}</span>
            {note?.id === r.id && <span className={note.warn ? "join-request-state warn" : "join-request-state"}>{note.text}</span>}
          </div>
          {r.role === "admin" && r.state === "waiting" && (
            <span className="join-request-actions">
              <button className="outline danger-btn" disabled={busy === r.id} onClick={() => go(r, false)}>
                Decline
              </button>
              <button className="primary" disabled={busy === r.id} onClick={() => go(r, true)}>
                Accept
              </button>
            </span>
          )}
        </div>
      ))}
      {requests.some((r) => r.role === "admin") && <div className="set-row-note">Check each fingerprint with the person before accepting: it's what their Settings → Team shows.</div>}
    </div>
  );
}

/** A request's state in words, as its admin or its inviter sees it. */
export function requestState(r: JoinRequestSummary): string {
  const until = new Date(r.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (r.role === "admin") return `waiting for you · the code lapses ${until}`;
  switch (r.state) {
    case "accepted":
      return `${r.adminName} accepted them`;
    case "declined":
      return `${r.adminName} declined`;
    case "forwarding":
      return r.problem ?? `Sent to ${r.adminName} for approval once their Mockingbird is online`;
    default:
      return `Sent to ${r.adminName} for approval`;
  }
}

/** What a joiner sees while its join is pending. */
export function pendingJoinText(p: PendingJoinSummary): string {
  switch (p.state) {
    case "approval":
      return `Waiting for ${p.admin ?? "the room's admin"} to accept…`;
    case "syncing":
      return `Accepted — copying ${p.name}…`;
    case "declined":
      return p.reason ?? `${p.admin ?? "The room's admin"} declined`;
    case "rejected":
      return `Couldn't join ${p.name}: ${p.reason}`;
    default:
      return "Waiting for the inviter's Mockingbird (it has to be open)…";
  }
}
