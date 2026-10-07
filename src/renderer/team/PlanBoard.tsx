import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import { Select } from "../Menu";
import { useAction } from "../useAction";
import { initialsOf } from "../Team";
import { ago, plural } from "../../shared/format";
import { isErr } from "../../shared/types";
import {
  describeChange,
  memberName,
  PACKAGE_STATUSES,
  STATUS_LABEL,
  type PackageStatus,
  type PlanOp,
  type PlanRepoChoice,
  type PlanView,
  type PlanWarningNotice,
  type WorkPackage,
} from "../../shared/team/plan";

/**
 * The plan board of a shared room (docs/team-rooms.md, "Plan and claims
 * board"): work packages by status, who has each and what it owns, the
 * board's place in git, teammates' pushed branches, and who changed what.
 * Every change is a room event, so it shows on every member's board at once.
 */

/** A room's board, kept current; an { error } when it couldn't be read. */
function usePlanView(roomId: string): PlanView | { error: string } | null {
  const [view, setView] = useState<PlanView | { error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    window.mb.planGet(roomId).then((v: PlanView | { error: string }) => {
      if (!alive) return;
      if (isErr(v)) console.error(`[mockingbird] couldn't read room ${roomId}'s plan:`, v.error);
      setView(v);
    });
    const off = window.mb.onPlanChanged((v: PlanView) => {
      if (v?.roomId === roomId) setView(v);
    });
    return () => {
      alive = false;
      off();
    };
  }, [roomId]);
  return view;
}

const ACTIVE: PackageStatus[] = ["claimed", "in-progress", "blocked"];
const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

type Draft = { id: string | null; title: string; description: string; paths: string; provides: string; uses: string; tests: string };
const blank: Draft = { id: null, title: "", description: "", paths: "", provides: "", uses: "", tests: "" };
const draftOf = (p: WorkPackage): Draft => ({ id: p.id, title: p.title, description: p.description, paths: p.paths.join("\n"), provides: p.provides, uses: p.uses, tests: p.tests });

/** Create or edit a package: what it owns, provides, uses, and how it's tested. */
function PackageForm({ draft, busy, onSave, onCancel }: { draft: Draft; busy: boolean; onSave: (d: Draft) => void; onCancel: () => void }) {
  const [d, setD] = useState(draft);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <div className="plan-form">
      <div className="plan-form-grid">
        <div>
          <label>Title</label>
          <input type="text" autoFocus value={d.title} onChange={set("title")} placeholder="Donor API" />
          <label>Owns — folders, files or globs, one a line</label>
          <textarea className="plan-ta" value={d.paths} onChange={set("paths")} placeholder={"src/api/donor/\nsrc/shared/donor.ts\n**/*.donor.test.ts"} />
          <label>Description</label>
          <textarea className="plan-ta" value={d.description} onChange={set("description")} placeholder="What this package delivers" />
        </div>
        <div>
          <label>Provides — contracts others rely on</label>
          <textarea className="plan-ta" value={d.provides} onChange={set("provides")} placeholder="GET /api/donors/:id → DonorDto (src/shared/donor.ts)" />
          <label>Uses</label>
          <textarea className="plan-ta" value={d.uses} onChange={set("uses")} placeholder="The org lookup from Org UI" />
          <label>Tested by</label>
          <textarea className="plan-ta" value={d.tests} onChange={set("tests")} placeholder="pytest tests/api/test_donor.py" />
        </div>
      </div>
      <div className="row">
        <button className="outline" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={busy || !d.title.trim()} onClick={() => onSave(d)}>
          {d.id ? "Save changes" : "Add package"}
        </button>
      </div>
    </div>
  );
}

function PackageCard({ p, view, act, onEdit }: { p: WorkPackage; view: PlanView; act: (what: string, op: PlanOp) => void; onEdit: () => void }) {
  const [blocking, setBlocking] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const owner = p.owner ? view.members.find((m) => m.id === p.owner) : undefined;
  const mine = p.owner === view.self;
  const status = (s: PackageStatus, note?: string) => act(`status:${p.id}`, { kind: "status", id: p.id, status: s, ...(note ? { note } : {}) });
  const contract = (label: string, text: string) =>
    text.trim() && (
      <div className="plan-contract" title={text}>
        <span className="plan-k">{label}</span> {text.trim()}
      </div>
    );
  return (
    <div className={`plan-card st-${p.status} ${mine ? "mine" : ""}`}>
      <div className="plan-card-h">
        <span className="plan-title" title={p.description || p.title}>
          {p.title}
        </span>
        {p.owner && (
          <span className={`plan-owner ${mine ? "mine" : ""}`} title={`${memberName(view.members, p.owner)}${mine ? " (you)" : ""}${owner?.online ? " · connected" : ""}`}>
            {initialsOf(memberName(view.members, p.owner))}
          </span>
        )}
      </div>
      {p.paths.length > 0 && (
        <div className="plan-paths">
          {p.paths.map((x) => (
            <span key={x} className="chip" title={x}>
              {x}
            </span>
          ))}
        </div>
      )}
      {p.statusNote && <div className={`plan-note ${p.status === "blocked" ? "warn" : ""}`}>{p.statusNote}</div>}
      {contract("provides", p.provides)}
      {contract("uses", p.uses)}
      {contract("tests", p.tests)}
      {blocking !== null ? (
        <div className="plan-block">
          <input type="text" autoFocus value={blocking} placeholder="Blocked on…" onChange={(e) => setBlocking(e.target.value)} onKeyDown={(e) => e.key === "Enter" && blocking.trim() && (status("blocked", blocking.trim()), setBlocking(null))} />
          <button className="link" disabled={!blocking.trim()} onClick={() => (status("blocked", blocking.trim()), setBlocking(null))}>
            Mark blocked
          </button>
          <button className="link" onClick={() => setBlocking(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="plan-acts">
          {p.status === "open" && (
            <button className="link" onClick={() => act(`claim:${p.id}`, { kind: "claim", id: p.id })}>
              Claim
            </button>
          )}
          {p.status === "claimed" && (
            <button className="link" onClick={() => status("in-progress")}>
              Start
            </button>
          )}
          {p.status === "in-progress" && (
            <button className="link" onClick={() => setBlocking("")}>
              Blocked…
            </button>
          )}
          {p.status === "blocked" && (
            <button className="link" onClick={() => status("in-progress")}>
              Unblock
            </button>
          )}
          {ACTIVE.includes(p.status) && (
            <button className="link" onClick={() => status("done")}>
              Done
            </button>
          )}
          {p.status === "done" && (
            <button className="link" onClick={() => status(p.owner ? "claimed" : "open")}>
              Reopen
            </button>
          )}
          {p.owner && p.status !== "done" && (
            <button className="link" title={mine ? "Give it back to the board" : `Take it off ${memberName(view.members, p.owner)}`} onClick={() => act(`release:${p.id}`, { kind: "release", id: p.id })}>
              Release
            </button>
          )}
          <span className="plan-acts-r">
            <button className="link" onClick={onEdit}>
              Edit
            </button>
            {removing ? (
              <button className="link danger" onClick={() => act(`remove:${p.id}`, { kind: "remove", id: p.id })} onBlur={() => setRemoving(false)} autoFocus>
                Remove it
              </button>
            ) : (
              <button className="link" title="Remove the package from the board" onClick={() => setRemoving(true)}>
                ✕
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

/** Where the board is in git: the repo it's kept in, the last commit, the worktrees with a copy — or choosing the repo. */
function GitLine({ view, act }: { view: PlanView; act: (what: string, op: PlanOp) => void }) {
  const g = view.git;
  const [choices, setChoices] = useState<PlanRepoChoice[] | { error: string } | null>(null);
  const [pick, setPick] = useState("");
  useEffect(() => {
    if (g.state !== "unbound") return;
    window.mb.planRepos(view.roomId).then((r: PlanRepoChoice[] | { error: string }) => {
      setChoices(r);
      if (!isErr(r) && r[0]) setPick((cur) => cur || r[0].path);
    });
  }, [g.state, view.roomId]);
  if (g.state === "unbound") {
    const list = choices && !isErr(choices) ? choices : [];
    const chosen = list.find((c) => c.path === pick);
    return (
      <div className="plan-git unbound">
        <span>Not in git yet. The board lives on its own branch, mockingbird/plan, in the room's repo:</span>
        {choices && isErr(choices) && <span className="err-inline">{choices.error}</span>}
        {choices && !isErr(choices) && !list.length && <span className="plan-dim">no clone with an origin found — add your repo folders in Settings</span>}
        {list.length > 0 && (
          <>
            <Select
              className="plan-repo-pick"
              value={pick}
              onChange={setPick}
              options={list.map((c) => ({ value: c.path, label: c.name, description: `${c.origin}${c.inRoom ? " · used by this room's sessions" : ""}` }))}
            />
            <button className="primary" disabled={!chosen} onClick={() => chosen && act("repo", { kind: "repo", origin: chosen.origin, name: chosen.name })}>
              Keep the plan here
            </button>
          </>
        )}
      </div>
    );
  }
  const where = `${g.repo!.name} · mockingbird/plan`;
  const copies = g.copies ? ` · read-only copy in ${plural(g.copies, "worktree")}` : "";
  if (g.state === "error" || g.state === "no-clone") {
    return (
      <div className="plan-git bad" title={g.problem}>
        <span>{where}</span>
        <span className="plan-problem">{g.problem}</span>
      </div>
    );
  }
  return (
    <div className={`plan-git ${g.copiesProblem ? "bad" : ""}`}>
      <span>{where}</span>
      <span className="plan-dim">
        {g.state === "syncing" ? "committing…" : g.state === "pending" ? "waiting to commit" : g.commit ? `${g.commit.pushed ? "pushed" : "committed"} ${ago(g.commit.at)} · ${g.commit.sha.slice(0, 7)}` : "up to date"}
        {copies}
      </span>
      {g.copiesProblem && <span className="plan-problem">{g.copiesProblem}</span>}
    </div>
  );
}

export function PlanBoardDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const view = usePlanView(roomId);
  const { run, busy, doing, error } = useAction();
  const [draft, setDraft] = useState<Draft | null>(null);
  const act = (what: string, op: PlanOp) => void run(what, () => window.mb.planApply(roomId, op));
  const save = async (d: Draft) => {
    const fields = { title: d.title.trim(), description: d.description, paths: lines(d.paths), provides: d.provides, uses: d.uses, tests: d.tests };
    const r = await run("save", () => window.mb.planApply(roomId, d.id ? { kind: "edit", id: d.id, ...fields } : { kind: "create", ...fields }));
    if (!isErr(r)) setDraft(null);
  };
  if (!view || isErr(view)) {
    return (
      <Modal className="modal plan-modal" onClose={onClose}>
        <h3>Plan</h3>
        {view ? <div className="err">Couldn't read the plan: {view.error}</div> : <div className="hint">Reading the plan…</div>}
        <div className="row">
          <button className="outline" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }
  const { plan } = view;
  const name = (id: string) => memberName(view.members, id);
  return (
    <Modal className="modal plan-modal" onClose={onClose} closeOnBackdrop={!draft}>
      <div className="plan-head">
        <h3>Plan — {view.room}</h3>
        <span className="plan-members">
          {view.members.map((m) => (
            <span key={m.id} className={`plan-member ${m.self || m.online ? "on" : ""}`} title={`${m.name}${m.self ? " (you)" : m.online ? " · connected" : " · offline"}`}>
              {initialsOf(m.name)}
            </span>
          ))}
        </span>
        <button className="outline" disabled={!!draft} onClick={() => setDraft(blank)}>
          New package
        </button>
      </div>
      <div className="sub-h">Claim a package before your agents work on its paths: an agent editing a file a teammate's package owns is held back once and warned, and so are you. Agents change the board with the update_team_plan tool.</div>
      <GitLine view={view} act={act} />
      {draft && <PackageForm key={draft.id ?? "new"} draft={draft} busy={doing("save")} onSave={save} onCancel={() => setDraft(null)} />}
      {error && <div className="fp-note err">{error}</div>}
      <div className="plan-cols">
        {PACKAGE_STATUSES.map((st) => {
          const list = plan.packages.filter((p) => p.status === st);
          return (
            <div key={st} className={`plan-col st-${st}`}>
              <div className="plan-col-h">
                {STATUS_LABEL[st]} <span className="plan-cnt">{list.length}</span>
              </div>
              {list.map((p) => (
                <PackageCard key={p.id} p={p} view={view} act={act} onEdit={() => setDraft(draftOf(p))} />
              ))}
              {!list.length && st === "open" && !plan.packages.length && <div className="plan-empty">No packages yet. Split the work: what each part owns, provides and uses.</div>}
            </div>
          );
        })}
      </div>
      <div className="plan-foot">
        <div className="plan-side">
          <div className="plan-side-h">Recent changes</div>
          {!plan.changes.length && <div className="plan-dim">Nothing yet.</div>}
          {[...plan.changes]
            .reverse()
            .slice(0, 12)
            .map((c, i) => (
              <div key={`${c.at}-${i}`} className="plan-change">
                <span className="plan-when">{ago(c.at)}</span> {describeChange(c, name)}
              </div>
            ))}
        </div>
        <div className="plan-side">
          <div className="plan-side-h">Teammates' pushed branches</div>
          {view.fetchProblem && <div className="plan-problem">Fetching failed: {view.fetchProblem}</div>}
          {!view.teammates.length && <div className="plan-dim">{plan.repo ? "None announced yet." : "Shown once the plan has a repo."}</div>}
          {view.teammates.map((t) => (
            <div key={`${t.member}:${t.branch}`} className="plan-change" title={t.problem ?? t.files.join("\n")}>
              <b>{t.name}</b> {t.branch} <span className="plan-dim">· {t.problem ?? plural(t.files.length, "file")}</span>
            </div>
          ))}
          {view.fetchedAt > 0 && <div className="plan-dim">fetched {ago(view.fetchedAt)}</div>}
        </div>
      </div>
      <div className="row">
        {busy && <span className="foot-hint plan-dim">Saving…</span>}
        <button className="outline" disabled={doing("sync")} title="Commit and push the board now, refresh the worktree copies, and fetch teammates' branches" onClick={() => void run("sync", () => window.mb.planSync(roomId))}>
          {doing("sync") ? "Syncing…" : "Sync now"}
        </button>
        <button className="outline" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

const NOTICE_MS = 15_000;

/** Claim warnings as they happen: which agent touched which teammate's package. Click one to go to its session. */
export function PlanWarnings({ onJump, onOpenBoard }: { onJump: (sessionId: string) => void; onOpenBoard: (roomId: string) => void }) {
  const [notices, setNotices] = useState<(PlanWarningNotice & { key: number })[]>([]);
  useEffect(
    () =>
      window.mb.onPlanWarning((n: PlanWarningNotice) => {
        const key = Date.now() + Math.random();
        setNotices((list) => [...list.slice(-2), { ...n, key }]);
        setTimeout(() => setNotices((list) => list.filter((x) => x.key !== key)), NOTICE_MS);
      }),
    []
  );
  if (!notices.length) return null;
  return (
    <div className="plan-toasts" role="status">
      {notices.map((n) => {
        const c = n.conflicts[0];
        const hit = c?.hits[0];
        const what =
          n.decision === "failed"
            ? `The team plan's claims check failed in ${n.sessionTitle}'s hook; its edit went ahead unchecked. ${n.error ?? ""}`
            : `${n.sessionTitle} ${n.decision === "deny" ? "tried to edit" : "edited"} ${c?.file}${n.conflicts.length > 1 ? ` and ${plural(n.conflicts.length - 1, "more file")}` : ""} — ${hit?.owner.name}'s package "${hit?.title}". ${n.decision === "deny" ? "The agent was held back once; it can repeat the edit." : "It went ahead after the warning."}`;
        return (
          <div key={n.key} className={`plan-toast ${n.decision}`}>
            <button className="plan-toast-body" title={n.sessionId ? "Go to the session" : undefined} onClick={() => n.sessionId && onJump(n.sessionId)}>
              {what}
            </button>
            {hit && (
              <button className="link" onClick={() => onOpenBoard(hit.roomId)}>
                Plan
              </button>
            )}
            <button className="icon" title="Dismiss" onClick={() => setNotices((list) => list.filter((x) => x.key !== n.key))}>
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
