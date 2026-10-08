import React, { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { SetRow } from "./SetRow";
import { CopyToast, useCopyNote } from "./copyNote";
import { isErr, type Settings } from "../shared/types";
import { allowCreatorsCommand } from "../shared/team/protocol";
import type { PeerStatus, TeamRoomSummary, TeamStatus } from "../shared/team/types";

/**
 * Team rooms in the window (stage 1): Settings → Team, sharing a group as a
 * room, joining one by code, and the sidebar's shared badge. See
 * docs/team-rooms.md.
 */

/** The team status from main, kept current; an { error } when it couldn't be read. */
export function useTeamStatus(): TeamStatus | { error: string } | null {
  const [status, setStatus] = useState<TeamStatus | { error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    window.mb.teamStatus().then((s: TeamStatus | { error: string }) => {
      if (!alive) return;
      if (isErr(s)) console.error("[mockingbird] couldn't read the team status:", s.error);
      setStatus(s);
    });
    const off = window.mb.onTeamChanged((s: TeamStatus) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}

/** "Nick Smith" → "NS", "nick" → "N". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0][0] : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const LINK_LABEL: Record<PeerStatus["state"], string> = {
  direct: "connected · direct",
  turn: "connected · via TURN relay",
  connecting: "connecting…",
  offline: "offline",
  "needs-update": "needs an update",
  error: "refused",
};

/** The room a sidebar group is shown as, if it's shared. */
export function roomOfGroup(status: TeamStatus | { error: string } | null, groupKey: string): TeamRoomSummary | undefined {
  return status && !isErr(status) ? status.rooms.find((r) => r.groupKey === groupKey) : undefined;
}

/** A shared group's badge in the sidebar: "shared", and the initials of teammates connected right now. */
export function SharedBadge({ room }: { room: TeamRoomSummary }) {
  const online = room.members.filter((m) => room.online.includes(m.id));
  const tip = `Shared room${online.length ? ` · connected: ${online.map((m) => m.name).join(", ")}` : " · no teammate connected"}${room.problem ? ` · ${room.problem}` : ""}`;
  return (
    <span className="team-badge" title={tip}>
      <span className={`team-shared ${room.problem ? "bad" : ""}`}>shared</span>
      {online.map((m) => (
        <span key={m.id} className="team-initials">
          {initialsOf(m.name)}
        </span>
      ))}
    </span>
  );
}

/** Teammates connected to any room right now, once each. */
export function teammatesOnline(status: TeamStatus | { error: string } | null): { id: string; name: string }[] {
  if (!status || isErr(status)) return [];
  const out = new Map<string, string>();
  for (const r of status.rooms) for (const m of r.members) if (!m.self && r.online.includes(m.id)) out.set(m.id, m.name);
  return [...out].map(([id, name]) => ({ id, name }));
}

/** The Sessions outline's divider above the groups shared as team rooms, with how many teammates are connected. */
export function ConnectedDivider({ status }: { status: TeamStatus | { error: string } | null }) {
  const online = teammatesOnline(status);
  return (
    <div className="connected-label" title="Groups shared as team rooms — their sessions show on every member's Mockingbird">
      <span>Connected Sessions</span>
      {online.length > 0 && (
        <span className="cl-online" title={`Connected now: ${online.map((m) => m.name).join(", ")}`}>
          {online.length} online
        </span>
      )}
    </div>
  );
}

/**
 * The one step that lets this Mockingbird create rooms: the signaling Worker
 * refuses new rooms from keys not on its ALLOWED_CREATORS secret (anyone who
 * learned its URL could otherwise use its TURN relay).
 */
export function AllowCreatorStep({ id }: { id: string }) {
  const [note, copy] = useCopyNote();
  const command = allowCreatorsCommand([id]);
  return (
    <div className="team-allow">
      <div className="set-row-title">Let this Mockingbird create rooms</div>
      <div className="set-row-note">
        The Worker only lets listed fingerprints create rooms (joining with a code needs nothing). Run once in this repo; for several creators, list their
        fingerprints comma-separated in one command — the secret is replaced each time.
      </div>
      <div className="team-cmd">
        <code>{command}</code>
        <button className="outline" onClick={() => copy(command, "the command")}>
          Copy
        </button>
        <CopyToast note={note} failed="Couldn't copy" />
      </div>
    </div>
  );
}

/** Share a group as a room: shows a one-time invite code to send a teammate. */
export function ShareRoomDialog({ groupKey, title, onClose }: { groupKey: string; title: string; onClose: () => void }) {
  const status = useTeamStatus();
  const [code, setCode] = useState<{ roomId: string; invite: string; warning?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [note, copy] = useCopyNote();
  useEffect(() => {
    setError(null);
    window.mb.teamShareGroup(groupKey, title).then((r: { roomId: string; invite: string; warning?: string } | { error: string }) => (isErr(r) ? setError(r.error) : setCode(r)));
  }, [groupKey, title, attempt]);
  // the Worker refused to create the room: the fix is one command on it
  const self = status && !isErr(status) ? status.self : null;
  const notAllowed = !!error && /ALLOWED_CREATORS/.test(error);
  const fresh = async () => {
    if (!code) return;
    const r: { invite: string } | { error: string } = await window.mb.teamCreateInvite(code.roomId);
    if (isErr(r)) setError(r.error);
    else setCode({ ...code, invite: r.invite });
  };
  return (
    <Modal className="modal team-dlg" onClose={onClose}>
      <h3>Share {title} as a team room</h3>
      <div className="sub-h">
        Teammates who join see this group as a shared room. Sessions outside rooms are never visible to anyone.
      </div>
      {error && !notAllowed && <div className="err">{error}</div>}
      {notAllowed && (
        <>
          <div className="err">The signaling Worker refused to create this room: it only lets fingerprints on its ALLOWED_CREATORS list create rooms.</div>
          {self && <AllowCreatorStep id={self.id} />}
        </>
      )}
      {!code && !error && <div className="hint">Creating the room and checking with the signaling server…</div>}
      {code && (
        <>
          <label>Invite code</label>
          <textarea className="team-code" readOnly value={code.invite} onFocus={(e) => e.currentTarget.select()} />
          {code.warning && <div className="err">{code.warning}</div>}
          <div className="hint">Works once, for 7 days. Your teammate pastes it into Join a room… (in the Team tab, New/Import Session → Connected, or ⌘K). Your Mockingbird must be open for them to join.</div>
        </>
      )}
      <div className="row" style={{ position: "relative" }}>
        {error && (
          <button className="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        )}
        {code && (
          <button className="outline" onClick={fresh}>
            New code
          </button>
        )}
        <button className="outline" onClick={onClose}>
          Close
        </button>
        {code && (
          <button className="primary" onClick={() => copy(code.invite, "the invite code")}>
            Copy code
          </button>
        )}
        <CopyToast note={note} failed="Couldn't copy" />
      </div>
    </Modal>
  );
}

/** Paste a room code: joins once the inviter's Mockingbird accepts and the room has been copied. */
export function JoinRoomDialog({ onClose }: { onClose: () => void }) {
  const status = useTeamStatus();
  const [text, setText] = useState("");
  const [joining, setJoining] = useState<{ roomId: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const st = status && !isErr(status) ? status : null;
  const joined = joining && st?.rooms.find((r) => r.id === joining.roomId);
  const pending = joining && st?.pending.find((p) => p.roomId === joining.roomId);
  const join = async () => {
    setError(null);
    const r: { roomId: string; name: string } | { error: string } = await window.mb.teamJoin(text.trim());
    if (isErr(r)) setError(r.error);
    else setJoining(r);
  };
  return (
    <Modal className="modal team-dlg" onClose={onClose}>
      <h3>Join a team room</h3>
      <div className="sub-h">Paste the code a teammate sent you. It names the room and their signaling server; nothing else needs setting up.</div>
      {!joining && (
        <>
          <label>Room code</label>
          <textarea className="team-code" autoFocus placeholder="MBR1-…" value={text} onChange={(e) => setText(e.target.value)} />
        </>
      )}
      {joining && !joined && (
        <div className="hint">
          {pending?.state === "rejected"
            ? `Couldn't join ${joining.name}: ${pending.reason}`
            : pending?.state === "syncing"
              ? `Accepted — copying ${joining.name}…`
              : `Waiting for the inviter's Mockingbird to accept (it has to be open)…`}
        </div>
      )}
      {joined && <div className="set-note ok">Joined {joined.name}. It's in the sidebar as {joined.groupKey}.</div>}
      {error && <div className="err">{error}</div>}
      <div className="row">
        {joining && pending && !joined && (
          <button
            className="outline"
            onClick={async () => {
              const r = await window.mb.teamCancelJoin(joining.roomId);
              if (isErr(r)) return setError(r.error);
              onClose();
            }}
          >
            Cancel joining
          </button>
        )}
        <button className="outline" onClick={onClose}>
          {joining ? "Close" : "Cancel"}
        </button>
        {!joining && (
          <button className="primary" disabled={!text.trim()} onClick={join}>
            Join
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Settings → Team. */
export function TeamSection({ settings, onChange }: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const status = useTeamStatus();
  const [name, setName] = useState(settings.teamName ?? "");
  const [url, setUrl] = useState(settings.signalingUrl ?? "");
  const [check, setCheck] = useState<{ ok: boolean; msg: string } | null>(null);
  const [dialog, setDialog] = useState<"join" | { groupKey: string; title: string } | null>(null);
  const [note, copy] = useCopyNote();
  const st = status && !isErr(status) ? status : null;

  const saveUrl = () => {
    const v = url.trim().replace(/\/+$/, "");
    if (v !== (settings.signalingUrl ?? "")) onChange({ signalingUrl: v });
  };
  const checkUrl = async () => {
    saveUrl();
    setCheck({ ok: true, msg: "Checking…" });
    const r: { protocol: number; relay: boolean; creators: number | "any"; problem: string | null } | { error: string } = await window.mb.teamCheckSignaling(url.trim());
    if (isErr(r)) setCheck({ ok: false, msg: r.error });
    else if (r.problem) setCheck({ ok: false, msg: r.problem });
    else {
      const creators = r.creators === "any" ? "anyone can create rooms (local test server)" : `${r.creators} room creator${r.creators === 1 ? "" : "s"} allowed`;
      setCheck({ ok: true, msg: `Reachable · protocol ${r.protocol} · ${creators} · ${r.relay ? "TURN relay configured" : "no TURN relay (set its secrets for strict networks)"}` });
    }
  };

  return (
    <>
      <h2>Team</h2>
      <p className="set-lede">
        Share a group as a room and teammates join it with a code. Mockingbirds then talk laptop to laptop (WebRTC, end-to-end encrypted); the signaling Worker
        only introduces them.
      </p>
      {status && isErr(status) && <div className="err">Couldn't read the team status: {status.error}</div>}
      {st?.error && <div className="err">{st.error}</div>}
      <SetRow title="Your name" note="What teammates see next to your sessions and messages">
        <input
          type="text"
          className="team-input"
          placeholder={st?.self?.name ?? "Your name"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() !== (settings.teamName ?? "") && onChange({ teamName: name.trim() })}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </SetRow>
      <SetRow title="Signaling URL" note="Your signaling Worker's address. New rooms use it; teammates don't need it — invite codes carry it.">
        <input type="text" className="team-input wide" placeholder="https://mockingbird-signaling.you.workers.dev" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={saveUrl} />
        <button className="outline" disabled={!url.trim()} onClick={checkUrl}>
          Check
        </button>
      </SetRow>
      {check && <div className={check.ok ? "set-note ok" : "err"}>{check.msg}</div>}
      <p className="set-lede team-deploy">
        No Worker yet? Deploy it once to a free Cloudflare account: <code>cd signaling && npx wrangler login && npx wrangler deploy</code>, allow this
        Mockingbird to create rooms (below), then paste the printed workers.dev URL above. signaling/README.md has the optional TURN relay step (for
        teammates behind strict firewalls).
      </p>
      <SetRow title="This Mockingbird's fingerprint" note="Teammates can compare it with what their Mockingbird shows for you">
        <span style={{ position: "relative" }}>
          <code className="team-fp">{st?.self?.fingerprint ?? "—"}</code>
          {st?.self && (
            <button className="outline" onClick={() => copy(st.self!.fingerprint, "the fingerprint")}>
              Copy
            </button>
          )}
          <CopyToast note={note} failed="Couldn't copy" />
        </span>
      </SetRow>
      {st?.self && <AllowCreatorStep id={st.self.id} />}

      <div className="set-sub">Teammates</div>
      {st && !st.peers.length && <div className="set-note">No teammates yet. Share a group from its row in the sidebar (⇪), or join a room with a code.</div>}
      {st?.peers.map((p) => (
        <SetRow key={p.id} title={p.name} note={`${p.detail ? `${p.detail} · ` : ""}${p.id.replace(/(.{4})(?=.)/g, "$1 ")}`}>
          <span className={`team-link ${p.state}`}>{LINK_LABEL[p.state]}</span>
        </SetRow>
      ))}

      <div className="set-sub">Rooms</div>
      {st?.rooms.map((r) => (
        <SetRow
          key={r.id}
          title={r.name}
          note={`Group ${r.groupKey} · ${r.members.map((m) => (m.self ? `${m.name} (you)` : m.name)).join(", ")} · signaling ${r.signaling}${r.problem ? ` — ${r.problem}` : ""}`}
        >
          <button className="outline" onClick={() => setDialog({ groupKey: r.groupKey, title: r.name })}>
            Invite…
          </button>
        </SetRow>
      ))}
      {st?.pending.map((p) => (
        <SetRow key={p.roomId} title={`${p.name} (joining)`} note={p.state === "rejected" ? `Refused: ${p.reason}` : p.state === "syncing" ? "Accepted — copying the room" : "Waiting for the inviter's Mockingbird to accept"}>
          <button
            className="outline"
            onClick={async () => {
              const r = await window.mb.teamCancelJoin(p.roomId);
              if (isErr(r)) setCheck({ ok: false, msg: `Couldn't cancel: ${r.error}` });
            }}
          >
            {p.state === "rejected" ? "Dismiss" : "Cancel"}
          </button>
        </SetRow>
      ))}
      <div className="set-actions">
        <button className="outline strong" onClick={() => setDialog("join")}>
          Join a room…
        </button>
      </div>
      {st?.problems.map((p) => (
        <div key={p} className="err">
          {p}
        </div>
      ))}
      {dialog === "join" && <JoinRoomDialog onClose={() => setDialog(null)} />}
      {dialog && dialog !== "join" && <ShareRoomDialog groupKey={dialog.groupKey} title={dialog.title} onClose={() => setDialog(null)} />}
    </>
  );
}
