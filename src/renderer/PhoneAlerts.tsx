import { useEffect, useState } from "react";
import { alertText, HANDLE_HINT, IDLE_MINUTES_CHOICES, normalizeHandle, phoneSettings, type AlertItem, type PhoneAlertSettings, type PhoneStatus } from "../shared/phoneAlerts";
import { isErr, type Settings } from "../shared/types";
import { ago } from "../shared/format";
import { SetRow } from "./SetRow";
import { Toggle } from "./Toggle";
import { settled } from "./settled";

/**
 * Settings → Notifications → Phone alerts: the settings on the left, and on
 * the right the conversation they make — the alert exactly as it's sent
 * (alertText), and, with replies on, a reply and what it does. Replies need
 * Full Disk Access, so turning them on first says what that lets Mockingbird
 * read, and asks.
 */

const SAMPLE: Omit<AlertItem, "code"> = { kind: "permission", title: "Donor export", where: "#5110", tool: "Bash" };

function PhonePreview({ p, code, waitingOnAccess }: { p: PhoneAlertSettings; code: string | null; waitingOnAccess: boolean }) {
  const alert = alertText([{ ...SAMPLE, code }]);
  return (
    <div className="phone-preview" aria-label="What a phone alert looks like">
      <div className="phone-to">To {normalizeHandle(p.handle) ?? "you"} · iMessage</div>
      <div className="bubble out">{alert}</div>
      {code ? (
        <>
          <div className="bubble in">{code} 1</div>
          <div className="phone-what">Allows that one prompt once, if it's still the one the alert was about. {code} 2 denies it. {code} and a message, to a finished session, types it into its prompt.</div>
          <div className="bubble out">Mockingbird: done — allow once in “Donor export”.</div>
        </>
      ) : (
        <div className="phone-what">{waitingOnAccess ? "Until Mockingbird can read Messages, alerts only tell you; you answer at your Mac." : "With replies off, alerts only tell you; you answer at your Mac."}</div>
      )}
    </div>
  );
}

function statusLine(st: PhoneStatus | null): string {
  if (!st) return "";
  const where = st.away.away ? `You're away (${st.away.why === "locked" ? "screen locked" : st.away.why === "manual" ? "you said so" : `idle ${Math.round(st.away.idleSeconds / 60)} min`})` : "You're at your Mac";
  return `${where}: alerts ${st.away.away ? "go now" : "wait until you're away"}.`;
}

export function PhoneAlertsSection({ settings, onChange }: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const p = phoneSettings(settings.phoneAlerts);
  const set = (patch: Partial<PhoneAlertSettings>) => onChange({ phoneAlerts: { ...p, ...patch } });
  const [st, setSt] = useState<PhoneStatus | null>(null);
  const [stErr, setStErr] = useState("");
  const [handle, setHandle] = useState(p.handle);
  // the field follows the saved handle when that changes, but not on mount: a mount effect runs after the first frame
  // and would put the saved handle back over anything typed before it ran
  const [shown, setShown] = useState(p.handle);
  if (shown !== p.handle) {
    setShown(p.handle);
    setHandle(p.handle);
  }
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [askFda, setAskFda] = useState(false);

  const load = () =>
    void settled<PhoneStatus | { error: string }>(window.mb.phoneStatus()).then((r) => {
      if (isErr(r)) return setStErr(`Couldn't read phone alerts' status: ${r.error}`);
      setStErr("");
      setSt(r);
    });
  useEffect(() => {
    load();
    const off = window.mb.onPhoneChanged((s: PhoneStatus) => setSt(s));
    const t = setInterval(load, 30_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const normalized = normalizeHandle(handle);
  const commitHandle = () => {
    if (handle.trim() === p.handle) return;
    if (handle.trim() && !normalized) return; // said beside the field; nothing saved
    set({ handle: normalized ?? "" });
  };
  const test = async () => {
    setTesting(true);
    const r = await settled<{ detail: string } | { error: string }>(window.mb.phoneTest());
    setTesting(false);
    setTestNote(isErr(r) ? { ok: false, msg: r.error } : { ok: true, msg: r.detail });
    load();
  };
  const checkAgain = async () => {
    const r = await settled(window.mb.phoneCheckReplies());
    if (isErr(r)) setStErr(`Couldn't check: ${r.error}`);
    load();
  };
  const privacy = (which: "automation" | "fullDiskAccess") =>
    void settled(window.mb.phoneOpenPrivacy(which)).then((r) => isErr(r) && setStErr(`Couldn't open System Settings: ${r.error}`));

  const replies = st?.replies;
  // an alert carries a code only once Messages can be read
  const code = p.replies && replies?.state === "ok" ? "K4" : null;
  const lastSend = st?.last;
  // the test just tried, or else the last alert, when it wasn't sent
  const sendProblem = testNote ? (testNote.ok ? null : testNote.msg) : lastSend && !lastSend.ok ? `The ${lastSend.test ? "test" : "alert"} ${ago(lastSend.at)} wasn't sent: ${lastSend.detail}` : null;

  return (
    <>
      <div className="set-sub">Phone alerts</div>
      <p className="set-lede">
        An iMessage to yourself when a session waits on you — a permission prompt or a question — or finishes, while you're away from this Mac. It names the session, its ticket or group, and what it waits on; never what the agent wrote, a command, or a file.
      </p>
      <div className="phone-grid">
        <div className="phone-rows">
          <SetRow title="Phone alerts" note={st ? statusLine(st) : undefined}>
            <Toggle label="Phone alerts" on={p.enabled} disabled={!p.enabled && !normalizeHandle(p.handle)} title={!p.enabled && !normalizeHandle(p.handle) ? "Enter your iMessage handle first" : undefined} onChange={(v) => set({ enabled: v })} />
          </SetRow>
          <SetRow title="Your iMessage" note={handle.trim() && !normalized ? <span className="phone-bad">{HANDLE_HINT}</span> : "Alerts go to you, as a conversation with yourself"}>
            <input
              type="text"
              className="phone-handle"
              placeholder="you@icloud.com or +15551234567"
              value={handle}
              spellCheck={false}
              aria-invalid={!!handle.trim() && !normalized}
              onChange={(e) => setHandle(e.target.value)}
              onBlur={commitHandle}
              onKeyDown={(e) => e.key === "Enter" && commitHandle()}
            />
          </SetRow>
          <SetRow title="Away after" note="No keyboard or mouse for this long, or the screen locked">
            <span className="seg">
              {IDLE_MINUTES_CHOICES.map((m) => (
                <button key={m} className={p.idleMinutes === m ? "on" : ""} aria-pressed={p.idleMinutes === m} onClick={() => set({ idleMinutes: m })}>
                  {m} min
                </button>
              ))}
            </span>
          </SetRow>
          <SetRow title="When a session finishes" note="Off: only sessions waiting on you. Quiet hours and muted sessions apply here too.">
            <Toggle label="Phone alert when a session finishes" on={p.finished} onChange={(v) => set({ finished: v })} />
          </SetRow>
          <SetRow
            title="Send test alert"
            note={
              testNote?.ok ? (
                <span className="phone-ok">{testNote.msg}</span>
              ) : sendProblem ? (
                "Not sent — see below"
              ) : lastSend ? (
                `Last ${lastSend.test ? "test" : "alert"} sent ${ago(lastSend.at)}`
              ) : (
                "macOS asks once whether Mockingbird may control Messages"
              )
            }
          >
            <button className="outline" disabled={testing || !normalizeHandle(p.handle)} data-tip={!normalizeHandle(p.handle) ? "Enter your iMessage handle first" : undefined} onClick={test}>
              {testing ? "Sending…" : "Send test alert"}
            </button>
          </SetRow>
          {sendProblem && (
            <div className="phone-problem" role="alert">
              <span>{sendProblem}</span>
              {/Automation/.test(sendProblem) && (
                <button className="outline" onClick={() => privacy("automation")}>Open Automation settings</button>
              )}
            </div>
          )}

          <SetRow
            title="Replies from your phone"
            note={
              !p.replies
                ? "Answer from your phone: allow once, deny, or a short message to a finished session. Needs Full Disk Access."
                : replies?.state === "ok"
                  ? `Reading your conversation with yourself while an alert waits for a reply${st?.open ? ` (${st.open} now)` : ""}. Turn this off to stop; you can then remove Full Disk Access.`
                  : replies?.state === "no-access" || replies?.state === "error"
                    ? "Can't read Messages — see below"
                    : replies?.state === "dev"
                      ? replies.detail
                      : "Checking whether Messages can be read…"
            }
          >
            <Toggle
              label="Replies from your phone"
              on={p.replies}
              disabled={!p.enabled}
              title={!p.enabled ? "Turn phone alerts on first" : undefined}
              onChange={(v) => (v ? setAskFda(true) : set({ replies: false }))}
            />
          </SetRow>
          {p.replies && (replies?.state === "no-access" || replies?.state === "error") && (
            <div className="phone-problem" role="alert">
              <span>{replies.detail}</span>
              <button className="outline" onClick={() => privacy("fullDiskAccess")}>Open Full Disk Access</button>
              <button className="outline" onClick={checkAgain}>Check again</button>
            </div>
          )}
          {askFda && !p.replies && (
            <div className="phone-fda" role="dialog" aria-label="Replies need Full Disk Access">
              <div className="phone-fda-title">Replies need Full Disk Access</div>
              <p>
                macOS keeps Messages' history in one database, and lets an app read it only with Full Disk Access — there's no narrower permission, and no other way to see a reply. Full Disk Access lets Mockingbird read <b>every file on this Mac</b>, all your Messages conversations and Mail included — <b>and so can everything it runs</b>: the agents, terminals and commands in its panes. An unsigned build may need it granted again after each update; Settings says when.
              </p>
              <p>
                Mockingbird reads only your conversation with yourself, only while an alert is waiting for a reply, and only messages after that alert that start with its code. A reply can allow or deny that one prompt once, or type a short message into that one session; never "always allow", never a shell command. Each reply is in Settings → Team → Recent remote activity.
              </p>
              <div className="row">
                <button className="outline" onClick={() => setAskFda(false)}>Not now</button>
                <button
                  className="primary"
                  onClick={() => {
                    setAskFda(false);
                    set({ replies: true });
                    privacy("fullDiskAccess");
                  }}
                >
                  Turn on and open Full Disk Access
                </button>
              </div>
            </div>
          )}
          {stErr && <div className="err">{stErr}</div>}
        </div>
        <PhonePreview p={p} code={code} waitingOnAccess={p.replies && !code} />
      </div>
    </>
  );
}
